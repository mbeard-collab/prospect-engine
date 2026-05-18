import "server-only";
import { importPKCS8, SignJWT } from "jose";
import { cleanCompanyName } from "@/lib/prefilter";
import type { ContactProvider, ContactTier, EnrichedContact } from "./types";

// ZoomInfo Enterprise API integration. Three steps per prospect:
//   1. /search/contact — pull top 50 candidates at the company (no jobTitle/
//      jobFunction filter; defaults surface execs + sales-relevant titles).
//   2. Claude picker — hand the 50 candidates + company context to Sonnet,
//      let it pick the best exec/manager/IC for public-sector outreach.
//   3. /enrich/contact — fetch real email + phone for the 3 picked IDs.
//
// Auth: PKI JWT. Exact JWT shape from ZoomInfo's official Python client.
// Access token cached in-process for ~55 min.

const AUTH_URL = "https://api.zoominfo.com/authenticate";
const COMPANY_SEARCH_URL = "https://api.zoominfo.com/search/company";
const SEARCH_URL = "https://api.zoominfo.com/search/contact";
const ENRICH_URL = "https://api.zoominfo.com/enrich/contact";
const TOKEN_TTL_MS = 55 * 60 * 1000;
const SEARCH_RPP = 50;
const CLAUDE_PICKER_MODEL = "claude-sonnet-4-6";
const ANTHROPIC_ENDPOINT = "https://api.anthropic.com/v1/messages";

// ─────────────────────────────────────────────────────────────────────────
// JWT auth

function ensurePem(input: string): string {
  const trimmed = input.trim();
  if (trimmed.includes("BEGIN PRIVATE KEY")) return trimmed;
  const compact = trimmed.replace(/\s+/g, "");
  const lines: string[] = [];
  for (let i = 0; i < compact.length; i += 64) {
    lines.push(compact.slice(i, i + 64));
  }
  return [
    "-----BEGIN PRIVATE KEY-----",
    ...lines,
    "-----END PRIVATE KEY-----",
  ].join("\n");
}

async function signJwt(args: {
  privateKeyPem: string;
  username: string;
  clientId: string;
}): Promise<string> {
  const key = await importPKCS8(ensurePem(args.privateKeyPem), "RS256");
  const now = Math.floor(Date.now() / 1000);
  return await new SignJWT({
    client_id: args.clientId,
    username: args.username,
  })
    .setProtectedHeader({ alg: "RS256", typ: "JWT" })
    .setIssuedAt(now)
    .setExpirationTime(now + 300)
    .setAudience("enterprise_api")
    .setIssuer("api-client@zoominfo.com")
    .sign(key);
}

type CachedToken = { token: string; expiresAt: number };
let cachedToken: CachedToken | null = null;
// Single in-flight promise to dedupe concurrent /authenticate callers. With
// the Stage 3 aggregator now firing 4 providers × 3 companies in parallel, a
// cold start would otherwise trigger ~3 simultaneous /authenticate requests,
// which ZoomInfo's auth endpoint rate-limits (HTTP 429). Routing all
// concurrent callers through the same Promise means only one auth request
// goes out per cold start regardless of how many threads are waiting.
let inFlightToken: Promise<string> | null = null;

