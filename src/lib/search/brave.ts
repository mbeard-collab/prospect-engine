import "server-only";
import type { SearchProvider, SearchResult } from "./types";

// https://api-dashboard.search.brave.com/app/documentation/web-search/get-started
const BRAVE_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";

type BraveRawResult = {
  title?: string;
  url?: string;
  description?: string;
};

type BraveResponse = {
  web?: { results?: BraveRawResult[] };
};

export function createBraveProvider(apiKey: string): SearchProvider {
  return {
    name: "brave",
    async search(query, { count = 3 } = {}): Promise<SearchResult[]> {
      const url = new URL(BRAVE_ENDPOINT);
      url.searchParams.set("q", query);
      url.searchParams.set("count", String(count));

      const res = await fetch(url, {
        headers: {
          Accept: "application/json",
          "X-Subscription-Token": apiKey,
        },
        // Brave's free tier is 1 rps; the caller controls concurrency.
        cache: "no-store",
      });

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(
          `Brave Search HTTP ${res.status}: ${body.slice(0, 200)}`,
        );
      }

      const data = (await res.json()) as BraveResponse;
      const results = data.web?.results ?? [];
      return results.slice(0, count).map((r) => ({
        title: r.title ?? "",
        url: r.url ?? "",
        description: r.description ?? "",
      }));
    },
  };
}
