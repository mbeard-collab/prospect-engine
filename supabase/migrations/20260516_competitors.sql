-- Stage 2.5: competitor research cached on the companies table. Competitor
-- lists rarely change company-to-company, so we share the cache across runs
-- (similar to last_web_scored_at on the same table). 90-day TTL matches the
-- web-scoring cache.
--
-- Shape:
--   competitors: { "names": ["CompA", "CompB", "CompC"], "note": "short
--                  explanation of the competitive landscape" }
--   competitors_fetched_at: timestamp of last research attempt (sets even on
--   empty results so we don't re-attempt within the TTL window).
alter table public.companies add column if not exists competitors jsonb;
alter table public.companies add column if not exists competitors_fetched_at timestamptz;
