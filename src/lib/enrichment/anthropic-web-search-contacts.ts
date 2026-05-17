import "server-only";
import type { ContactProvider, ContactTier, EnrichedContact } from "./types";

// Contact finder backed by Anthropic's server-side web_search tool. Unlike the
// Brave version (custom tool, multi-turn client loop), this uses a single API
// call — Anthropic runs the searches internally and gives us the final answer.
//
// Generally better LinkedIn / small-company coverage than Brave's index, but
// each search costs ~$0.01 in Anthropic credits, so we use this as the first
// fallback when ZoomInfo whiffs and let Brave be a cheaper secondary.

const ANTHROPIC_ENDPOINT = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-sonnet-4-6";
const MAX_TOKENS = 2048;
const MAX_SEARCHES = 5;

const VALID_TIERS: ReadonlyArray<ContactTier> = ["exec", "manager", "ic"];

const SYSTEM_PROMPT = `You are an SDR at GovSpend (procurement-data SaaS for B2B vendors selling into US state/local/education agencies) finding sales contacts at a prospect company.

Use your web_search tool to find current employees with sales / business development / public-sector titles. Helpful query patterns:
- "[Company Name]" LinkedIn site:linkedin.com/in
- "[Company Name]" VP Sales OR Director OR President
- "[Company Name]" leadership team
- "[Company Name]" public sector OR government
- Direct fetch of [website]/about or /team

Make up to ${MAX_SEARCHES} searches. Vary the query if first results are thin.

GOAL: pick up to 3 contacts:
- exec: CRO, CSO, CGO, CCO, President, CEO, VP Sales, VP Public Sector, VP Government Sales, GM, Chief
- manager: Director of Sales, Director of Public Sector, Director of Government Sales, Capture Director, Sales Manager
- ic: Government AE, Public Sector AE, SLED AE, Account Executive, BDR, Capture Manager

Prioritize public-sector / SLED / government titles when available.

RULES:
- Only include contacts you actually found in search results — DO NOT invent names.
- LinkedIn URL: only include if you saw it in the results.
- If you find a name and you're confident, include them even if title is from a less-than-perfect source.
- If no good fit at a tier, omit that tier.

OUTPUT (after your final search, send ONLY this JSON, no prose):
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
  | { type: string };

type AnthropicResponse = {
  type?: "error" | "message";
  error?: { type: string; message: string };
  content?: AnthropicContentBlock[];
  usage?: { input_tokens?: number; output_tokens?: number };
};

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

export function createAnthropicWebSearchContactsProvider(args: {
  anthropicKey: string;
}): ContactProvider {
  return {
    name: "anthropic-web-search",
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
        `Find up to 3 contacts at ${companyName} for public-sector outreach. Use web_search, then output the JSON.`,
      ]
        .filter(Boolean)
        .join("\n");

      const body = {
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: userPrompt }],
        tools: [
          {
            type: "web_search_20250305",
            name: "web_search",
            max_uses: MAX_SEARCHES,
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
        throw new Error(
          `Anthropic web_search HTTP ${res.status}: ${text.slice(0, 300)}`,
        );
      }
      const data = JSON.parse(text) as AnthropicResponse;
      if (data.type === "error") {
        throw new Error(
          `Anthropic web_search error: ${data.error?.type} - ${data.error?.message}`,
        );
      }

      // Anthropic's web_search is server-side: response contains text blocks
      // plus internal tool_use/tool_result blocks we can ignore. We just want
      // the final text the model emitted.
      const outText = (data.content ?? [])
        .map((b) => (b.type === "text" ? (b as { text: string }).text : ""))
        .join("")
        .trim();

      return parseContactsJson(outText);
    },
  };
}
