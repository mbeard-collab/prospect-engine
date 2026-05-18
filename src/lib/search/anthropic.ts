import "server-only";
import type { SearchProvider, SearchResult } from "./types";

// Search provider backed by Anthropic's server-side web_search tool. We send
// one Claude message per query asking the model to invoke web_search exactly
// once and return the top N results as raw JSON — Claude is acting as a
// search proxy here, not as a scorer or summarizer. The deterministic
// 100-point rubric (see src/lib/scoring/rubric.ts) still runs in code on the
// snippets, so we keep zero LLM tokens in the scoring decision itself.
//
// Replaces Brave Search, which capped at $5/mo on the free tier. With the
// app's unlimited Anthropic quota, ~$0.01/query trades cleanly for "no quota
// cap, faster index, no 1 rps rate limit."

const ANTHROPIC_ENDPOINT = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-sonnet-4-6";
const MAX_TOKENS = 1500;

const SYSTEM_PROMPT = `You are a SEARCH PROXY. Your only job is to invoke web_search ONCE with the user-provided query and return the raw top results.

DO NOT analyze, summarize, or filter the results.
DO NOT add commentary.
DO NOT issue more than one search call.

After your single web_search call, output ONLY this JSON, nothing else:
{
  "results": [
    { "title": "exact title from result", "url": "exact url from result", "description": "the snippet text from the result" }
  ]
}

If the search returns nothing useful, return {"results": []}.`;

type AnthropicContentBlock =
  | { type: "text"; text: string }
  | { type: string };

type AnthropicResponse = {
  type?: "error" | "message";
  error?: { type: string; message: string };
  content?: AnthropicContentBlock[];
  usage?: { input_tokens?: number; output_tokens?: number };
};

function parseResultsJson(text: string, max: number): SearchResult[] {
  if (!text) return [];
  const cleaned = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) return [];
  let obj: { results?: unknown };
  try {
    obj = JSON.parse(match[0]);
  } catch {
    return [];
  }
  if (!Array.isArray(obj.results)) return [];
  const out: SearchResult[] = [];
  for (const raw of obj.results) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const title = typeof r.title === "string" ? r.title.trim() : "";
    const url = typeof r.url === "string" ? r.url.trim() : "";
    const description =
      typeof r.description === "string" ? r.description.trim() : "";
    if (!title && !url && !description) continue;
    out.push({ title, url, description });
    if (out.length >= max) break;
  }
  return out;
}

export function createAnthropicSearchProvider(args: {
  anthropicKey: string;
}): SearchProvider {
  return {
    name: "anthropic-web-search",
    async search(query, opts): Promise<SearchResult[]> {
      const count = Math.max(1, Math.min(10, opts?.count ?? 3));
      const body = {
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: `Search: ${query}\n\nReturn the top ${count} results.`,
          },
        ],
        tools: [
          {
            type: "web_search_20250305",
            name: "web_search",
            max_uses: 1,
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
          `Anthropic search HTTP ${res.status}: ${text.slice(0, 300)}`,
        );
      }
      const data = JSON.parse(text) as AnthropicResponse;
      if (data.type === "error") {
        throw new Error(
          `Anthropic search error: ${data.error?.type} - ${data.error?.message}`,
        );
      }

      const outText = (data.content ?? [])
        .map((b) => (b.type === "text" ? (b as { text: string }).text : ""))
        .join("")
        .trim();

      return parseResultsJson(outText, count);
    },
  };
}
