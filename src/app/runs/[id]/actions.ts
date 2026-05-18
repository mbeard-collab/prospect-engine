"use server";

import { revalidatePath } from "next/cache";
import { verifySession } from "@/lib/dal";
import { getSearchProvider } from "@/lib/search";
import { scoreFromSearch } from "@/lib/scoring/rubric";
import { pickValueDriver } from "@/lib/scoring/value-driver";
import {
  getCompetitorProvider,
  getContactProvider,
  getSignalProvider,
} from "@/lib/enrichment";
import {
  applyTailoring,
  tailorContacts,
} from "@/lib/enrichment/contact-tailoring";
import {
  draftEmail,
  draftVoicemail,
  draftSms,
  validateEmail,
  validateVoicemail,
  validateSms,
} from "@/lib/email/anthropic";
import type { ContactTier, DraftInput } from "@/lib/email/prompt";

// Stage 2 batch size: 3 (Anthropic web_search has no per-second cap; the only
// throttle is the Anthropic API rate limit which is way above 3 rps).
// Stage 3 batch size: 3 (run 3 enrichments in parallel — see CONCURRENCY).
//   Trade-off: progress bar advances in chunks of 3 instead of per item.
//   With Anthropic web_search taking 10-20 sec per call, parallelism is
//   essential — sequential would be ~20 min for a 77-row CSV.
const BATCH_SIZE = 3;
const STAGE3_BATCH_SIZE = 3;
const CACHE_TTL_DAYS = 90;
const CONTACTS_TTL_DAYS = 30;
const SIGNALS_TTL_DAYS = 7;
// Competitor lists rarely change company-to-company, so we hold them as long
// as Stage 2 fit scores (the other web-grounded fact about a company).
const COMPETITORS_TTL_DAYS = 90;
const STAGE25_BATCH_SIZE = 3;
const STAGE25_CONCURRENCY = 3;
// Which Stage 2 tiers get Stage 3 enrichment + Stage 4 email drafting.
// Originally Tier 1/2 only; expanded to include Tier 3 since unlimited ZoomInfo
// credits make the cost ceiling unimportant and more shots on goal beat
// hyper-narrow scope. Excludes Low Fit (rubric said no) and Needs Review
// (rubric said evidence was too thin to score confidently).
const ENRICHMENT_TIERS = ["tier_1", "tier_2", "tier_3"] as const;
const CONCURRENCY = 3;

type AccountRow = {
  id: string;
  company_id: string;
  companies: {
    id: string;
    name_normalized: string;
    display_name: string;
    fit_score: number | null;
    fit_tier: string | null;
    score_breakdown: string | null;
    primary_value_driver: string | null;
    last_web_scored_at: string | null;
  };
};

export type Stage2Result = {
  processed: number;
  remaining: number;
  total: number;
  errors: Array<{ company: string; message: string }>;
  currentCompany?: string | null;
};

export async function runStage2Batch(runId: string): Promise<Stage2Result> {
  const { supabase } = await verifySession();

  // Verify the run belongs to this user (RLS would block anyway, but throw a
  // clear error before we waste API calls).
  const { data: run, error: runErr } = await supabase
    .from("runs")
    .select("id, status")
    .eq("id", runId)
    .maybeSingle();
  if (runErr || !run) throw new Error("Run not found");

  // Pull all unprocessed, non-excluded run_accounts for this run.
  const { data: allRows, error: rowsErr } = await supabase
    .from("run_accounts")
    .select(
      "id, company_id, tier_snapshot, companies(id, name_normalized, display_name, fit_score, fit_tier, score_breakdown, primary_value_driver, last_web_scored_at)",
    )
    .eq("run_id", runId)
    .order("territory_rank", { ascending: true });
  if (rowsErr) throw new Error(`Load accounts: ${rowsErr.message}`);

  const unprocessed = (allRows ?? []).filter(
    (r) =>
      r.tier_snapshot === null,
  ) as unknown as AccountRow[];

  const total = unprocessed.length;
  if (total === 0) {
    return { processed: 0, remaining: 0, total: 0, errors: [], currentCompany: null };
  }

  const batch = unprocessed.slice(0, BATCH_SIZE);
  const currentCompany = batch[0]?.companies?.display_name ?? null;
  const provider = getSearchProvider();
  // "Real" search provider = anything that's not the mock. With Brave gone,
  // this is true whenever a Anthropic key is configured.
  const usingRealApi = provider.name !== "mock";
  const errors: Stage2Result["errors"] = [];

  // Mark the run as running while we work.
  await supabase.from("runs").update({ status: "running" }).eq("id", runId);

  for (let i = 0; i < batch.length; i += CONCURRENCY) {
    const chunk = batch.slice(i, i + CONCURRENCY);
    await Promise.all(
      chunk.map(async (account) => {
        try {
          await processAccount(supabase, account, usingRealApi);
        } catch (e) {
          errors.push({
            company: account.companies.display_name,
            message: e instanceof Error ? e.message : String(e),
          });
        }
      }),
    );
  }

  // Stage 1 already set total/excluded/ready; we don't change those on Stage 2.
  // Mark run complete if everything is processed.
  const remaining = total - batch.length;
  if (remaining === 0) {
    await supabase.from("runs").update({ status: "complete" }).eq("id", runId);
  }

  revalidatePath(`/runs/${runId}`);
  revalidatePath("/runs");
  return { processed: batch.length, remaining, total, errors, currentCompany };
}

