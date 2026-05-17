-- Track whether Stage 3 enrichment was attempted on a given run_account.
-- Without this, prospects where ZoomInfo finds no name match or Spark MCP
-- returns "no signal" sit in an infinite retry loop because the batch logic
-- considers them "still needs work."
alter table public.run_accounts add column if not exists stage3_attempted_at timestamptz;
