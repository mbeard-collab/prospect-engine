import "server-only";
import type { ContactProvider, ContactTier, EnrichedContact } from "./types";

// Long-shot contact finder backed by Spark MCP. Most GovSpend records track
// the AGENCY side (procurement officers, contract managers) — but sometimes
// a contract record names the vendor-side person who signed, the account
// manager, or someone quoted in a press release indexed with the contract.
// When that signal exists, it's gold: a real human at the prospect company
// who is already in motion with a government buyer.
//
// Expected hit rate: low. Most calls return empty. That's fine — this
// provider's job is to surface the rare wins, not to be a primary source.
// The aggregator will still produce contacts from ZoomInfo / LinkedIn /
// company-website when this whiffs.

const ANTHROPIC_ENDPOINT = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-sonnet-4-6";
const MCP_BETA = "mcp-client-2025-11-20";
const MAX_TOKENS = 2048;
const PROVIDER_NAME = "govspend-contracts";

const VALID_TIERS: ReadonlyArray<ContactTier> = ["exec", "manager", "ic"];

const SYSTEM_PROMPT = `You are an SDR at GovSpend reading Spark contract records to find vendor-side personnel at a prospect company. This is a LONG SHOT — most contract records only name agency contacts, not vendor contacts. That's expected. Return an empty list rather than guessing.

Use the Spark MCP tools to search recent contracts where the vendor / awardee is the prospect company. Look in contract text, awards, and any indexed press releases for VENDOR-SIDE names:
- a vendor sales rep or account manager named in the contract
- a vendor executive quoted in an award announcement
- a "vendor contact" or "vendor representative" field

DO NOT include:
- agency-side personnel (procurement officers, contract managers, agency leads) — they don't work at the prospect company
- people inferred from the company name (e.g. the CEO from a press release that doesn't name them)
- guesses

TOOL BUDGET: at most 2 tool calls. If the first contract search returns nothing useful, give up and return empty rather than fishing.

OUTPUT FORMAT: respond with ONLY a JSON object, no other text:
{
  "contacts": [
    {
      "name": "First Last",
      "title": "Their role as the contract/announcement describes it",
      "tier": "exec" | "manager" | "ic",
      "linkedin": null,
      "rationale": "one sentence pointing at the specific Spark record that names them"
    }
  ]
}

If you can't find any vendor-side names in Spark: {"contacts": []}`;

type AnthropicResponse = {
  type?: "error" | "message";
  error?: { type: string; message: string };
  content?: Array<
    | { type: "text"; text: string }
    | { type: "mcp_tool_use"; name?: string; server_name?: string }
    | { type: "mcp_tool_result"; is_error?: boolean }
    | { type: string }
  >;
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

export function createGovspendContractsContactsProvider(args: {
  url: string;
  token: string;
  anthropicKey: string;
}): ContactProvider {
  return {
    name: PROVIDER_NAME,
    async fetchContacts({ companyName, industryGuess }): Promise<EnrichedContact[]> {
      const userPrompt =
        `Prospect company: ${companyName}` +
        (industryGuess ? `\nIndustry hint: ${industryGuess}` : "") +
        `\n\nSearch Spark for recent contracts where ${companyName} is the vendor / awardee. Look for VENDOR-side names mentioned in the contract text. Most of the time you'll find nothing — return empty contacts when that's the case.`;

      const body = {
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: userPrompt }],
        mcp_servers: [
          {
            type: "url",
            url: args.url,
            name: "spark",
            authorization_token: args.token,
          },
        ],
        tools: [{ type: "mcp_toolset", mcp_server_name: "spark" }],
      };

      const res = await fetch(ANTHROPIC_ENDPOINT, {
        method: "POST",
        headers: {
          "x-api-key": args.anthropicKey,
          "anthropic-version": "2023-06-01",
          "anthropic-beta": MCP_BETA,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });

      const text = await res.text();
      if (!res.ok) {
        throw new Error(
          `Spark MCP contacts HTTP ${res.status}: ${text.slice(0, 300)}`,
        );
      }
      const data = JSON.parse(text) as AnthropicResponse;
      if (data.type === "error") {
        throw new Error(
          `Spark MCP contacts error: ${data.error?.type} - ${data.error?.message}`,
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
