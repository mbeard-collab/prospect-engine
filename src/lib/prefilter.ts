// Stage 1 keyword pre-filter. Ported from
// ~/Downloads/GovSpend_Prospecting_Files/prefilter.html and govspend_prefilter.py.

export type IndustryCategory =
  | "Construction"
  | "Engineering"
  | "Financial Services"
  | "Local Trade"
  | "Real Estate"
  | "Law Firm"
  | "Hyperlocal Service";

export type PrefilterResult =
  | { excluded: true; category: IndustryCategory; reason: string }
  | { excluded: false };

const EXCLUSION_PATTERNS: ReadonlyArray<{
  category: IndustryCategory;
  reason: string;
  pattern: RegExp;
}> = [
  {
    category: "Construction",
    reason: "Construction firm",
    pattern:
      /\b(construction|builders?|contractors?|general contractor|concrete|excavation|paving|masonry|drywall)\b/i,
  },
  {
    category: "Financial Services",
    reason: "Financial services firm",
    pattern:
      /\b(bank|bancorp|credit union|financial services|wealth management|capital management|investment management|insurance agency|brokerage)\b/i,
  },
  {
    category: "Local Trade",
    reason: "Local trade service",
    pattern:
      /\b(plumbing|hvac|roofing|landscaping|pest control|janitorial|cleaning services|lawn care)\b/i,
  },
  {
    category: "Real Estate",
    reason: "Real estate firm",
    pattern: /\b(realty|real estate|realtors?|property management)\b/i,
  },
  {
    category: "Law Firm",
    reason: "Law firm",
    pattern: /\b(law firm|attorneys at law|law offices)\b/i,
  },
  {
    category: "Hyperlocal Service",
    reason: "Local service business",
    pattern: /\b(dental|chiropractic|veterinary|dentistry|orthodontics)\b/i,
  },
];

// Engineering is handled separately: only exclude if the name contains
// "engineering" or "engineers" AND no tech term appears anywhere in the name.
const ENGINEERING_RE = /\b(engineering|engineers)\b/i;
const ENGINEERING_TECH_OVERRIDE_RE =
  /\b(software|saas|cloud|cyber|ai|technology|platform|tech|systems|data|analytics|robotics|automation)\b/i;

const SUFFIX_STRIP_RE =
  /\s*,?\s*(inc|incorporated|llc|l\.l\.c\.|corp|corporation|co|company|ltd|limited|lp|llp|p\.c\.|pc)\.?\s*$/i;

export function checkExclusion(name: string): PrefilterResult {
  if (!name) return { excluded: false };
  for (const { category, reason, pattern } of EXCLUSION_PATTERNS) {
    if (pattern.test(name)) {
      return { excluded: true, category, reason };
    }
  }
  if (ENGINEERING_RE.test(name) && !ENGINEERING_TECH_OVERRIDE_RE.test(name)) {
    return { excluded: true, category: "Engineering", reason: "Engineering firm" };
  }
  return { excluded: false };
}

export function cleanCompanyName(name: string): string {
  if (!name) return name;
  return name.trim().replace(SUFFIX_STRIP_RE, "").trim();
}

// Normalize for the companies cache key — lowercase, suffix-stripped, collapsed whitespace.
export function normalizeCompanyName(name: string): string {
  return cleanCompanyName(name).toLowerCase().replace(/\s+/g, " ").trim();
}