async function processAccount(
  supabase: Awaited<ReturnType<typeof verifySession>>["supabase"],
  account: AccountRow,
  usingRealApi: boolean,
) {
  const c = account.companies;

  // Cache hit? If the company was scored within TTL and has a tier, reuse it.
  const cacheFresh =
    c.last_web_scored_at !== null &&
    Date.now() - new Date(c.last_web_scored_at).getTime() <
      CACHE_TTL_DAYS * 24 * 60 * 60 * 1000;

  if (cacheFresh && c.fit_tier && c.fit_score !== null) {
    await supabase
      .from("run_accounts")
      .update({
        score_snapshot: c.fit_score,
        tier_snapshot: c.fit_tier,
      })
      .eq("id", account.id);
    return;
  }

  // No cache — call the search provider.
  const provider = getSearchProvider();
  const query = `${c.display_name} government public sector customers`;
  const results = await provider.search(query, { count: 3 });

  const rubric = scoreFromSearch(c.display_name, results);
  const valueDriver = pickValueDriver(rubric.breakdown);

  // Update the shared company cache (only if we actually called external API).
  if (usingRealApi || !cacheFresh) {
    await supabase
      .from("companies")
      .update({
        fit_score: rubric.score,
        fit_tier: rubric.tier,
        score_breakdown: rubric.breakdownString,
        primary_value_driver: valueDriver,
        last_web_scored_at: new Date().toISOString(),
      })
      .eq("id", c.id);
  }

  // Snapshot onto this run's run_account.
  await supabase
    .from("run_accounts")
    .update({
      score_snapshot: rubric.score,
      tier_snapshot: rubric.tier,
      needs_human_review: rubric.needsReview,
    })
    .eq("id", account.id);
}

// ─────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
// Stage 2.5 — Competitor research
// For each enrichment-tier company (Tier 1/2/3) without fresh cached
// competitors, ask Anthropic (with the web_search tool) for three named
// competitors plus a one-line landscape note. Cached on companies, 90-day
// TTL — so re-running the same CSV is free for repeat companies.
//
// Distinct from Stage 3 because competitor research is web-grounded and
// company-level (not run-level). The user wanted it as its own visible step.

export type Stage25Result = {
  processed: number;
  remaining: number;
  total: number;
  errors: Array<{ company: string; message: string }>;
  currentCompany?: string | null;
};

type CompetitorRow = {
  id: string;
  company_id: string;
  tier_snapshot: string | null;
  companies: {
    id: string;
    display_name: string;
    website: string | null;
    industry_guess: string | null;
    primary_value_driver: string | null;
    competitors_fetched_at: string | null;
  };
};

