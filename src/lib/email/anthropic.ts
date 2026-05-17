import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import {
  EMAIL_SYSTEM_PROMPT,
  buildUserPrompt,
  systemPromptFor,
  userPromptFor,
  type Channel,
  type DraftInput,
  type EmailInput,
} from "./prompt";

// Claude Sonnet 4.6 pricing (per million tokens):
//   input  $3
//   output $15
export const MODEL = "claude-sonnet-4-6";
const INPUT_USD_PER_TOKEN = 3 / 1_000_000;
const OUTPUT_USD_PER_TOKEN = 15 / 1_000_000;

// Per-channel token caps. Email needs room for greeting + 3 lines + question
// + signoff. Voicemail is 50-70 words. SMS is one line under 160 chars.
const MAX_TOKENS: Record<Channel, number> = {
  email: 400,
  voicemail: 250,
  sms: 150,
};

export type Usage = {
  inputTokens: number;
  outputTokens: number;
  dollarEstimate: number;
};

export type DraftedEmail = {
  subject: string;
  body: string;
  usage: Usage;
  raw: string;
};

export type DraftedVoicemail = {
  script: string;
  usage: Usage;
  raw: string;
};

export type DraftedSms = {
  text: string;
  usage: Usage;
  raw: string;
};

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (client) return client;
  const apiKey = process.env.PROSPECT_ANTHROPIC_KEY;
  if (!apiKey) {
    throw new Error(
      "PROSPECT_ANTHROPIC_KEY not set — Stage 4 needs an Anthropic key",
    );
  }
  client = new Anthropic({ apiKey });
  return client;
}

async function callClaude(
  channel: Channel,
  input: DraftInput,
): Promise<{ raw: string; usage: Usage }> {
  const res = await getClient().messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS[channel],
    system: systemPromptFor(channel),
    messages: [{ role: "user", content: userPromptFor(channel, input) }],
  });
  const raw = res.content
    .map((b) => (b.type === "text" ? b.text : ""))
    .join("")
    .trim();
  const usage: Usage = {
    inputTokens: res.usage.input_tokens,
    outputTokens: res.usage.output_tokens,
    dollarEstimate:
      res.usage.input_tokens * INPUT_USD_PER_TOKEN +
      res.usage.output_tokens * OUTPUT_USD_PER_TOKEN,
  };
  return { raw, usage };
}

export async function draftEmail(input: DraftInput): Promise<DraftedEmail> {
  const { raw, usage } = await callClaude("email", input);
  const parsed = parseJsonObject(raw, ["subject", "body"]);
  return {
    subject: String(parsed.subject).trim(),
    body: String(parsed.body).trim(),
    usage,
    raw,
  };
}

export async function draftVoicemail(input: DraftInput): Promise<DraftedVoicemail> {
  const { raw, usage } = await callClaude("voicemail", input);
  const parsed = parseJsonObject(raw, ["script"]);
  return {
    script: String(parsed.script).trim(),
    usage,
    raw,
  };
}

export async function draftSms(input: DraftInput): Promise<DraftedSms> {
  const { raw, usage } = await callClaude("sms", input);
  const parsed = parseJsonObject(raw, ["text"]);
  return {
    text: String(parsed.text).trim(),
    usage,
    raw,
  };
}

// Model output should be a single JSON object, but be forgiving of stray
// commentary or fenced code blocks.
function parseJsonObject(
  text: string,
  requiredKeys: string[],
): Record<string, unknown> {
  const cleaned = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) {
    throw new Error(`Could not find JSON in model output: ${text.slice(0, 200)}`);
  }
  const obj = JSON.parse(match[0]) as Record<string, unknown>;
  for (const k of requiredKeys) {
    if (obj[k] == null || obj[k] === "") {
      throw new Error(
        `Model output missing required key "${k}": ${text.slice(0, 200)}`,
      );
    }
  }
  return obj;
}

// Quick lint of the hard rules. Returns the list of violations so we can flag
// the row for human review (rather than rejecting the draft outright — most
// violations are minor and a human can still send the message).
export function validateEmail(d: DraftedEmail): {
  ok: boolean;
  violations: string[];
} {
  return lintContent(`${d.subject}\n${d.body}`, {
    minSubjectWords: 3,
    maxSubjectWords: 8,
    subject: d.subject,
  });
}

export function validateVoicemail(d: DraftedVoicemail): {
  ok: boolean;
  violations: string[];
} {
  return lintContent(d.script, {});
}

export function validateSms(d: DraftedSms): {
  ok: boolean;
  violations: string[];
} {
  const v = lintContent(d.text, {});
  if (d.text.length > 160) {
    v.violations.push(`SMS over 160 chars: ${d.text.length}`);
    v.ok = false;
  }
  return v;
}

function lintContent(
  text: string,
  opts: {
    minSubjectWords?: number;
    maxSubjectWords?: number;
    subject?: string;
  },
): { ok: boolean; violations: string[] } {
  const violations: string[] = [];
  if (/—/.test(text)) violations.push("Contains em dash (—)");

  // The full banned-phrase list from prompt.ts (kept here so the linter
  // doesn't depend on the prompt module's internal constants).
  const banned = [
    "I hope this email finds you well",
    "revolutionize",
    "unlock",
    "game changer",
    "circle back",
    "touch base",
    "leverage",
    "synergies",
    "just checking in",
    "wanted to reach out",
    "thought leader",
    "powerful platform",
    "one stop shop",
    "robust",
    "innovative",
    "cutting-edge",
    "valuable",
    "best-in-class",
    "transform",
    "streamline",
    "world-class",
    "industry-leading",
  ];
  const haystack = text.toLowerCase();
  for (const phrase of banned) {
    if (haystack.includes(phrase.toLowerCase())) {
      violations.push(`Banned phrase: "${phrase}"`);
    }
  }

  // Banned opener patterns — check the first ~40 chars of the body.
  const head = text.replace(/^Hi\s+[^,]+,\s*/i, "").slice(0, 60).toLowerCase();
  const bannedOpeners = [
    "i noticed",
    "i came across",
    "i wanted to reach out",
    "i was researching",
    "i was reviewing",
    "i was looking at",
    "hope you're well",
    "hope this finds you",
    "quick question",
    "my name is",
    "i work with companies",
  ];
  for (const opener of bannedOpeners) {
    if (head.startsWith(opener)) {
      violations.push(`Banned opener: "${opener}..."`);
      break;
    }
  }

  if (opts.subject != null && opts.minSubjectWords && opts.maxSubjectWords) {
    const words = opts.subject.trim().split(/\s+/).length;
    if (words < opts.minSubjectWords || words > opts.maxSubjectWords) {
      violations.push(`Subject word count out of band: ${words}`);
    }
  }
  return { ok: violations.length === 0, violations };
}

// Re-export the legacy types for any importer that hasn't migrated yet.
export type { EmailInput };
export { EMAIL_SYSTEM_PROMPT, buildUserPrompt };
