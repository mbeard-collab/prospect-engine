export type FitTier =
  | "tier_1"
  | "tier_2"
  | "tier_3"
  | "low_fit"
  | "needs_review"
  | "excluded";

export type RunStatus = "pending" | "running" | "complete" | "failed";

export type Company = {
  id: string;
  name_normalized: string;
  display_name: string;
  clean_name: string | null;
  website: string | null;
  industry_guess: string | null;
  fit_score: number | null;
  fit_tier: FitTier | null;
  score_breakdown: string | null;
  primary_value_driver: string | null;
  exclude_flag: boolean;
  exclude_reason: string | null;
  last_web_scored_at: string | null;
  created_at: string;
};

export type Run = {
  id: string;
  user_id: string;
  name: string;
  csv_filename: string | null;
  total_accounts: number;
  excluded_count: number;
  ready_count: number;
  status: RunStatus;
  created_at: string;
};

export type RunAccount = {
  id: string;
  run_id: string;
  company_id: string;
  alphabet_group: string | null;
  territory_rank: number | null;
  score_snapshot: number | null;
  tier_snapshot: FitTier | null;
  email_subject: string | null;
  email_body: string | null;
  research_confidence: string | null;
  needs_human_review: boolean;
};
