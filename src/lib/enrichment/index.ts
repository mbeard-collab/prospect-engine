import "server-only";
import {
  createAnthropicCompetitorProvider,
  createNullCompetitorProvider,
} from "./competitors";
import { createCompanyWebsiteContactsProvider } from "./company-website-contacts";
import { createGovspendContractsContactsProvider } from "./govspend-contracts-contacts";
import { createLinkedinContactsProvider } from "./linkedin-contacts";
import { createMockContactProvider, createMockSignalProvider } from "./mock";
import { createSparkMcpProvider } from "./spark-mcp";
import { createZoomInfoMcpProvider } from "./zoominfo-mcp";
import { createZoomInfoRestProvider } from "./zoominfo-rest";
import type {
  CompetitorProvider,
  ContactProvider,
  ContactTier,
  EnrichedContact,
  SignalProvider,
} from "./types";

// ───────────────────────────────────────────────────────────────────────────
// Contact aggregator
// ───────────────────────────────────────────────────────────────────────────
//
// The previous model was a fallback CHAIN: try ZoomInfo, if empty try the
// generic Anthropic web_search, if empty try Brave, stop on first hit. Good
// for one-good-contact use cases, bad as "the new SDR" — a real SDR doing
// research doesn't stop at ZoomInfo even when ZoomInfo answers, because each
// source surfaces different titles and provenance.
//
// The new model is parallel AGGREGATION across four discrete providers, then
// a Claude dedup pass to merge duplicates (Joe / Joseph / J. Smith), then a
// tier-flex picker that prefers one exec + one manager + one IC but falls
// back to fill empty tiers with strongest leftover candidates rather than
// returning fewer than 3 contacts.

const ANTHROPIC_ENDPOINT = "https://api.anthropic.com/v1/messages";
const DEDUP_MODEL = "claude-sonnet-4-6";
const DEDUP_MAX_TOKENS = 1500;

function aggregateContactProviders(
  providers: ContactProvider[],
  anthropicKey: string | null,
): ContactProvider {
  return {
    name: providers.map((p) => p.name).join(" + "),
    async fetchContacts(input) {
      // 1. Fan out all providers in parallel. Use Promise.allSettled so one
      //    provider's network error / Spark timeout / web_search rate limit
      //    doesn't kill the whole enrichment — partial results are useful.
      const settled = await Promise.allSettled(
        providers.map((p) => p.fetchContacts(input)),
      );

      const all: EnrichedContact[] = [];
      settled.forEach((r, i) => {
        if (r.status === "fulfilled") {
          all.push(...r.value);
        } else {
          console.error(
            `Contact provider "${providers[i].name}" failed for ${input.companyName}:`,
            r.reason,
          );
        }
      });

      if (all.length === 0) return [];

      // 2. Dedup. Claude-based merge catches cross-source variants like
      //    Joe / Joseph / J. Smith, but it's only useful when 2+ providers
      //    actually contributed. Single-source results can't have cross-
      //    source duplicates by definition, so we skip the Claude call and
      //    let naive group-by-(tier,initial,last) handle any intra-source
      //    repeats. Saves a 10-30 sec network call per company when only
      //    ZoomInfo or only LinkedIn returned anything.
      const uniqueSources = new Set(all.flatMap((c) => c.sources));
      const needsClaudeDedup =
        all.length >= 2 && uniqueSources.size > 1 && !!anthropicKey;

      let deduped: EnrichedContact[];
      if (needsClaudeDedup) {
        try {
          deduped = await claudeMergeContacts(all, anthropicKey);
        } catch (e) {
          console.warn(
            `Contact dedup failed for ${input.companyName}, falling back to naive merge:`,
            e,
          );
          deduped = naiveMergeContacts(all);
        }
      } else {
        deduped = naiveMergeContacts(all);
      }

      // 3. Tier-flex picker — try to cover exec/manager/IC, fill remaining
      //    slots with strongest leftover candidates.
      return pickTopThree(deduped);
    },
  };
}

// Pick up to 3 contacts: try one exec + one manager + one IC first, then if
// any tier is empty fill the remaining slots with the strongest unused
// candidates from any tier. "Strongest" = more sources first, then having an
// email, then having a LinkedIn URL.
function pickTopThree(contacts: EnrichedContact[]): EnrichedContact[] {
  if (contacts.length <= 3) return contacts;
  const sorted = [...contacts].sort(strengthDesc);
  const TIERS: ContactTier[] = ["exec", "manager", "ic"];
  const picks: EnrichedContact[] = [];
  const used = new Set<EnrichedContact>();

  // First pass: one per tier in priority order.
  for (const tier of TIERS) {
    const best = sorted.find((c) => c.tier === tier && !used.has(c));
    if (best) {
      picks.push(best);
      used.add(best);
    }
  }
  // Second pass: fill remaining slots with strongest unused.
  for (const c of sorted) {
    if (picks.length >= 3) break;
    if (used.has(c)) continue;
    picks.push(c);
    used.add(c);
  }
  return picks;
}

