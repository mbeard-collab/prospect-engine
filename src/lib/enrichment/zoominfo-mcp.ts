import "server-only";
import type { ContactProvider, EnrichedContact, ContactTier } from "./types";

// One Anthropic API call per prospect with the ZoomInfo MCP server attached.
// Claude calls ZoomInfo search tools, picks 3 tiered contacts (exec / manager
// / IC), returns them as JSON. No cache — fresh ZoomInfo data per call.

const ANTHROPIC_ENDPOINT = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-sonnet-4-6";
const MCP_BETA = "mcp-client-2025-11-20";
const MAX_TOKENS = 2048;

const SYSTEM_PROMPT = `You are looking up sales contacts at a B2B prospect company for an SDR at GovSpend (a procurement-data SaaS).

You have access to ZoomInfo MCP tools.

GOAL: find up to 3 contacts at the prospect company, one per tier:
- exec: CRO, CSO, CGO, CCO, President, CEO, VP Sales, VP Public Sector, VP Government Sales, VP Business Development, VP Strategic Accounts, VP Channel Sales, GM
- manager: Director of Sales, Director of Public Sector, Director of Government Sales, Director of BD, Director of Strategic Accounts, Director of Channel Sales, Sales Manager, Regional Sales Manager, Government Sales Manager, Public Sector Sales Manager, BD Manager, Capture Director, Proposal Director
- ic: Government AE, Public Sector AE, SLED AE, State and Local AE, Higher Ed AE, Account Manager, Territory Manager, BDR, SDR, Capture Manager, Proposal Manager, Bid Manager, Contracts Manager

PRIORITY: people responsible for public-sector revenue, gov sales, BD, SLED growth, bids, proposals, capture, territory expansion. Prefer current employees only.

TOOL BUDGET: at most 2 search calls. Cast a broad first search, refine if needed.

RULES:
- Never invent email or LinkedIn URLs. Only include if ZoomInfo returned them. Use null otherwise.
- If no strong contact at a tier, omit that tier (return fewer than 3 contacts).
- Each contact needs a one-sentence rationale explaining why they matter for a public-sector outreach.

OUTPUT FORMAT: respond with ONLY a JSON object, no other text:
{
  "contacts": [
    {
      "tier": "exec" | "manager" | "ic",
      "name": "First Last",
      "title": "Their title",
      "email": string | null,
      "linkedin": string | null,
      "rationale": "Why this contact matters for public-sector outreach (one sentence)"
    }
  ]
}

If no contacts found at any tier: {"contacts": []}`;

const VALID_TIERS: ReadonlyArray<ContactTier> = ["exec", "manager", "ic"];

type AnthropicResponse = {
  type?: "error" | "message";
  error?: { type: string; message: string };
  content?: Array<
    | { type: "text"; text: string }
    | { type: "mcp_tool_use" }
    | { type: "mcp_tool_result"; is_error?: boolean }
    | { type: string }
  >;
};

export function createZoomInfoMcpProvider(args: {
  url: string;
  token: string;
  anthropicKey: string;
}): ContactProvider {
  return {
    name: "zoominfo-mcp",
    async fetchContacts({ companyName, website }): Promise<EnrichedContact[]> {
      const userPrompt =
        `Prospect company: ${companyName}` +
        (website ? `\nWebsite: ${website}` : "") +
        `\n\nFind up to 3 contacts at ${companyName} (one exec, one manager, one IC) using ZoomInfo tools, then output the JSON.`;

      const body = {
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: userPrompt }],
        mcp_servers: [
          {
            type: "url",
            url: args.url,
            name: "zoominfo",
            authorization_token: args.token,
          },
        ],
        tools: [{ type: "mcp_toolset", mcp_server_name: "zoominfo" }],
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
          `ZoomInfo MCP call HTTP ${res.status}: ${text.slice(0, 300)}`,
        );
      }
      const data = JSON.parse(text) as AnthropicResponse;
      if (data.type === "error") {
        throw new Error(
          `ZoomInfo MCP error: ${data.error?.type ?? "?"} — ${data.error?.message ?? ""}`,
        );
      }

      const textOut = (data.content ?? [])
        .map((b) => (b.type === "text" ? (b as { text: string }).text : ""))
        .join("")
        .trim();

      return parseContactsJson(textOut);
    },
  };
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
    if (!VALID_TIERS.includes(tier)) continue;
    const name = String(c.name ?? "").trim();
    if (!name) continue;
    out.push({
      name,
      title: String(c.title ?? "").trim(),
      tier,
      email: (c.email as string | null) ?? null,
      linkedin: (c.linkedin as string | null) ?? null,
      rationale: (c.rationale as string | null) ?? null,
    });
  }
  return out;
}
