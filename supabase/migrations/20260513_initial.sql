-- Prospect Engine — initial schema.
-- Paste this into the Supabase SQL editor and run it. Idempotent on a fresh project.

-- ───────────────────────── companies ─────────────────────────
create table if not exists public.companies (
  id uuid primary key default gen_random_uuid(),
  name_normalized text not null unique,
  display_name text not null,
  clean_name text,
  website text,
  industry_guess text,
  fit_score int,
  fit_tier text check (fit_tier in ('tier_1','tier_2','tier_3','low_fit','needs_review','excluded')),
  score_breakdown text,
  primary_value_driver text,
  exclude_flag boolean not null default false,
  exclude_reason text,
  last_web_scored_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists companies_website_idx on public.companies(website);

-- ───────────────────────── contacts ─────────────────────────
create table if not exists public.contacts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  name text,
  title text,
  email text,
  linkedin text,
  tier text check (tier in ('exec','manager','ic')),
  source text,
  fetched_at timestamptz not null default now()
);
create index if not exists contacts_company_idx on public.contacts(company_id);

-- ───────────────────────── signals ─────────────────────────
create table if not exists public.signals (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  type text check (type in ('open_bid','expiring_contract','po_breadcrumb','meeting','spend_pattern')),
  agency_name text,
  agency_state text,
  vendor_name text,
  summary text,
  source_link text,
  signal_date date,
  fetched_at timestamptz not null default now()
);
create index if not exists signals_company_idx on public.signals(company_id);

-- ───────────────────────── runs ─────────────────────────
create table if not exists public.runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  csv_filename text,
  total_accounts int not null default 0,
  excluded_count int not null default 0,
  ready_count int not null default 0,
  status text not null check (status in ('pending','running','complete','failed')) default 'pending',
  created_at timestamptz not null default now()
);
create index if not exists runs_user_idx on public.runs(user_id, created_at desc);

-- ───────────────────────── run_accounts ─────────────────────────
create table if not exists public.run_accounts (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.runs(id) on delete cascade,
  company_id uuid not null references public.companies(id),
  alphabet_group text,
  territory_rank int,
  score_snapshot int,
  tier_snapshot text,
  email_subject text,
  email_body text,
  research_confidence text,
  needs_human_review boolean not null default false
);
create index if not exists run_accounts_run_idx on public.run_accounts(run_id);
create index if not exists run_accounts_company_idx on public.run_accounts(company_id);

-- ───────────────────────── usage_log ─────────────────────────
create table if not exists public.usage_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete set null,
  action text not null,
  tokens_in int,
  tokens_out int,
  dollar_estimate numeric(10,4),
  created_at timestamptz not null default now()
);

-- ───────────────────────── RLS ─────────────────────────
alter table public.companies enable row level security;
alter table public.contacts enable row level security;
alter table public.signals enable row level security;
alter table public.runs enable row level security;
alter table public.run_accounts enable row level security;
alter table public.usage_log enable row level security;

-- Shared cache tables: any authenticated user can read/write
drop policy if exists "companies read" on public.companies;
create policy "companies read" on public.companies for select to authenticated using (true);
drop policy if exists "companies write" on public.companies;
create policy "companies write" on public.companies for insert to authenticated with check (true);
drop policy if exists "companies update" on public.companies;
create policy "companies update" on public.companies for update to authenticated using (true);

drop policy if exists "contacts read" on public.contacts;
create policy "contacts read" on public.contacts for select to authenticated using (true);
drop policy if exists "contacts write" on public.contacts;
create policy "contacts write" on public.contacts for insert to authenticated with check (true);

drop policy if exists "signals read" on public.signals;
create policy "signals read" on public.signals for select to authenticated using (true);
drop policy if exists "signals write" on public.signals;
create policy "signals write" on public.signals for insert to authenticated with check (true);

-- User-owned tables
drop policy if exists "runs read own" on public.runs;
create policy "runs read own" on public.runs for select to authenticated using (user_id = auth.uid());
drop policy if exists "runs insert own" on public.runs;
create policy "runs insert own" on public.runs for insert to authenticated with check (user_id = auth.uid());
drop policy if exists "runs update own" on public.runs;
create policy "runs update own" on public.runs for update to authenticated using (user_id = auth.uid());

drop policy if exists "run_accounts read own" on public.run_accounts;
create policy "run_accounts read own" on public.run_accounts for select to authenticated
  using (exists (select 1 from public.runs r where r.id = run_accounts.run_id and r.user_id = auth.uid()));
drop policy if exists "run_accounts insert own" on public.run_accounts;
create policy "run_accounts insert own" on public.run_accounts for insert to authenticated
  with check (exists (select 1 from public.runs r where r.id = run_accounts.run_id and r.user_id = auth.uid()));
drop policy if exists "run_accounts update own" on public.run_accounts;
create policy "run_accounts update own" on public.run_accounts for update to authenticated
  using (exists (select 1 from public.runs r where r.id = run_accounts.run_id and r.user_id = auth.uid()));

drop policy if exists "usage read own" on public.usage_log;
create policy "usage read own" on public.usage_log for select to authenticated using (user_id = auth.uid());
drop policy if exists "usage insert own" on public.usage_log;
create policy "usage insert own" on public.usage_log for insert to authenticated with check (user_id = auth.uid());