function strengthDesc(a: EnrichedContact, b: EnrichedContact): number {
  // More sources beats fewer — multi-source contacts are corroborated.
  if (a.sources.length !== b.sources.length) {
    return b.sources.length - a.sources.length;
  }
  // Having an email beats not having one.
  const aEmail = a.email ? 1 : 0;
  const bEmail = b.email ? 1 : 0;
  if (aEmail !== bEmail) return bEmail - aEmail;
  // Having a LinkedIn URL beats not having one.
  const aLi = a.linkedin ? 1 : 0;
  const bLi = b.linkedin ? 1 : 0;
  if (aLi !== bLi) return bLi - aLi;
  return 0;
}

// Fallback merger: group candidates by tier + a normalized name key (lowercase
// first initial + lowercase last). Misses some nicknames (Joe/Joseph collapse
// when both share initial J and last name) but won't catch things like
// J. Smith → Smith. Good enough as a fallback when Claude is unavailable.
function naiveMergeContacts(all: EnrichedContact[]): EnrichedContact[] {
  const buckets = new Map<string, EnrichedContact[]>();
  for (const c of all) {
    const key = naiveKey(c);
    const arr = buckets.get(key) ?? [];
    arr.push(c);
    buckets.set(key, arr);
  }
  const out: EnrichedContact[] = [];
  for (const group of buckets.values()) {
    if (group.length === 1) {
      out.push(group[0]);
    } else {
      out.push(mergeGroup(group));
    }
  }
  return out;
}

function naiveKey(c: EnrichedContact): string {
  const parts = c.name.trim().toLowerCase().split(/\s+/);
  const first = parts[0] ?? "";
  const last = parts[parts.length - 1] ?? "";
  // Use first initial + last name to collapse Joe/Joseph/J. Smith → "j:smith".
  const firstInitial = first.charAt(0);
  return `${c.tier}:${firstInitial}:${last}`;
}

function mergeGroup(group: EnrichedContact[]): EnrichedContact {
  // Prefer the entry with the longest name (likely the most complete form),
  // then union everything else.
  const sortedByNameLen = [...group].sort(
    (a, b) => b.name.length - a.name.length,
  );
  const primary = sortedByNameLen[0];
  return {
    name: primary.name,
    title: pickLongest(group.map((c) => c.title)) ?? primary.title,
    tier: primary.tier,
    email: group.find((c) => c.email)?.email ?? null,
    linkedin: group.find((c) => c.linkedin)?.linkedin ?? null,
    rationale: group
      .map((c) => c.rationale)
      .filter((r): r is string => !!r)
      .join(" / ") || null,
    sources: Array.from(new Set(group.flatMap((c) => c.sources))),
  };
}

function pickLongest(strs: string[]): string | null {
  let best: string | null = null;
  for (const s of strs) {
    if (s && (!best || s.length > best.length)) best = s;
  }
  return best;
}

// Claude-based dedup: send all candidates with their indices, get back groups
// of indices that are the same person. We then merge each group ourselves so
// the model only has to do the hard "is Joe Smith the same as Joseph Smith?"
// reasoning, not the field-by-field merge.
const DEDUP_SYSTEM_PROMPT = `You are merging duplicate contact records from multiple SDR research sources (ZoomInfo, LinkedIn, company website, contract records). Each input record has an index. Some records describe the SAME real person under different name formats (Joe / Joseph / J.), nickname variants, or with slightly different titles from different sources.

YOUR JOB: group the input records by REAL PERSON. Each group is a list of indices that refer to the same human. Records that don't dupe anything else are groups of one.

RULES:
- Two records describe the same person ONLY if name + tier + (optionally) title agree. "Joe Smith, VP Sales (exec)" and "Joseph Smith, Vice President Sales (exec)" → same. "Joe Smith, VP Sales (exec)" and "Joe Smith, Account Executive (ic)" → almost certainly different people at the same company; do NOT merge.
- Different last names = different people. Don't merge.
- When in doubt, do NOT merge. False merges are worse than false splits (the SDR sees an extra row, not a wrong identity).

OUTPUT: ONLY this JSON, no prose. Every input index must appear in exactly one group:
{
  "groups": [
    { "indices": [0, 4] },
    { "indices": [1] },
    { "indices": [2, 3] }
  ]
}`;

type DedupGroup = { indices: number[] };