export async function runStage25Batch(runId: string): Promise<Stage25Result> {
  const { supabase } = await verifySession();

  const { data: run, error: runErr } = await supabase
    .from("runs")
    .select("id, status")
    .eq("id", runId)
    .maybeSingle();
  if (runErr || !run) throw new Error("Run not found");

  const cutoff = new Date(
    Date.now() - COMPETITORS_TTL_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();

  // Enrichment-tier rows whose company has no fresh competitor cache. We
  // filter the cache check in the loop (not the SQL) so the query stays
  // simple, then drop rows whose companies are already fresh.
  const { data: rowsRaw, error: rowsErr } = await supabase
    .from("run_accounts")
    .select(
      "id, company_id, tier_snapshot, companies(id, display_name, website, industry_guess, primary_value_driver, competitors_fetched_at)",
    )
    .eq("run_id", runId)
    .in("tier_snapshot", ENRICHMENT_TIERS as unknown as string[]);
  if (rowsErr) throw new Error(`Load Stage 2.5 rows: ${rowsErr.message}`);
  const allRows = (rowsRaw ?? []) as unknown as CompetitorRow[];

  // De-dup by company_id (one CSV row per company, but defensive) and drop
  // companies that already have fresh competitor data.
  const seen = new Set<string>();
  const work: CompetitorRow[] = [];
  for (const r of allRows) {
    if (seen.has(r.company_id)) continue;
    seen.add(r.company_id);
    const cachedAt = r.companies.competitors_fetched_at;
    if (cachedAt && cachedAt >= cutoff) continue;
    work.push(r);
  }

  const total = work.length;
  if (total === 0) {
    return { processed: 0, remaining: 0, total: 0, errors: [], currentCompany: null };
  }

  const batch = work.slice(0, STAGE25_BATCH_SIZE);
  const currentCompany = batch[0]?.companies?.display_name ?? null;
  const provider = getCompetitorProvider();
  const errors: Stage25Result["errors"] = [];

  await supabase.from("runs").update({ status: "running" }).eq("id", runId);

  for (let i = 0; i < batch.length; i += STAGE25_CONCURRENCY) {
    const chunk = batch.slice(i, i + STAGE25_CONCURRENCY);
    await Promise.all(
      chunk.map(async (row) => {
        try {
          const out = await provider.fetchCompetitors({
            companyName: row.companies.display_name,
            website: row.companies.website,
            industryGuess: row.companies.industry_guess,
            primaryValueDriver: row.companies.primary_value_driver,
          });
          // Persist even an empty result so we don't re-attempt within the TTL.
          await supabase
            .from("companies")
            .update({
              competitors: out ?? { names: [], note: "" },
              competitors_fetched_at: new Date().toISOString(),
            })
            .eq("id", row.company_id);
        } catch (e) {
          console.error(
            `Stage 2.5 error for ${row.companies.display_name}:`,
            e,
          );
          errors.push({
            company: row.companies.display_name,
            message: e instanceof Error ? e.message : String(e),
          });
          // Still mark the fetch attempt so we don't loop forever on a
          // company that consistently 500s.
          await supabase
            .from("companies")
            .update({
              competitors_fetched_at: new Date().toISOString(),
            })
            .eq("id", row.company_id);
        }
      }),
    );
  }

  const remaining = total - batch.length;
  revalidatePath(`/runs/${runId}`);

  return {
    processed: batch.length,
    remaining,
    total,
    errors,
    currentCompany,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Stage 3 — Enrichment (contacts via ZoomInfo + signal via Spark)
// Enriches Tier 1 / Tier 2 / Tier 3 accounts (see ENRICHMENT_TIERS).

export type Stage3Result = {
  processed: number;
  remaining: number;
  total: number;
  errors: Array<{ company: string; message: string }>;
  currentCompany?: string | null;
};

type EnrichRow = {
  id: string;
  company_id: string;
  tier_snapshot: string | null;
  stage3_attempted_at: string | null;
  companies: {
    id: string;
    display_name: string;
    website: string | null;
    industry_guess: string | null;
    primary_value_driver: string | null;
  };
};

export async function runStage3Batch(runId: string): Promise<Stage3Result> {
  const { supabase } = await verifySession();

  const { data: run, error: runErr } = await supabase
    .from("runs")
    .select("id, status")
    .eq("id", runId)
    .maybeSingle();
  if (runErr || !run) throw new Error("Run not found");

  // Tier 1/2 accounts for this run that haven't been attempted yet.
  // Once we've attempted enrichment for a row (even with no data found),
  // stage3_attempted_at is set so we don't loop on it forever.
  const { data: tierRowsRaw, error: tierErr } = await supabase
    .from("run_accounts")
    .select(
      "id, company_id, tier_snapshot, stage3_attempted_at, companies(id, display_name, website, industry_guess, primary_value_driver)",
    )
    .eq("run_id", runId)
    .in("tier_snapshot", ENRICHMENT_TIERS as unknown as string[])
    .is("stage3_attempted_at", null);
  if (tierErr) throw new Error(`Load Tier 1/2 accounts: ${tierErr.message}`);
  const tierRows = (tierRowsRaw ?? []) as unknown as EnrichRow[];

  if (tierRows.length === 0) {
    return { processed: 0, remaining: 0, total: 0, errors: [] };
  }

  const companyIds = [...new Set(tierRows.map((r) => r.company_id))];
  const contactsCutoff = new Date(
    Date.now() - CONTACTS_TTL_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();
  const signalsCutoff = new Date(
    Date.now() - SIGNALS_TTL_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();

  const [{ data: freshContacts }, { data: freshSignals }] = await Promise.all([
    supabase
      .from("contacts")
      .select("company_id")
      .in("company_id", companyIds)
      .gte("fetched_at", contactsCutoff),
    supabase
      .from("signals")
      .select("company_id")
      .in("company_id", companyIds)
      .gte("fetched_at", signalsCutoff),
  ]);

  const haveContacts = new Set(
    (freshContacts ?? []).map((r) => r.company_id),
  );
  const haveSignal = new Set(
    (freshSignals ?? []).map((r) => r.company_id),
  );

  // tierRows already excludes rows that have stage3_attempted_at set, so we
  // never re-attempt enriched-or-failed prospects. Within those, take a batch.
  const total = tierRows.length;
  if (total === 0) {
    revalidatePath(`/runs/${runId}`);
    return { processed: 0, remaining: 0, total: 0, errors: [], currentCompany: null };
  }

  const batch = tierRows.slice(0, STAGE3_BATCH_SIZE);
  const currentCompany = batch[0]?.companies?.display_name ?? null;
  const errors: Stage3Result["errors"] = [];

  await supabase.from("runs").update({ status: "running" }).eq("id", runId);

  for (let i = 0; i < batch.length; i += CONCURRENCY) {
    const chunk = batch.slice(i, i + CONCURRENCY);
    await Promise.all(
      chunk.map(async (row) => {
        try {
          await enrichOne(supabase, row, haveContacts, haveSignal);
        } catch (e) {
          console.error(
            `Stage error for ${row.companies.display_name}:`,
            e,
          );
          errors.push({
            company: row.companies.display_name,
            message: e instanceof Error ? e.message : String(e),
          });
        }
        // Always mark Stage 3 as attempted, success OR fail. Otherwise the
        // client loop retries the same row forever when ZoomInfo or Spark MCP
        // legitimately returns no data.
        await supabase
          .from("run_accounts")
          .update({ stage3_attempted_at: new Date().toISOString() })
          .eq("id", row.id);
      }),
    );
  }

  const remaining = total - batch.length;
  if (remaining === 0) {
    await supabase.from("runs").update({ status: "complete" }).eq("id", runId);
  }

  revalidatePath(`/runs/${runId}`);
  return { processed: batch.length, remaining, total, errors, currentCompany };
}

async function enrichOne(
  supabase: Awaited<ReturnType<typeof verifySession>>["supabase"],
  row: EnrichRow,
  haveContacts: Set<string>,
  haveSignal: Set<string>,
) {
  const company = row.companies;

  if (!haveContacts.has(company.id)) {
    const contacts = await getContactProvider().fetchContacts({
      companyName: company.display_name,
      website: company.website,
      industryGuess: company.industry_guess,
      primaryValueDriver: company.primary_value_driver,
    });
    if (contacts.length > 0) {
      // Per-contact tailoring: short SDR-facing notes (outreach angle +
      // likely challenge) per contact. Best-effort — if the Anthropic call
      // fails or no key is configured, we still insert the contacts with
      // null fields rather than blocking enrichment.
      const anthropicKey = process.env.PROSPECT_ANTHROPIC_KEY?.trim();
      let tailored = contacts.map(() => ({
        outreachAngle: null as string | null,
        likelyChallenge: null as string | null,
      }));
      if (anthropicKey) {
        try {
          const result = await tailorContacts(
            {
              companyName: company.display_name,
              industryGuess: company.industry_guess,
              primaryValueDriver: company.primary_value_driver,
              contacts: contacts.map((c) => ({
                name: c.name,
                title: c.title,
                tier: c.tier,
              })),
            },
            anthropicKey,
          );
          tailored = result.tailored;
        } catch (e) {
          console.warn(
            `Contact tailoring failed for ${company.display_name}:`,
            e,
          );
        }
      }
      const merged = applyTailoring(contacts, tailored);
      const insertRows = merged.map((c) => ({
        company_id: company.id,
        name: c.name,
        title: c.title,
        email: c.email,
        linkedin: c.linkedin,
        tier: c.tier,
        // sources[] is populated by each provider with its own name. After
        // the aggregator's Claude dedup, a multi-source person has all their
        // attributions unioned (e.g. ["zoominfo-rest", "linkedin"]).
        sources: c.sources,
        outreach_angle: c.outreachAngle,
        likely_challenge: c.likelyChallenge,
      }));
      const { error } = await supabase.from("contacts").insert(insertRows);
      if (error) throw new Error(`contacts insert: ${error.message}`);
    }
  }

  if (!haveSignal.has(company.id)) {
    const signal = await getSignalProvider().fetchSignal({
      companyName: company.display_name,
      industryGuess: company.industry_guess,
    });
    if (signal) {
      const { error } = await supabase.from("signals").insert({
        company_id: company.id,
        type: signal.type,
        agency_name: signal.agencyName,
        agency_state: signal.agencyState,
        vendor_name: signal.vendorName,
        summary: signal.summary,
        source_link: signal.sourceLink,
        signal_date: signal.signalDate,
      });
      if (error) throw new Error(`signal insert: ${error.message}`);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Stage 4 — Email drafting via Anthropic
// Per Tier 1 / Tier 2 enriched account: pull exec contact (fallback manager),
// pull strongest signal, call Sonnet, store subject + body on run_accounts.

// One draft per server-action call so the progress bar ticks per email.
const STAGE4_BATCH_SIZE = 1;
const STAGE4_CONCURRENCY = 1;

export type Stage4Result = {
  processed: number;
  remaining: number;
  total: number;
  errors: Array<{ company: string; message: string }>;
  totalDollars: number;
  currentCompany?: string | null;
};

type Stage4Row = {
  id: string;
  company_id: string;
  tier_snapshot: string | null;
  email_subject: string | null;
  email_body: string | null;
  stage4_attempted_at: string | null;
  companies: {
    id: string;
    display_name: string;
    industry_guess: string | null;
    primary_value_driver: string | null;
  };
};

type ContactRow = {
  company_id: string;
  name: string | null;
  title: string | null;
  tier: "exec" | "manager" | "ic" | null;
};

type SignalRow = {
  company_id: string;
  type: string;
  agency_name: string | null;
  agency_state: string | null;
  vendor_name: string | null;
  summary: string | null;
  fetched_at: string;
};

export async function runStage4Batch(runId: string): Promise<Stage4Result> {
  const { user, supabase } = await verifySession();

  const { data: run, error: runErr } = await supabase
    .from("runs")
    .select("id, status")
    .eq("id", runId)
    .maybeSingle();
  if (runErr || !run) throw new Error("Run not found");

  // Tier 1/2 accounts that haven't been attempted yet. (Filtering only by
  // email_body IS NULL would cause infinite retries on prospects where no
  // contact is cached.) Once attempted, even on failure, we mark and skip.
  const { data: tierRowsRaw, error: tierErr } = await supabase
    .from("run_accounts")
    .select(
      "id, company_id, tier_snapshot, email_subject, email_body, stage4_attempted_at, companies(id, display_name, industry_guess, primary_value_driver)",
    )
    .eq("run_id", runId)
    .in("tier_snapshot", ENRICHMENT_TIERS as unknown as string[])
    .is("email_body", null)
    .is("stage4_attempted_at", null);
  if (tierErr) throw new Error(`Load Tier 1/2 accounts: ${tierErr.message}`);
  const tierRows = (tierRowsRaw ?? []) as unknown as Stage4Row[];

  const total = tierRows.length;
  if (total === 0) {
    return {
      processed: 0,
      remaining: 0,
      total: 0,
      errors: [],
      totalDollars: 0,
      currentCompany: null,
    };
  }

  // Pull contacts + signals once for the batch's companies.
  const batch = tierRows.slice(0, STAGE4_BATCH_SIZE);
  const currentCompany = batch[0]?.companies?.display_name ?? null;
  const companyIds = [...new Set(batch.map((r) => r.company_id))];

  const [{ data: contactsData }, { data: signalsData }] = await Promise.all([
    supabase
      .from("contacts")
      .select("company_id, name, title, tier")
      .in("company_id", companyIds)
      .order("fetched_at", { ascending: false }),
    supabase
      .from("signals")
      .select(
        "company_id, type, agency_name, agency_state, vendor_name, summary, fetched_at",
      )
      .in("company_id", companyIds)
      .order("fetched_at", { ascending: false }),
  ]);

  const contactsByCompany = new Map<string, ContactRow[]>();
  for (const c of (contactsData ?? []) as ContactRow[]) {
    const arr = contactsByCompany.get(c.company_id) ?? [];
    arr.push(c);
    contactsByCompany.set(c.company_id, arr);
  }
  const signalByCompany = new Map<string, SignalRow>();
  for (const s of (signalsData ?? []) as SignalRow[]) {
    if (!signalByCompany.has(s.company_id)) signalByCompany.set(s.company_id, s);
  }

  await supabase.from("runs").update({ status: "running" }).eq("id", runId);

  const errors: Stage4Result["errors"] = [];
  let totalDollars = 0;

  for (let i = 0; i < batch.length; i += STAGE4_CONCURRENCY) {
    const chunk = batch.slice(i, i + STAGE4_CONCURRENCY);
    const results = await Promise.all(
      chunk.map(async (row) => {
        try {
          const dollars = await draftAllVariants(
            supabase,
            user.id,
            row,
            contactsByCompany.get(row.company_id) ?? [],
            signalByCompany.get(row.company_id) ?? null,
          );
          return dollars;
        } catch (e) {
          console.error(
            `Stage 4 error for ${row.companies.display_name}:`,
            e,
          );
          errors.push({
            company: row.companies.display_name,
            message: e instanceof Error ? e.message : String(e),
          });
          return 0;
        } finally {
          // Always mark attempted so the loop terminates and we don't retry
          // forever on prospects that have no contact or signal cached.
          await supabase
            .from("run_accounts")
            .update({ stage4_attempted_at: new Date().toISOString() })
            .eq("id", row.id);
        }
      }),
    );
    totalDollars += results.reduce((a, b) => a + b, 0);
  }

  const remaining = total - batch.length;
  if (remaining === 0) {
    await supabase.from("runs").update({ status: "complete" }).eq("id", runId);
  }

  revalidatePath(`/runs/${runId}`);
  // processed = attempts (not successes), so the AutoPipelineRunner loop only
  // exits when there's genuinely nothing left to try. Successes vs failures
  // are surfaced via the errors array.
  return {
    processed: batch.length,
    remaining,
    total,
    errors,
    totalDollars,
    currentCompany,
  };
}

// Stage 4 now generates exec/manager/IC email variants plus a voicemail
// script and SMS per tier. For each tier where we have a contact we fan out
// 3 parallel Claude calls (one per channel). All variants land in JSONB
// columns; the legacy email_subject/email_body fields are populated with the
// highest-tier email so older UI surfaces continue to work.
async function draftAllVariants(
  supabase: Awaited<ReturnType<typeof verifySession>>["supabase"],
  userId: string,
  row: Stage4Row,
  contacts: ContactRow[],
  signal: SignalRow | null,
): Promise<number> {
  if (!signal || !signal.summary) {
    throw new Error("No GovSpend signal found — flag for manual research");
  }
  // Hoist the narrowed summary so closures below don't re-widen the type.
  const signalSummary: string = signal.summary;

  const TIERS: ContactTier[] = ["exec", "manager", "ic"];
  const tierContacts: Array<{ tier: ContactTier; contact: ContactRow }> = [];
  for (const tier of TIERS) {
    const c = contacts.find((x) => x.tier === tier && x.name);
    if (c) tierContacts.push({ tier, contact: c });
  }
  if (tierContacts.length === 0) {
    throw new Error(
      "No contact found in any tier — flag for manual research",
    );
  }

  const inputs = tierContacts.map(({ tier, contact }) => {
    const { firstName, lastName } = splitName(contact.name ?? "There");
    const input: DraftInput = {
      companyName: row.companies.display_name,
      industry: row.companies.industry_guess,
      primaryValueDriver: row.companies.primary_value_driver,
      contact: { firstName, lastName, title: contact.title ?? "", tier },
      signal: {
        type: signal.type,
        agencyName: signal.agency_name,
        agencyState: signal.agency_state,
        vendorName: signal.vendor_name,
        summary: signalSummary,
      },
    };
    return { tier, input };
  });

  // Up to 9 parallel Claude calls per row (3 tiers x 3 channels). Each call
  // sees only its persona to keep variants distinct and avoid template-mode.
  const [emails, voicemails, smses] = await Promise.all([
    Promise.all(
      inputs.map(({ tier, input }) =>
        draftEmail(input).then((d) => ({ tier, d })),
      ),
    ),
    Promise.all(
      inputs.map(({ tier, input }) =>
        draftVoicemail(input).then((d) => ({ tier, d })),
      ),
    ),
    Promise.all(
      inputs.map(({ tier, input }) =>
        draftSms(input).then((d) => ({ tier, d })),
      ),
    ),
  ]);

  const emailVariants: Record<string, { subject: string; body: string }> = {};
  const voicemailVariants: Record<string, string> = {};
  const smsVariants: Record<string, string> = {};
  const violations: string[] = [];
  let tokensIn = 0;
  let tokensOut = 0;
  let totalDollars = 0;

  for (const { tier, d } of emails) {
    emailVariants[tier] = { subject: d.subject, body: d.body };
    const v = validateEmail(d);
    if (!v.ok) violations.push(...v.violations.map((x) => `email/${tier}: ${x}`));
    tokensIn += d.usage.inputTokens;
    tokensOut += d.usage.outputTokens;
    totalDollars += d.usage.dollarEstimate;
  }
  for (const { tier, d } of voicemails) {
    voicemailVariants[tier] = d.script;
    const v = validateVoicemail(d);
    if (!v.ok)
      violations.push(...v.violations.map((x) => `voicemail/${tier}: ${x}`));
    tokensIn += d.usage.inputTokens;
    tokensOut += d.usage.outputTokens;
    totalDollars += d.usage.dollarEstimate;
  }
  for (const { tier, d } of smses) {
    smsVariants[tier] = d.text;
    const v = validateSms(d);
    if (!v.ok) violations.push(...v.violations.map((x) => `sms/${tier}: ${x}`));
    tokensIn += d.usage.inputTokens;
    tokensOut += d.usage.outputTokens;
    totalDollars += d.usage.dollarEstimate;
  }

  if (violations.length > 0) {
    console.warn(
      `Stage 4 lint violations for ${row.companies.display_name}:`,
      violations,
    );
  }

  // Backwards-compat: keep email_subject/email_body populated with the
  // highest-tier email so the existing list/table UI still renders something
  // even before the multi-variant UI lands.
  const primaryTier: ContactTier =
    "exec" in emailVariants
      ? "exec"
      : "manager" in emailVariants
        ? "manager"
        : "ic";
  const primary = emailVariants[primaryTier];

  await supabase.from("usage_log").insert({
    user_id: userId,
    action: "stage4_multi_channel",
    tokens_in: tokensIn,
    tokens_out: tokensOut,
    dollar_estimate: totalDollars,
  });

  await supabase
    .from("run_accounts")
    .update({
      email_subject: primary.subject,
      email_body: primary.body,
      email_variants: emailVariants,
      voicemail_variants: voicemailVariants,
      sms_variants: smsVariants,
      research_confidence: violations.length === 0 ? "High" : "Needs Review",
      needs_human_review: violations.length > 0,
    })
    .eq("id", row.id);

  return totalDollars;
}

function splitName(name: string): { firstName: string; lastName: string } {
  const parts = name.trim().split(/\s+/);
  const firstName = parts[0] ?? "";
  const lastName = parts.slice(1).join(" ");
  return { firstName, lastName };
}
