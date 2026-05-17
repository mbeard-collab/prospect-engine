-- Mirror of the Stage 3 fix: track whether Stage 4 was attempted on a given
-- run_account. Prevents the AutoPipelineRunner loop from getting stuck when a
-- prospect has no cached contact (so email drafting can't happen) — every
-- attempt marks the row, success or failure.
alter table public.run_accounts add column if not exists stage4_attempted_at timestamptz;
