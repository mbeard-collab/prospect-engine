import "server-only";
import { createAnthropicSearchProvider } from "./anthropic";
import { createMockProvider } from "./mock";
import type { SearchProvider } from "./types";

export type { SearchProvider, SearchResult } from "./types";

let cached: SearchProvider | null = null;

export function getSearchProvider(): SearchProvider {
  if (cached) return cached;
  const anthropicKey = process.env.PROSPECT_ANTHROPIC_KEY?.trim();
  cached = anthropicKey
    ? createAnthropicSearchProvider({ anthropicKey })
    : createMockProvider();
  return cached;
}
