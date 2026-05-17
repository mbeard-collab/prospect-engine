import { Badge } from "@/components/ui/badge";
import type { FitTier } from "@/lib/types";

const LABEL: Record<FitTier, string> = {
  tier_1: "Tier 1",
  tier_2: "Tier 2",
  tier_3: "Tier 3",
  low_fit: "Low Fit",
  needs_review: "Needs Review",
  excluded: "Excluded",
};

const CLASS: Record<FitTier, string> = {
  tier_1:
    "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-300",
  tier_2:
    "border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-900 dark:bg-blue-950 dark:text-blue-300",
  tier_3:
    "border-zinc-200 bg-zinc-50 text-zinc-700 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-300",
  low_fit:
    "border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300",
  needs_review:
    "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300",
  excluded:
    "border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300",
};

export function TierBadge({ tier }: { tier: FitTier | null }) {
  if (!tier) {
    return <Badge variant="outline">—</Badge>;
  }
  return (
    <Badge variant="outline" className={CLASS[tier]}>
      {LABEL[tier]}
    </Badge>
  );
}
