import type { SearchProvider, SearchResult } from "./types";

// Deterministic mock search results, so the same company name always scores the
// same way during demos. Designed to hit a realistic mix of tiers when run
// against a typical SDR territory CSV.

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const TIER_1_VERY_LIKELY = [
  "tyler", "granicus", "opengov", "civicplus", "esri", "motorola",
  "axon", "accela", "tritech", "nic ", "neogov", "courtroom",
];
const TIER_2_LIKELY = [
  "software", "platform", "saas", "cloud", "systems", "analytics",
  "data", "ai", "tech",
];

export function createMockProvider(): SearchProvider {
  return {
    name: "mock",
    async search(query): Promise<SearchResult[]> {
      const q = query.toLowerCase();
      const seed = hash(q);

      let snippets: string[];
      const isTier1 = TIER_1_VERY_LIKELY.some((k) => q.includes(k));
      const isTier2 =
        !isTier1 && TIER_2_LIKELY.some((k) => q.includes(k));
      const isLow = seed % 7 === 0;

      if (isTier1) {
        snippets = [
          `Government and public sector customers including state agencies and municipalities across the United States. GSA Schedule contractor with a dedicated public sector sales team and capture team.`,
          `Case studies from public safety, transit, utilities, and education customers. Featured on G2 and Capterra in the government software category.`,
          `Nationwide implementations across multiple states, with case studies highlighting agency clients and competitive alternatives.`,
        ];
      } else if (isTier2) {
        snippets = [
          `Software platform serving enterprise customers in multiple industries. Some public agency case studies available.`,
          `Cloud-based systems used by organizations including a few state and local government clients. G2 reviews mention public sector deployments.`,
          `Multi-state customer base with offices in several cities; product category is software for operational data analytics.`,
        ];
      } else if (isLow) {
        snippets = [
          `Local services for residential and commercial customers in the surrounding metro area.`,
          `Family-owned business serving the community since 1987.`,
          `Contact our team for a free quote on your next project.`,
        ];
      } else {
        snippets = [
          `Enterprise software vendor with customers across several industries. Some mention of state agency clients in older press releases.`,
          `Product comparison and alternatives on G2 in the data and analytics category.`,
          `Headquartered in California with offices in Texas, New York, and Washington.`,
        ];
      }

      return snippets.map((s, i) => ({
        title: `${query.split(" ")[0]} — result ${i + 1}`,
        url: `https://example.com/${seed.toString(36)}-${i}`,
        description: s,
      }));
    },
  };
}
