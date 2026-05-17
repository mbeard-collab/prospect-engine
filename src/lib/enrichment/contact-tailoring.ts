import "server-only";
import type { ContactTier, EnrichedContact } from "./types";

// Per-contact tailoring run inside Stage 3, right after contacts come back
// from ZoomInfo or the fallback web-search providers. One Claude call per
// company takes the full contact list and the company's GovSpend context, and
// returns two short SDR-facing strings per contact: why they're the right
// person to pitch and what GovSpend-relevant pain they're probably feeling.
//
// We do one call per company (not per contact) so the model can read all
// three personas at once and write distinct rationale across them instead of
// three near-identical paragraphs. No tools, just text in → text out.

const ANTHROPIC_ENDPOINT = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-sonnet-4-6";
const MAX_TOKENS = 800;

const SYSTEM_PROMPT = `You are an SDR at GovSpend writing internal notes for yourself, NOT outbound copy. Goal: given a prospect company and a small list of contacts at that company, write two short notes per contact that will help an SDR decide who to email and how to angle the message.

For each contact:
- outreach_angle: ONE sentence (under 25 words) on why this specific person is the right outreach target, grounded in their title and tier. NOT a generic statement.
- likely_challenge: ONE sentence (under 25 words) on the GovSpend-relevant pain they're probably feeling — visibility into government spend, competitor activity, contract renewals, agency relationships, RFP timing, etc.

WRITE LIKE A HUMAN ANALYST:
- Specific to the title. A VP Sales reads differently than a Director of Marketing reads differently than a BDR.
- No marketing vocabulary (no "leverage", "robust", "valuable", "transform", "optimize", etc.).
- No filler ("They are responsible for", "This person oversees").
- No praise.
- If two contacts at the company share the same function, differentiate them by seniority and scope, not by repeating the same idea.

OUTPUT: ONLY JSON, no other text. Match each input contact by index (0-based, in the order given):
{
  "tailored": [
    { "index": 0, "outreach_angle": "...", "likely_challenge": "..." },
    { "index": 1, "outreach_angle": "...", "likely_challenge": "..." }
  ]
}`;

type Tailored = {
  outreachAngle: string | null;
  likelyChallenge: string | null;
};

type AnthropicResponse = {
  type?: "error" | "message";
  error?: { type: string; message: string };
  content?: Array<{ type: "text"; text: string } | { type: string }>;
  usage?: { input_tokens?: number; output_tokens?: number };
};

export type TailorInput = {
  companyName: string;
  industryGuess: string | null;
  primaryValueDriver: string | null;
  contacts: Array<{
    name: string;
    title: string;
    tier: ContactTier;
  }>;
};

export type TailorResult = {
  tailored: Tailored[];
  usage: {
    inputTokens: number;
    outputTokens: number;
    dollarEstimate: number;
  };
};

const INPUT_USD_PER_TOKEN = 3 / 1_000_000;
const OUTPUT_USD_PER_TOKEN = 15 / 1_000_000;

export async function tailorContacts(
  input: TailorInput,
  anthropicKey: string,
): Promise<TailorResult> {
  if (input.contacts.length === 0) {
    return {
      tailored: [],
      usage: { inputTokens: 0, outputTokens: 0, dollarEstimate: 0 },
    };
  }

  const userPromptLines = [
    `Prospect company: ${input.companyName}`,
    input.industryGuess ? `Industry hint: ${input.industryGuess}` : null,
    input.primaryValueDriver
      ? `Primary GovSpend value driver: ${input.primaryValueDriver}`
      : null,
    "",
    "Contacts (index, tier, title, name):",
    ...input.contacts.map(
      (c, i) => `  ${i}. [${c.tier}] ${c.title} — ${c.name}`,
    ),
    "",
    "For each contact, output JSON with outreach_angle and likely_challenge.",
  ].filter(Boolean);

  const body = {
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userPromptLines.join("\n") }],
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
    throw new Error(
      `Anthropic tailoring HTTP ${res.status}: ${text.slice(0, 300)}`,
    );
  }
  const data = JSON.parse(text) as AnthropicResponse;
  if (data.type === "error") {
    throw new Error(
      `Anthropic tailoring error: ${data.error?.type} - ${data.error?.message}`,
    );
  }
  const out = (data.content ?? [])
    .map((b) => (b.type === "text" ? (b as { text: string }).text : ""))
    .join("")
    .trim();

  const usage = {
    inputTokens: data.usage?.input_tokens ?? 0,
    outputTokens: data.usage?.output_tokens ?? 0,
    dollarEstimate:
      (data.usage?.input_tokens ?? 0) * INPUT_USD_PER_TOKEN +
      (data.usage?.output_tokens ?? 0) * OUTPUT_USD_PER_TOKEN,
  };

  const tailored = parseTailored(out, input.contacts.length);
  return { tailored, usage };
}

function parseTailored(text: string, n: number): Tailored[] {
  const cleaned = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  const empty = (): Tailored[] =>
    Array.from({ length: n }, () => ({
      outreachAngle: null,
      likelyChallenge: null,
    }));
  if (!match) return empty();
  let obj: { tailored?: unknown };
  try {
    obj = JSON.parse(match[0]);
  } catch {
    return empty();
  }
  if (!Array.isArray(obj.tailored)) return empty();

  const result = empty();
  for (const raw of obj.tailored) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const idx = typeof r.index === "number" ? r.index : Number(r.index);
    if (!Number.isInteger(idx) || idx < 0 || idx >= n) continue;
    const angle =
      typeof r.outreach_angle === "string" ? r.outreach_angle.trim() : null;
    const challenge =
      typeof r.likely_challenge === "string" ? r.likely_challenge.trim() : null;
    result[idx] = {
      outreachAngle: angle && angle.length > 0 ? angle : null,
      likelyChallenge:
        challenge && challenge.length > 0 ? challenge : null,
    };
  }
  return result;
}

// Convenience: merge tailoring back onto an EnrichedContact[] in input order.
export type TailoredContact = EnrichedContact & {
  outreachAngle: string | null;
  likelyChallenge: string | null;
};

export function applyTailoring(
  contacts: EnrichedContact[],
  tailored: Tailored[],
): TailoredContact[] {
  return contacts.map((c, i) => ({
    ...c,
    outreachAngle: tailored[i]?.outreachAngle ?? null,
    likelyChallenge: tailored[i]?.likelyChallenge ?? null,
  }));
}
