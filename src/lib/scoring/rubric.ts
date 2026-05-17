// Stage 2: 100-point fit scoring rubric.
// Specification: ~/Downloads/GovSpend_Prospecting_Files/govspend-prospecting/references/01-icp-scoring.md
//
// All scoring is keyword detection on concatenated public-web snippets — no
// LLM tokens are spent here.

import type { SearchResult } from "@/lib/search";
import type { FitTier } from "@/lib/types";

export type ScoreBreakdown = {
  sled: number;          // 30 — public-sector marketing evidence
  productCategory: number; // 20 — product type agencies buy
  multiState: number;    // 15 — multi-state / nationwide presence
  govMotion: number;     // 15 — visible government sales motion
  competitive: number;   // 10 — competitive context visible
  clearCategory: number; // 10 — clear product category
  total: number;
};

export type RubricResult = {
  score: number;
  breakdown: ScoreBreakdown;
  breakdownString: string;
  tier: FitTier;
  needsReview: boolean;
};

// ── Keyword detectors ─────────────────────────────────────────────────────

const SLED_RE =
  /\b(public sector|government|gov(?:ernment)? agencies?|sled|state and local|federal agency|city of [a-z]+|county of [a-z]+|state of [a-z]+|department of (?:transportation|education|health|public safety|defense)|municipalit(?:y|ies)|school district|public agenc(?:y|ies))\b/i;

const PRODUCT_CATEGORY_RE =
  /\b((software|platform|equipment|services|solution)s?\s+for\s+(?:public|government|government agencies|state and local|municipal|education|public safety|transit|utilities)|public safety|transit\s+tech|civic engagement|gis|gov\s?tech|education tech|ed[- ]?tech|smart cit(?:y|ies))\b/i;

const STATE_NAME_RE =
  /\b(Alabama|Alaska|Arizona|Arkansas|California|Colorado|Connecticut|Delaware|Florida|Georgia|Hawaii|Idaho|Illinois|Indiana|Iowa|Kansas|Kentucky|Louisiana|Maine|Maryland|Massachusetts|Michigan|Minnesota|Mississippi|Missouri|Montana|Nebraska|Nevada|New Hampshire|New Jersey|New Mexico|New York|North Carolina|North Dakota|Ohio|Oklahoma|Oregon|Pennsylvania|Rhode Island|South Carolina|South Dakota|Tennessee|Texas|Utah|Vermont|Virginia|Washington|West Virginia|Wisconsin|Wyoming)\b/g;
const MULTI_STATE_HINTS_RE =
  /\b(nationwide|multiple\s+(?:offices|locations|states)|coast[- ]to[- ]coast|all\s+50\s+states|across\s+the\s+united states|customers in (?:multiple|several) states)\b/i;

const GOV_MOTION_RE =
  /\b(gsa\s+(?:schedule|contract)?|cooperative purchasing|government landing page|public sector sales|capture team|capture management|proposal team|public sector account executive|public sector sales contact|gov(?:ernment)?\s+marketplace|sled\s+(?:sales|team))\b/i;

const COMPETITIVE_RE =
  /\b(alternatives?\s+to|compared\s+to|vs\.?\s+\w+|g2|capterra|trustradius|gartner\s+(?:magic\s+quadrant|peer insights)|competitor|comparison page|alternative software)\b/i;

const CLEAR_CATEGORY_HINTS_RE =
  /\b(software|saas|cloud|platform|application|tool|equipment|hardware|service|service\s+provider|consulting|integrator|reseller|product)\b/i;

// ── Scoring ──────────────────────────────────────────────────────────────

function buildScoringText(results: SearchResult[]): string {
  return results
    .flatMap((r) => [r.title, r.url, r.description])
    .filter(Boolean)
    .join("\n");
}

export function scoreFromSearch(
  companyName: string,
  results: SearchResult[],
): RubricResult {
  const text = buildScoringText(results);

  const sled = SLED_RE.test(text) ? 30 : 0;
  const productCategory = PRODUCT_CATEGORY_RE.test(text) ? 20 : 0;

  const stateMatches = text.match(STATE_NAME_RE)?.length ?? 0;
  const multiState =
    MULTI_STATE_HINTS_RE.test(text) || stateMatches > 3 ? 15 : 0;

  const govMotion = GOV_MOTION_RE.test(text) ? 15 : 0;
  const competitive = COMPETITIVE_RE.test(text) ? 10 : 0;

  // Clear category triggers if any of the category-suggestive terms appear
  // anywhere, or any of the higher-tier categories already fired.
  const clearCategory =
    productCategory > 0 || CLEAR_CATEGORY_HINTS_RE.test(text) ? 10 : 0;

  const total = sled + productCategory + multiState + govMotion + competitive + clearCategory;

  const breakdown: ScoreBreakdown = {
    sled,
    productCategory,
    multiState,
    govMotion,
    competitive,
    clearCategory,
    total,
  };

  const breakdownString = `${sled}/${productCategory}/${multiState}/${govMotion}/${competitive}/${clearCategory} = ${total}`;

  // Skepticism rule from 01-icp-scoring.md: if the web search returned little
  // (no SLED evidence AND no clear product category AND no gov motion), mark
  // Needs Review rather than guessing high.
  const needsReview =
    results.length === 0 ||
    (sled === 0 && productCategory === 0 && govMotion === 0);

  let tier: FitTier;
  if (needsReview) tier = "needs_review";
  else if (total >= 85) tier = "tier_1";
  else if (total >= 70) tier = "tier_2";
  else if (total >= 50) tier = "tier_3";
  else tier = "low_fit";

  // Trace which company this is for in dev logs without exposing PII.
  void companyName;

  return { score: total, breakdown, breakdownString, tier, needsReview };
}
