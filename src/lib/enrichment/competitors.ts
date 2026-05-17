import "server-only";
import type { CompetitorProvider, EnrichedCompetitors } from "./types";

// Stage 2.5 competitor research, backed by Anthropic's server-side web_search
// tool. One API call per company; Anthropic runs the searches internally and
// returns the final answer. Cached on companies.competitors with 90-day TTL,
// so re-running the same CSV is free for repeat companies.

const ANTHROPIC_ENDPOINT = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-sonnet-4-6";
const MAX_TOKENS = 1024;
const MAX_SEARCHES = 4;

const SYSTEM_PROMPT = `You are an SDR at GovSpend researching the competitive landscape for a prospect company. Goal: identify up to 3 named competitors that GovSpend's SDR can reference when comparing the prospect against their market.

Use the web_search tool to find evidence. Helpful query patterns:
- "[Company Name]" alternatives
- "[Company Name]" vs
- "[Company Name]" competitors
- G2 / Capterra category for [their product]
- "[Industry]" public sector vendors

Make up to ${MAX_SEARCHES} searches. Vary the query if first results are thin.

REQUIREMENTS:
- Names must be REAL companies you saw in search results. DO NOT invent or guess.
- Prefer competitors that also sell into US state/local/education or federal government agencies — that's GovSpend's customer market.
- If the prospect is too niche or you can't find clear competitors after searching, return an empty names array and explain why in the note.

OUTPUT (after your final search, send ONLY this JSON, no prose):
{
  "names": ["Competitor One", "Competitor Two", "Competitor Three"],
  "note": "One or two sentences describing the competitive landscape, mentioning any source evidence (e.g. G2 listing, comparison article). If you couldn't find good competitors, briefly say why."
}`;

type AnthropicContentBlock =
  | { type: "text"; text: string }
  | { type: string };

type AnthropicResponse = {
  type?: "error" | "message";
  error?: { type: string; message: string };
  content?: AnthropicContentBlock[];
  usage?: { input_tokens?: number; output_tokens?: number };
};

function parseCompetitorsJson(text: string): EnrichedCompetitors | null {
  if (!text) return null;
  const cleaned = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) return null;
  let obj: { names?: unknown; note?: unknown };
  try {
    obj = JSON.parse(match[0]);
  } catch {
    return null;
  }
  const names = Array.isArray(obj.names)
    ? obj.names
        .filter((x): x is string => typeof x === "string")
        .map((x) => x.trim())
        .filter((x) => x.length > 0)
        .slice(0, 3)
    : [];
  const note = typeof obj.note === "string" ? obj.note.trim() : "";
  if (names.length === 0 && note.length === 0) return null;
  return { names, note };
}

export function createAnthropicCompetitorProvider(args: {
  anthropicKey: string;
}): CompetitorProvider {
  return {
    name: "anthropic-web-search-competitors",
    async fetchCompetitors({
      companyName,
      website,
      industryGuess,
      primaryValueDriver,
    }): Promise<EnrichedCompetitors | null> {
      const userPrompt = [
        `Prospect company: ${companyName}`,
        website ? `Website: ${website}` : null,
        industryGuess ? `Industry hint: ${industryGuess}` : null,
        primaryValueDriver
          ? `Primary value driver: ${primaryValueDriver}`
          : null,
        "",
        `Find up to 3 real competitors of ${companyName}. Use web_search, then output the JSON.`,
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
          `Anthropic competitors HTTP ${res.status}: ${text.slice(0, 300)}`,
        );
      }
      const data = JSON.parse(text) as AnthropicResponse;
      if (data.type === "error") {
        throw new Error(
          `Anthropic competitors error: ${data.error?.type} - ${data.error?.message}`,
        );
      }

      const outText = (data.content ?? [])
        .map((b) => (b.type === "text" ? (b as { text: string }).text : ""))
        .join("")
        .trim();

      return parseCompetitorsJson(outText);
    },
  };
}

// No-op fallback when no Anthropic key is configured. Stage 2.5 simply
// doesn't run; the UI shows a "not researched" placeholder.
export function createNullCompetitorProvider(): CompetitorProvider {
  return {
    name: "none",
    async fetchCompetitors() {
      return null;
    },
  };
}
