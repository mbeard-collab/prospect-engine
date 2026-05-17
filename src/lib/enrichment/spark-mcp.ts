import "server-only";
import type { EnrichedSignal, SignalProvider, SignalType } from "./types";

// One Anthropic API call per prospect with the Spark MCP server attached.
// Claude calls Spark search tools, picks the strongest signal, returns JSON.
// No cache, no pool — always-fresh GovSpend data.

const ANTHROPIC_ENDPOINT = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-sonnet-4-6";
const MCP_BETA = "mcp-client-2025-11-20";
const MAX_TOKENS = 2048;

const SYSTEM_PROMPT = `You are looking up a GovSpend procurement signal for a B2B sales prospect.

You have access to Spark MCP tools that search GovSpend's state/local/federal procurement data.

GOAL: find the single STRONGEST signal that would matter to the prospect company — something an SDR can use to start a relevant outreach conversation.

PRIORITY ORDER (pick the highest-priority type with a real hit):
1. open_bid — an active agency RFP/bid relevant to what the prospect sells
2. expiring_contract — a competitor contract approaching renewal with an agency the prospect could win
3. po_breadcrumb — a recent PO suggesting timing (renewal language, subscription period, etc.)
4. meeting — agency meeting referencing the prospect's product category
5. spend_pattern — multiple agencies buying similar products across states

TOOL BUDGET: at most 2 tool calls. If the first call returns clearly useful data, use it. Don't keep searching for something better.

If the prospect's category is unclear, use spark_search_bids with broad keyword from the industry/value driver to see what's out there.

If no useful signal exists, return type "none" with a brief explanation in summary.

OUTPUT FORMAT: respond with ONLY a JSON object, no other text. Use null for unknown fields:
{
  "type": "open_bid" | "expiring_contract" | "po_breadcrumb" | "meeting" | "spend_pattern" | "none",
  "agencyName": string | null,
  "agencyState": string | null,
  "vendorName": string | null,
  "summary": "1-2 sentences tying the signal to the prospect company",
  "sourceLink": string | null,
  "signalDate": "YYYY-MM-DD" | null
}`;

const VALID_TYPES: ReadonlyArray<SignalType> = [
  "open_bid",
  "expiring_contract",
  "po_breadcrumb",
  "meeting",
  "spend_pattern",
];

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

export function createSparkMcpProvider(args: {
  url: string;
  token: string;
  anthropicKey: string;
}): SignalProvider {
  return {
    name: "spark-mcp",
    async fetchSignal({ companyName, industryGuess }): Promise<EnrichedSignal | null> {
      const userPrompt =
        `Company: ${companyName}` +
        (industryGuess ? `\nIndustry / product hint: ${industryGuess}` : "") +
        `\n\nFind the strongest GovSpend signal for ${companyName}. Use the Spark tools, then output the JSON.`;

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
        throw new Error(`Spark MCP call HTTP ${res.status}: ${text.slice(0, 300)}`);
      }
      const data = JSON.parse(text) as AnthropicResponse;
      if (data.type === "error") {
        throw new Error(
          `Spark MCP error: ${data.error?.type ?? "?"} — ${data.error?.message ?? ""}`,
        );
      }

      // Collect text blocks from the response.
      const textOut = (data.content ?? [])
        .map((b) => (b.type === "text" ? (b as { text: string }).text : ""))
        .join("")
        .trim();

      const parsed = tryParseSignalJson(textOut);
      if (!parsed || parsed.type === "none") return null;
      return parsed;
    },
  };
}

function tryParseSignalJson(text: string): EnrichedSignal | { type: "none" } | null {
  if (!text) return null;
  // Strip code fences if present.
  const cleaned = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) return null;
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(match[0]) as Record<string, unknown>;
  } catch {
    return null;
  }
  const type = String(obj.type ?? "").trim();
  if (type === "none") return { type: "none" };
  if (!VALID_TYPES.includes(type as SignalType)) return null;

  return {
    type: type as SignalType,
    agencyName: (obj.agencyName as string | null) ?? null,
    agencyState: (obj.agencyState as string | null) ?? null,
    vendorName: (obj.vendorName as string | null) ?? null,
    summary: String(obj.summary ?? "").trim(),
    sourceLink: (obj.sourceLink as string | null) ?? null,
    signalDate: (obj.signalDate as string | null) ?? null,
  };
}
