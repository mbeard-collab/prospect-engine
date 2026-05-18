import "server-only";
import type { ContactProvider, ContactTier, EnrichedContact } from "./types";

// Contact finder constrained to LinkedIn. Anthropic's server-side web_search
// tool with queries anchored to site:linkedin.com/in. Mirrors what an SDR
// does as step 3: "who's actually listed on LinkedIn as working there in
// the right roles?"
//
// Strengths: most accurate for current titles + public-sector / sales role
// specificity. LinkedIn URLs come back populated. Weaknesses: no emails;
// some profiles are stale (people change jobs but don't update). Worth
// pairing with the company-website provider (which confirms employment via
// the company's own site).

const ANTHROPIC_ENDPOINT = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-sonnet-4-6";
const MAX_TOKENS = 2048;
const MAX_SEARCHES = 4;
const PROVIDER_NAME = "linkedin";

const VALID_TIERS: ReadonlyArray<ContactTier> = ["exec", "manager", "ic"];

const SYSTEM_PROMPT = `You are an SDR at GovSpend (procurement-data SaaS for B2B vendors selling into US state/local/education agencies) finding sales contacts at a prospect company by searching LinkedIn.

Use web_search with queries strictly anchored to LinkedIn. Helpful patterns:
- site:linkedin.com/in "[Company Name]" "VP Sales"
- site:linkedin.com/in "[Company Name]" "Director" "Public Sector"
- site:linkedin.com/in "[Company Name]" "Government Sales"
- site:linkedin.com/in "[Company Name]" CRO OR CSO OR President
- site:linkedin.com/in "[Company Name]" SLED OR "State and Local"
- site:linkedin.com/in "[Company Name]" "Account Executive"

Make up to ${MAX_SEARCHES} searches. Vary the query if first results are thin. STRONGLY prefer queries with site:linkedin.com/in over generic web searches.

GOAL: pick up to 3 contacts visible on LinkedIn:
- exec: CRO, CSO, CGO, CCO, President, CEO, VP Sales, VP Public Sector, VP Government Sales, GM, Chief
- manager: Director of Sales, Director of Public Sector, Director of Government Sales, Capture Director, Sales Manager
- ic: Government AE, Public Sector AE, SLED AE, Account Executive, BDR, Capture Manager

Prioritize public-sector / SLED / government titles when available.

RULES:
- Only include contacts whose LinkedIn profile actually showed up in search results — no inferences from press releases or company websites. If you can't return their linkedin URL, you didn't find them on LinkedIn.
- The LinkedIn URL is REQUIRED — leave email null, but linkedin must be the canonical /in/{slug} URL you saw.
- Skip people whose LinkedIn says they LEFT the company (look for "Former" / past tense).

OUTPUT (after your final search, send ONLY this JSON, no prose):
{
  "contacts": [
    {
      "name": "First Last",
      "title": "Their current LinkedIn headline / job title",
      "tier": "exec" | "manager" | "ic",
      "linkedin": "https://linkedin.com/in/...",
      "rationale": "one sentence on what their LinkedIn says — title + tenure if visible"
    }
  ]
}

If you can't find anyone on LinkedIn: {"contacts": []}`;

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
      sources: [PROVIDER_NAME],
    });
  }
  return out;
}

export function createLinkedinContactsProvider(args: {
  anthropicKey: string;
}): ContactProvider {
  return {
    name: PROVIDER_NAME,
    async fetchContacts({
      companyName,
      website,
      industryGuess,
      primaryValueDriver,
    }): Promise<EnrichedContact[]> {
      const userPrompt = [
        `Prospect company: ${companyName}`,
        website ? `Website (for disambiguation only): ${website}` : null,
        industryGuess ? `Industry hint: ${industryGuess}` : null,
        primaryValueDriver ? `Primary value driver: ${primaryValueDriver}` : null,
        "",
        `Find up to 3 contacts at ${companyName} via LinkedIn. Use web_search with site:linkedin.com/in queries, then output the JSON.`,
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
          `Anthropic linkedin HTTP ${res.status}: ${text.slice(0, 300)}`,
        );
      }
      const data = JSON.parse(text) as AnthropicResponse;
      if (data.type === "error") {
        throw new Error(
          `Anthropic linkedin error: ${data.error?.type} - ${data.error?.message}`,
        );
      }

      const outText = (data.content ?? [])
        .map((b) => (b.type === "text" ? (b as { text: string }).text : ""))
        .join("")
        .trim();

      return parseContactsJson(outText);
    },
  };
}