async function claudeMergeContacts(
  all: EnrichedContact[],
  anthropicKey: string,
): Promise<EnrichedContact[]> {
  const userLines: string[] = [
    `Merge these ${all.length} candidate contacts. Output groups of indices.`,
    "",
  ];
  all.forEach((c, i) => {
    userLines.push(
      `${i}. [${c.tier}] ${c.name} — ${c.title} (sources: ${c.sources.join(", ")})`,
    );
  });
  const body = {
    model: DEDUP_MODEL,
    max_tokens: DEDUP_MAX_TOKENS,
    system: DEDUP_SYSTEM_PROMPT,
    messages: [{ role: "user", content: userLines.join("\n") }],
  };
  const res = await fetch(ANTHROPIC_ENDPOINT, {
    method: "POST",
    headers: {
      "x-api-key": anthropicKey,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Dedup HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  const data = JSON.parse(text) as {
    content?: Array<{ type: "text"; text: string } | { type: string }>;
  };
  const outText = (data.content ?? [])
    .map((b) => (b.type === "text" ? (b as { text: string }).text : ""))
    .join("")
    .trim();

  const cleaned = outText
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("Dedup: no JSON in response");
  const obj = JSON.parse(match[0]) as { groups?: unknown };
  if (!Array.isArray(obj.groups)) throw new Error("Dedup: groups missing");

  const groups: DedupGroup[] = obj.groups
    .map((g) => g as Record<string, unknown>)
    .filter(
      (g): g is { indices: number[] } =>
        Array.isArray(g.indices) &&
        (g.indices as unknown[]).every((i) => Number.isInteger(i)),
    );

  // Belt-and-suspenders: assert every input index appears in at least one
  // group. If the model dropped some indices, treat them as singletons.
  const seen = new Set<number>();
  for (const g of groups) for (const i of g.indices) seen.add(i);
  const missing = all.map((_, i) => i).filter((i) => !seen.has(i));
  if (missing.length > 0) {
    for (const i of missing) groups.push({ indices: [i] });
  }

  return groups.map((g) => {
    const members = g.indices
      .filter((i) => i >= 0 && i < all.length)
      .map((i) => all[i]);
    return members.length === 1 ? members[0] : mergeGroup(members);
  });
}

export type {
  CompetitorProvider,
  ContactProvider,
  ContactTier,
  EnrichedCompetitors,
  EnrichedContact,
  EnrichedSignal,
  SignalProvider,
  SignalType,
} from "./types";

// ───────────────────────────────────────────────────────────────────────────
// Provider factories
// ───────────────────────────────────────────────────────────────────────────

let contactCached: ContactProvider | null = null;
let signalCached: SignalProvider | null = null;
let competitorCached: CompetitorProvider | null = null;

export function getContactProvider(): ContactProvider {
  if (contactCached) return contactCached;

  const privateKeyPem = process.env.ZOOMINFO_API_KEY?.trim();
  const username = process.env.ZOOMINFO_USERNAME?.trim();
  const clientId = process.env.ZOOMINFO_CLIENT_ID?.trim();
  const anthropicKey = process.env.PROSPECT_ANTHROPIC_KEY?.trim() ?? null;
  const sparkUrl = process.env.SPARK_MCP_URL?.trim();
  const sparkToken = process.env.SPARK_MCP_TOKEN?.trim();
  const ziMcpUrl = process.env.ZOOMINFO_MCP_URL?.trim();
  const ziMcpToken = process.env.ZOOMINFO_MCP_TOKEN?.trim();

  const providers: ContactProvider[] = [];

  // Source 1: ZoomInfo REST (structured, has emails).
  if (privateKeyPem && username && clientId && anthropicKey) {
    providers.push(
      createZoomInfoRestProvider({
        privateKeyPem,
        username,
        clientId,
        anthropicKey,
      }),
    );
  }

  // Source 2: company website (Anthropic web_search anchored to their domain).
  if (anthropicKey) {
    providers.push(createCompanyWebsiteContactsProvider({ anthropicKey }));
  }

  // Source 3: LinkedIn (Anthropic web_search anchored to linkedin.com/in).
  if (anthropicKey) {
    providers.push(createLinkedinContactsProvider({ anthropicKey }));
  }

  // Source 4: GovSpend contracts (Spark MCP, long-shot vendor names).
  if (sparkUrl && sparkToken && anthropicKey) {
    providers.push(
      createGovspendContractsContactsProvider({
        url: sparkUrl,
        token: sparkToken,
        anthropicKey,
      }),
    );
  }

  // Vestigial fallback: ZoomInfo MCP (OAuth). Skipped on most accounts —
  // gating on the env vars means this only fires when an account has it.
  if (ziMcpUrl && ziMcpToken && anthropicKey) {
    providers.push(
      createZoomInfoMcpProvider({
        url: ziMcpUrl,
        token: ziMcpToken,
        anthropicKey,
      }),
    );
  }

  contactCached =
    providers.length > 0
      ? aggregateContactProviders(providers, anthropicKey)
      : createMockContactProvider();
  return contactCached;
}

export function getCompetitorProvider(): CompetitorProvider {
  if (competitorCached) return competitorCached;
  const anthropicKey = process.env.PROSPECT_ANTHROPIC_KEY?.trim();
  if (anthropicKey) {
    competitorCached = createAnthropicCompetitorProvider({ anthropicKey });
  } else {
    competitorCached = createNullCompetitorProvider();
  }
  return competitorCached;
}

export function getSignalProvider(): SignalProvider {
  if (signalCached) return signalCached;
  const mcpUrl = process.env.SPARK_MCP_URL?.trim();
  const mcpToken = process.env.SPARK_MCP_TOKEN?.trim();
  const anthropicKey = process.env.PROSPECT_ANTHROPIC_KEY?.trim();
  if (mcpUrl && mcpToken && anthropicKey) {
    signalCached = createSparkMcpProvider({
      url: mcpUrl,
      token: mcpToken,
      anthropicKey,
    });
  } else {
    signalCached = createMockSignalProvider();
  }
  return signalCached;
}
