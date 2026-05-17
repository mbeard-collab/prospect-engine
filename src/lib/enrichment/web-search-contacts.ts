import "server-only";
import type { ContactProvider, ContactTier, EnrichedContact } from "./types";

// Fallback contact finder for when ZoomInfo whiffs. We expose Brave search as
// a custom tool to Claude; Claude orchestrates multi-turn search ("find VP
// Sales LinkedIn", "find company team page", etc.) and returns 3 contacts as
// JSON. No emails (web search can't surface those), but names + titles +
// LinkedIn URLs are useful enough to seed an SDR's hand-research.

const ANTHROPIC_ENDPOINT = "https://api.anthropic.com/v1/messages";
const BRAVE_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";
const MODEL = "claude-sonnet-4-6";
const MAX_TOOL_ROUNDS = 4;
const MAX_TOKENS = 2048;

const VALID_TIERS: ReadonlyArray<ContactTier> = ["exec", "manager", "ic"];

const SYSTEM_PROMPT = `You are an SDR at GovSpend (procurement-data SaaS for B2B vendors selling into US state/local/education agencies) finding sales contacts at a prospect company.

You have access to a brave_search tool. Use it to find current employees with sales / public-sector / business development titles, from sources like:
- LinkedIn profile snippets (company employees)
- Company "About" / "Team" pages
- Press releases announcing hires
- Recent news mentioning executives

GOAL: pick up to 3 contacts:
- exec: CRO, CSO, CGO, CCO, President, CEO, VP Sales, VP Public Sector, VP Government Sales, GM, Chief
- manager: Director of Sales, Director of Public Sector, Director of Government Sales, Capture Director, BD Manager, Sales Manager
- ic: Government AE, Public Sector AE, SLED AE, Account Executive, BDR, Capture Manager

Prioritize public-sector / SLED / government titles when available.

TOOL BUDGET: at most 3 brave_search calls. Make each query specific. After you have enough data, stop searching and produce the JSON.

RULES:
- Only include contacts you actually found in the search results — DO NOT invent names.
- LinkedIn URL: only include if it was in the search snippets.
- If no good fit at a tier, omit that tier.

OUTPUT (after your last tool call, send ONLY this JSON — no prose):
{
  "contacts": [
    {
      "name": "First Last",
      "title": "Their job title",
      "tier": "exec" | "manager" | "ic",
      "linkedin": string | null,
      "rationale": "one sentence on why this person, citing the source you found them in"
    }
  ]
}

If you can't find anyone real: {"contacts": []}`;

type AnthropicContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: string };

type AnthropicMessage = {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[] | unknown[];
};

type AnthropicResponse = {
  type?: "error" | "message";
  error?: { type: string; message: string };
  stop_reason?: string;
  content?: AnthropicContentBlock[];
};

async function braveSearch(args: {
  apiKey: string;
  query: string;
}): Promise<Array<{ title: string; url: string; description: string }>> {
  const url = new URL(BRAVE_ENDPOINT);
  url.searchParams.set("q", args.query);
  url.searchParams.set("count", "5");
  const res = await fetch(url, {
    headers: { Accept: "application/json", "X-Subscription-Token": args.apiKey },
    cache: "no-store",
  });
  if (!res.ok) {
    return [{ title: "(brave error)", url: "", description: `HTTP ${res.status}` }];
  }
  const data = (await res.json()) as {
    web?: { results?: Array<{ title?: string; url?: string; description?: string }> };
  };
  return (data.web?.results ?? []).slice(0, 5).map((r) => ({
    title: r.title ?? "",
    url: r.url ?? "",
    description: r.description ?? "",
  }));
}

async function callClaude(args: {
  anthropicKey: string;
  messages: AnthropicMessage[];
}): Promise<AnthropicResponse> {
  const body = {
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: SYSTEM_PROMPT,
    messages: args.messages,
    tools: [
      {
        name: "brave_search",
        description:
          "Search the web for public information. Returns up to 5 results with title, URL, and short description. Use for finding people, company team pages, press releases.",
        input_schema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description:
                'Search query string, e.g. "Beam Distributing VP Sales site:linkedin.com"',
            },
          },
          required: ["query"],
        },
      },
    ],
  };
  const res = await fetch(ANTHROPIC_ENDPOINT, {
    method: "POST",
    headers: {
      "x-api-key": args.anthropicKey,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Anthropic call HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  return JSON.parse(text) as AnthropicResponse;
}

function parseContactsJson(text: string): EnrichedContact[] {
  if (!text) return [];
  const cleaned = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) return [];
  let obj: { contacts?: unknown };
  try {
    obj = JSON.parse(match[0]);
  } catch {
    return [];
  }
  if (!Array.isArray(obj.contacts)) return [];
  const out: EnrichedContact[] = [];
  for (const raw of obj.contacts) {
    if (!raw || typeof raw !== "object") continue;
    const c = raw as Record<string, unknown>;
    const tier = String(c.tier ?? "").trim() as ContactTier;
    const name = String(c.name ?? "").trim();
    if (!VALID_TIERS.includes(tier) || !name) continue;
    out.push({
      name,
      title: String(c.title ?? "").trim(),
      tier,
      email: null,
      linkedin: (c.linkedin as string | null) ?? null,
      rationale: (c.rationale as string | null) ?? null,
    });
  }
  return out;
}

export function createWebSearchContactsProvider(args: {
  braveKey: string;
  anthropicKey: string;
}): ContactProvider {
  return {
    name: "web-search",
    async fetchContacts({
      companyName,
      website,
      industryGuess,
      primaryValueDriver,
    }): Promise<EnrichedContact[]> {
      const userPrompt = [
        `Prospect company: ${companyName}`,
        website ? `Website: ${website}` : null,
        industryGuess ? `Industry hint: ${industryGuess}` : null,
        primaryValueDriver ? `Primary value driver: ${primaryValueDriver}` : null,
        "",
        `Find up to 3 contacts at ${companyName} for public-sector outreach. Use brave_search, then output JSON.`,
      ]
        .filter(Boolean)
        .join("\n");

      const messages: AnthropicMessage[] = [
        { role: "user", content: userPrompt },
      ];

      for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        const res = await callClaude({
          anthropicKey: args.anthropicKey,
          messages,
        });
        if (res.type === "error") {
          throw new Error(
            `web-search contacts: ${res.error?.type} - ${res.error?.message}`,
          );
        }
        const content = res.content ?? [];

        // Final answer (no more tool use)
        if (res.stop_reason !== "tool_use") {
          const text = content
            .map((b) => (b.type === "text" ? (b as { text: string }).text : ""))
            .join("")
            .trim();
          return parseContactsJson(text);
        }

        // Append assistant turn, then execute every tool_use block
        messages.push({ role: "assistant", content });
        const toolUses = content.filter(
          (b): b is { type: "tool_use"; id: string; name: string; input: Record<string, unknown> } =>
            b.type === "tool_use",
        );
        const toolResults = await Promise.all(
          toolUses.map(async (tu) => {
            const query = String(tu.input?.query ?? "");
            const results = await braveSearch({ apiKey: args.braveKey, query });
            return {
              type: "tool_result",
              tool_use_id: tu.id,
              content: JSON.stringify(results),
            };
          }),
        );
        messages.push({ role: "user", content: toolResults });
      }

      // Hit max rounds without a final JSON — give up cleanly.
      console.error(
        `web-search contacts: max tool rounds (${MAX_TOOL_ROUNDS}) exceeded for ${companyName}`,
      );
      return [];
    },
  };
}
