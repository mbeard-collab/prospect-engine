import "server-only";
import { createBraveProvider } from "./brave";
import { createMockProvider } from "./mock";
import type { SearchProvider } from "./types";

export type { SearchProvider, SearchResult } from "./types";

let cached: SearchProvider | null = null;

export function getSearchProvider(): SearchProvider {
  if (cached) return cached;
  const key = process.env.BRAVE_API_KEY?.trim();
  cached = key ? createBraveProvider(key) : createMockProvider();
  return cached;
}
