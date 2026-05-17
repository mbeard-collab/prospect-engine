import "server-only";
import type { ContactProvider } from "./types";

// Real ZoomInfo integration is non-trivial (token exchange, paginated search,
// title-filter syntax). Scaffolded here as a stub — when the user has the API
// key + docs, swap the mock implementation in src/lib/enrichment/index.ts to
// route through this. For now the production wiring isn't built; mock data
// covers the demo flow.
export function createZoomInfoProvider(apiKey: string): ContactProvider {
  void apiKey;
  return {
    name: "zoominfo",
    async fetchContacts() {
      throw new Error(
        "ZoomInfo client not yet implemented — set BRAVE_API_KEY pattern when you have ZoomInfo API docs",
      );
    },
  };
}
