// Map a score breakdown to a primary value driver phrase.
// Source list: ~/Downloads/GovSpend_Prospecting_Files/govspend-prospecting/references/01-icp-scoring.md
//
// Picking by absolute-highest bucket means SLED (worth 30) almost always wins,
// flattening the value-driver column. Instead, decide by which signals fire,
// most-discriminating first, so the driver actually varies across rows.

import type { ScoreBreakdown } from "./rubric";

export const VALUE_DRIVERS = [
  "Find agencies already buying similar products",
  "Track competitor contracts and renewal timing",
  "Identify open bids earlier",
  "Expand into new states, agencies, departments",
  "Find warm agency targets based on spend history",
  "Understand incumbent vendors and buying cycles",
  "Prioritize outreach based on real public sector demand",
  "Identify agencies already spending with competitors",
  "Build a smarter territory plan from agency buying behavior",
] as const;

export type ValueDriver = (typeof VALUE_DRIVERS)[number];

export function pickValueDriver(b: ScoreBreakdown): ValueDriver {
  // Competitive context is the most specific signal: G2 / Capterra / "alternatives"
  // means the company is in a contested SaaS category — talk renewal timing.
  if (b.competitive > 0) {
    return "Track competitor contracts and renewal timing";
  }
  // Visible gov sales motion (GSA, capture team) → they want pipeline. Lead with bids.
  if (b.govMotion > 0) {
    return "Identify open bids earlier";
  }
  // Multi-state presence and no gov-motion → geographic expansion play.
  if (b.multiState >= 15) {
    return "Expand into new states, agencies, departments";
  }
  // SLED evidence + clear product category → well-fit, already selling to gov.
  if (b.sled > 0 && b.productCategory > 0) {
    return "Find agencies already buying similar products";
  }
  // Right product category, no visible gov customers yet → demand-prioritization angle.
  if (b.productCategory > 0) {
    return "Prioritize outreach based on real public sector demand";
  }
  // Has gov customers but rest is thin → warm-agency angle.
  if (b.sled > 0) {
    return "Find warm agency targets based on spend history";
  }
  // Clear product category only → incumbent / buying-cycle angle.
  if (b.clearCategory > 0) {
    return "Understand incumbent vendors and buying cycles";
  }
  return "Build a smarter territory plan from agency buying behavior";
}
