import "server-only";
import type { ContactProvider, ContactTier, EnrichedContact } from "./types";

// Contact finder constrained to the prospect's own website. Anthropic's
// server-side web_search tool with queries anchored to site:{domain}/about,
// /team, /leadership, etc. Mirrors what an SDR does as step 2 of contact
// research: "what does the company actually say about its own people?"
//
// Strengths: confirms a person is currently employed there (their own site
// says so), often surfaces titles that other sources miss for execs.
// Weaknesses: rarely surfaces ICs / mid-level contacts; emails essentially
// never appear. ZoomInfo wins on email, LinkedIn wins on title precision —
// this provider wins on "are they actually still here?"

const ANTHROPIC_ENDPOINT = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-sonnet-4-6";
const MAX_TOKENS = 2048;
const MAX_SEARCHES = 4;
const PROVIDER_NAME = "company-website";

const VALID_TIERS: ReadonlyArray<ContactTier> = ["exec", "manager", "ic"];

const SYSTEM_PROMPT = `You are an SDR at GovSpend (procurement-data SaaS for B2B vendors selling into US state/local/education agencies) finding sales contacts at a prospect company by reading the company's OWN website.

Use web_search with queries anchored to the prospect's website. Helpful patterns:
- site:{domain}/about
- site:{domain}/team
- site:{domain}/leadership
- site:{domain}/people
- site:{domain} "VP" OR "Director" OR "President" OR "Chief"
- site:{domain} "public sector" OR "government"

Make up to ${MAX_SEARCHES} searches. Vary the path / keywords if first results are thin.

GOAL: pick up to 3 contacts the prospect's own website mentions:
- exec: CRO, CSO, CGO, CCO, President, CEO, VP Sales, VP Public Sector, VP Government Sales, GM, Chief
- manager: Director of Sales, Director of Public Sector, Director of Government Sales, Capture Director, Sales Manager
- ic: Government AE, Public Sector AE, SLED AE, Account Executive, BDR, Capture Manager

Prioritize public-sector / SLED / government titles when available.

RULES:
- Only include contacts you SAW on the prospect's own website. NO LinkedIn-only people. NO press-release inferences. If you can't quote what the site says about them, drop them.
- Emails rarely appear on company sites. Leave email field null unless you literally saw a mailto: address.
- LinkedIn URL: only if the website cross-links to it.

OUTPUT (after your final search, send ONLY this JSON, no prose):
{
  "contacts": [
    {
      "name": "First Last",
      "title": "Their job title exactly as the site shows it",
      "tier": "exec" | "manager" | "ic",
      "linkedin": string | null,
      "rationale": "one sentence on what the website says — quote the page/path if you can"
    }
  ]
}

If you can't find anyone on the site: {"contacts": []}`;

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

export function createCompanyWebsiteContactsProvider(args: {
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
      // No website == no signal. The whole point of this provider is to
      // anchor searches to site:{domain}; without one we'd just be a worse
      // version of the LinkedIn provider.
      if (!website || website.trim() === "") return [];

      const userPrompt = [
        `Prospect company: ${companyName}`,
        `Website: ${website}`,
        industryGuess ? `Industry hint: ${industryGuess}` : null,
        primaryValueDriver ? `Primary value driver: ${primaryValueDriver}` : null,
        "",
        `Find up to 3 contacts at ${companyName} by searching their own website (${website}). Use web_search anchored to site:{their-domain}, then output the JSON.`,
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
          `Anthropic company-website HTTP ${res.status}: ${text.slice(0, 300)}`,
        );
      }
      const data = JSON.parse(text) as AnthropicResponse;
      if (data.type === "error") {
        throw new Error(
          `Anthropic company-website error: ${data.error?.type} - ${data.error?.message}`,
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