async function getAccessToken(args: {
  privateKeyPem: string;
  username: string;
  clientId: string;
}): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt) {
    return cachedToken.token;
  }
  if (inFlightToken) return inFlightToken;

  inFlightToken = (async () => {
    try {
      const jwt = await signJwt(args);
      const res = await fetch(AUTH_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${jwt}`, Accept: "application/json" },
      });
      const text = await res.text();
      if (!res.ok) {
        throw new Error(
          `ZoomInfo /authenticate HTTP ${res.status}: ${text.slice(0, 400)}`,
        );
      }
      const data = JSON.parse(text) as { jwt?: string };
      if (!data.jwt) {
        throw new Error(`ZoomInfo /authenticate: missing 'jwt' in response`);
      }
      cachedToken = { token: data.jwt, expiresAt: Date.now() + TOKEN_TTL_MS };
      return data.jwt;
    } finally {
      // Clear so failure isn't sticky and subsequent calls can retry. Success
      // doesn't matter — the cache now holds the token for ~55 min.
      inFlightToken = null;
    }
  })();

  return inFlightToken;
}

// ─────────────────────────────────────────────────────────────────────────
// Company lookup → exact companyId

type ZoomInfoCompanyHit = {
  id?: number | string;
  name?: string;
  website?: string | null;
};

// Fetch the raw company search results for a given filter combo.
async function searchCompany(args: {
  token: string;
  filters: { companyName?: string; companyWebsite?: string };
}): Promise<ZoomInfoCompanyHit[]> {
  const body: Record<string, unknown> = { ...args.filters, rpp: 10, page: 1 };
  const res = await fetch(COMPANY_SEARCH_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${args.token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    console.error(
      `ZoomInfo /search/company HTTP ${res.status} (${JSON.stringify(args.filters)}): ${text.slice(0, 300)}`,
    );
    return [];
  }
  const parsed = JSON.parse(text) as { data?: unknown };
  return Array.isArray(parsed.data) ? (parsed.data as ZoomInfoCompanyHit[]) : [];
}

// Pick the best hit from a result set. Prefer exact name match (cleaned +
// lowercased so "Beam Distributing Inc" == "Beam Distributing"). Fall back to
// first if no exact match.
function pickBestMatch(
  hits: ZoomInfoCompanyHit[],
  prospectName: string,
  allowFirstFallback: boolean,
): string | null {
  if (hits.length === 0) return null;
  const target = cleanCompanyName(prospectName).toLowerCase();
  const exact = hits.find(
    (h) => cleanCompanyName(h.name ?? "").toLowerCase() === target,
  );
  if (exact?.id != null) return String(exact.id);
  if (!allowFirstFallback) return null;
  const first = hits[0]?.id;
  return first == null ? null : String(first);
}

// Find the canonical companyId for a prospect using a fallback chain. The
// problem ZoomInfo throws at us is that `name + website` does AND-filtering,
// so if their record has a different website than what we got from the CSV,
// the combo returns zero. We try increasingly loose strategies:
//   1. name + website   → take first (high confidence, ZoomInfo confirmed both)
//   2. website-only     → take first (precise — only one company per domain)
//   3. name-only        → take exact name match only (no first-hit fallback,
//                          so we don't accidentally pick "Beam Global UK" for
//                          "Beam Distributing")
async function lookupCompanyId(args: {
  token: string;
  companyName: string;
  website: string | null;
}): Promise<string | null> {
  // Strategy 1: name + website
  if (args.website) {
    const hits = await searchCompany({
      token: args.token,
      filters: { companyName: args.companyName, companyWebsite: args.website },
    });
    const pick = pickBestMatch(hits, args.companyName, true);
    if (pick) return pick;
  }
  // Strategy 2: website-only
  if (args.website) {
    const hits = await searchCompany({
      token: args.token,
      filters: { companyWebsite: args.website },
    });
    if (hits.length > 0 && hits[0]?.id != null) return String(hits[0].id);
  }
  // Strategy 3: name-only, strict exact match (no first-hit fallback)
  const hits = await searchCompany({
    token: args.token,
    filters: { companyName: args.companyName },
  });
  return pickBestMatch(hits, args.companyName, false);
}

// ─────────────────────────────────────────────────────────────────────────
// Search contacts → candidates (by companyId for precision)

type ZoomInfoSearchHit = {
  id?: number | string;
  firstName?: string;
  middleName?: string;
  lastName?: string;
  jobTitle?: string;
  hasEmail?: boolean;
};

async function searchTopCandidates(args: {
  token: string;
  companyId: string;
}): Promise<ZoomInfoSearchHit[]> {
  const body = {
    companyId: args.companyId, // STRING — ZoomInfo rejects numbers here
    rpp: SEARCH_RPP,
    page: 1,
    sortBy: "Relevance",
  };
  const res = await fetch(SEARCH_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${args.token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`ZoomInfo /search/contact HTTP ${res.status}: ${text.slice(0, 400)}`);
  }
  const data = JSON.parse(text) as { data?: unknown };
  return Array.isArray(data.data) ? (data.data as ZoomInfoSearchHit[]) : [];
}

// ─────────────────────────────────────────────────────────────────────────
// Claude picker

const PICKER_SYSTEM_PROMPT = `You are an SDR at GovSpend (procurement-data SaaS for B2B vendors selling into US state/local/education agencies) picking contacts at a prospect company for outbound.

You receive a list of contacts ZoomInfo returned for the company. Pick up to 3:
- One EXEC: senior leader with strategic ownership of revenue or growth (CRO, CSO, CGO, CCO, President, CEO, VP Sales, VP Public Sector, VP Government Sales, VP Business Development, GM)
- One MANAGER: direct line manager for sales/BD (Director of Sales, Director of Public Sector, Director of Government Sales, Capture Director, BD Manager, Sales Manager, Regional Sales Manager)
- One IC: day-to-day quota carrier (Government AE, Public Sector AE, SLED AE, Account Executive, Territory Manager, Capture Manager, Proposal Manager, BDR)

PRIORITIZE people responsible for public-sector / SLED / government revenue. If you can choose between two execs and one has "Public Sector" in the title, pick that one.

If no good fit at a tier, omit that tier entirely (return fewer than 3). DO NOT stretch to a weak fit (e.g. a generic VP of Marketing is not an exec pick; a Customer Success Manager is not a sales IC).

Output ONLY this JSON, no other text:
{
  "picks": [
    {"id": <numeric id from input>, "tier": "exec" | "manager" | "ic", "rationale": "one sentence why"}
  ]
}`;

type Pick = { id: number | string; tier: ContactTier; rationale: string };

async function pickContactsViaClaude(args: {
  anthropicKey: string;
  companyName: string;
  industryGuess: string | null | undefined;
  valueDriver: string | null | undefined;
  candidates: ZoomInfoSearchHit[];
}): Promise<Pick[]> {
  if (args.candidates.length === 0) return [];

  const candidateLines = args.candidates
    .filter((c) => c.id && c.jobTitle && c.firstName && c.lastName)
    .map((c) => `- id=${c.id} | ${c.firstName} ${c.lastName} — ${c.jobTitle}`)
    .join("\n");

  const userPrompt = [
    `Prospect company: ${args.companyName}`,
    args.industryGuess ? `Industry / product hint: ${args.industryGuess}` : null,
    args.valueDriver ? `Primary value driver: ${args.valueDriver}` : null,
    "",
    `Available contacts at ${args.companyName} (from ZoomInfo, ranked by relevance):`,
    candidateLines,
    "",
    "Pick up to 3. Output JSON only.",
  ]
    .filter(Boolean)
    .join("\n");

  const res = await fetch(ANTHROPIC_ENDPOINT, {
    method: "POST",
    headers: {
      "x-api-key": args.anthropicKey,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: CLAUDE_PICKER_MODEL,
      max_tokens: 800,
      system: PICKER_SYSTEM_PROMPT,
      messages: [{ role: "user", content: userPrompt }],
    }),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Claude picker HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  const data = JSON.parse(text) as {
    content?: Array<{ type: string; text?: string }>;
  };
  const out = (data.content ?? [])
    .map((b) => (b.type === "text" ? b.text ?? "" : ""))
    .join("")
    .trim();

  return parsePicks(out);
}

function parsePicks(text: string): Pick[] {
  if (!text) return [];
  const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) return [];
  let obj: { picks?: unknown };
  try {
    obj = JSON.parse(match[0]);
  } catch {
    return [];
  }
  if (!Array.isArray(obj.picks)) return [];
  const out: Pick[] = [];
  const validTiers: ContactTier[] = ["exec", "manager", "ic"];
  for (const raw of obj.picks) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const id = r.id;
    const tier = String(r.tier ?? "").trim() as ContactTier;
    if ((typeof id !== "number" && typeof id !== "string") || !id) continue;
    if (!validTiers.includes(tier)) continue;
    out.push({
      id,
      tier,
      rationale: String(r.rationale ?? "").trim(),
    });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────
// Enrich → email + phone for picked IDs

type EnrichResult = {
  id?: number | string;
  email?: string | null;
  phone?: string | null;
  firstName?: string;
  lastName?: string;
  jobTitle?: string;
};

async function enrichContacts(args: {
  token: string;
  personIds: Array<number | string>;
}): Promise<Map<string, EnrichResult>> {
  if (args.personIds.length === 0) return new Map();
  const body = {
    matchPersonInput: args.personIds.map((id) => ({ personId: id })),
    outputFields: ["email", "phone", "firstName", "lastName", "jobTitle"],
  };
  const res = await fetch(ENRICH_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${args.token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    // Don't fail the whole flow if enrich errors — return empty so the caller
    // falls back to search-only data.
    console.error(`ZoomInfo /enrich/contact HTTP ${res.status}: ${text.slice(0, 300)}`);
    return new Map();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    console.error(`ZoomInfo /enrich/contact returned non-JSON: ${text.slice(0, 300)}`);
    return new Map();
  }
  // Actual response shape from /enrich/contact:
  //   { success: true, data: { outputFields: [...], result: [...], ... } }
  // where each `result` item is { input: {personid}, data: [{email, ...}], matchStatus }.
  // (Earlier code expected `data` to BE the array — silently dropped every email.)
  const out = new Map<string, EnrichResult>();
  const dataField = (parsed as { data?: unknown })?.data;
  const blocks: Array<{
    data?: unknown;
    input?: { personid?: number | string };
  }> = Array.isArray(dataField)
    ? (dataField as Array<{ data?: unknown; input?: { personid?: number | string } }>)
    : Array.isArray((dataField as { result?: unknown })?.result)
      ? ((dataField as { result: Array<{ data?: unknown; input?: { personid?: number | string } }> }).result)
      : [];
  for (const block of blocks) {
    if (!block || typeof block !== "object") continue;
    const inner = Array.isArray(block.data) ? (block.data as EnrichResult[]) : [];
    const rec = inner[0];
    if (!rec) continue;
    const inputId = block.input?.personid;
    const recordId = rec.id;
    const key = String(inputId ?? recordId ?? "");
    if (key) out.set(key, rec);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────
// Orchestration

export function createZoomInfoRestProvider(args: {
  privateKeyPem: string;
  username: string;
  clientId: string;
  anthropicKey: string;
}): ContactProvider {
  return {
    name: "zoominfo-rest",
    async fetchContacts({
      companyName,
      website,
      industryGuess,
      primaryValueDriver,
    }): Promise<EnrichedContact[]> {
      const token = await getAccessToken(args);

      // 1. Find ZoomInfo's canonical companyId for this prospect. Without this
      //    step, /search/contact's `companyName` filter does literal string
      //    match and misses any variation in the company's real name.
      const companyId = await lookupCompanyId({
        token,
        companyName,
        website,
      });
      if (!companyId) {
        console.error(`ZoomInfo: no company match for "${companyName}"`);
        return [];
      }

      // 2. Search contacts at that companyId — up to 50 candidates.
      const candidates = await searchTopCandidates({ token, companyId });
      if (candidates.length === 0) return [];

      // 2. Claude picks the best up-to-3.
      const picks = await pickContactsViaClaude({
        anthropicKey: args.anthropicKey,
        companyName,
        industryGuess,
        valueDriver: primaryValueDriver,
        candidates,
      });
      if (picks.length === 0) return [];

      // 3. Enrich emails+phone for the picked IDs.
      const enriched = await enrichContacts({
        token,
        personIds: picks.map((p) => p.id),
      });

      // 4. Merge.
      const candidateById = new Map(
        candidates.map((c) => [String(c.id ?? ""), c]),
      );
      const out: EnrichedContact[] = [];
      for (const p of picks) {
        const key = String(p.id);
        const base = candidateById.get(key);
        const enr = enriched.get(key);
        const fn = (enr?.firstName ?? base?.firstName ?? "").trim();
        const ln = (enr?.lastName ?? base?.lastName ?? "").trim();
        const title = (enr?.jobTitle ?? base?.jobTitle ?? "").trim();
        if (!fn || !ln) continue;
        out.push({
          name: `${fn} ${ln}`,
          title,
          tier: p.tier,
          email: enr?.email ?? null,
          linkedin: null, // not available on this account's plan
          rationale: p.rationale,
          sources: ["zoominfo-rest"],
        });
      }
      return out;
    },
  };
}
