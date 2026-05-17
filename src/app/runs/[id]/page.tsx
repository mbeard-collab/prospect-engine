import { notFound } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { verifySession } from "@/lib/dal";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { TierBadge } from "@/components/tier-badge";
import type { FitTier } from "@/lib/types";
import { Stage2Controls } from "./stage2-controls";
import { Stage25Controls } from "./stage25-controls";
import { Stage3Controls } from "./stage3-controls";
import { Stage4Controls } from "./stage4-controls";
import { AutoPipelineRunner } from "./auto-pipeline";
import { AccountsTable, type AccountRow } from "./accounts-table";
import {
  getCompetitorProvider,
  getContactProvider,
  getSignalProvider,
} from "@/lib/enrichment";

type RunAccountRow = {
  id: string;
  company_id: string;
  alphabet_group: string | null;
  territory_rank: number | null;
  score_snapshot: number | null;
  tier_snapshot: FitTier | null;
  needs_human_review: boolean;
  email_subject: string | null;
  email_body: string | null;
  // JSONB columns added in 20260516_email_variants.sql. Each is keyed by
  // ContactTier ("exec" | "manager" | "ic"); a tier is only present if a
  // contact at that level was available when Stage 4 ran.
  email_variants: Record<string, { subject: string; body: string }> | null;
  voicemail_variants: Record<string, string> | null;
  sms_variants: Record<string, string> | null;
  stage3_attempted_at: string | null;
  companies: {
    id: string;
    display_name: string;
    clean_name: string | null;
    industry_guess: string | null;
    exclude_flag: boolean;
    exclude_reason: string | null;
    primary_value_driver: string | null;
    score_breakdown: string | null;
    // Stage 2.5: cached competitor research from companies.competitors.
    // Shape: { names: string[], note: string }. Null when never researched.
    competitors: { names?: unknown; note?: unknown } | null;
    competitors_fetched_at: string | null;
  };
};

type ContactDbRow = {
  company_id: string;
  name: string | null;
  title: string | null;
  email: string | null;
  linkedin: string | null;
  tier: "exec" | "manager" | "ic" | null;
  // SDR-facing notes generated at Stage 3 time. Null when tailoring was
  // skipped or failed (rare — best-effort, doesn't block contact insert).
  outreach_angle: string | null;
  likely_challenge: string | null;
  fetched_at: string;
};

type SignalDbRow = {
  company_id: string;
  type: string;
  agency_name: string | null;
  agency_state: string | null;
  vendor_name: string | null;
  summary: string | null;
  source_link: string | null;
  signal_date: string | null;
  fetched_at: string;
};

const TIER_ORDER: FitTier[] = [
  "tier_1",
  "tier_2",
  "tier_3",
  "needs_review",
  "low_fit",
  "excluded",
];
const TIER_LABEL: Record<FitTier, string> = {
  tier_1: "Tier 1",
  tier_2: "Tier 2",
  tier_3: "Tier 3",
  low_fit: "Low Fit",
  needs_review: "Needs Review",
  excluded: "Excluded",
};

const CONTACTS_TTL_DAYS = 30;
const SIGNALS_TTL_DAYS = 7;

// Stage 2.5 result is stored as raw JSONB; normalize to AccountRow's strict
// shape (or null when never researched / both fields empty).
function parseCompetitors(
  raw: { names?: unknown; note?: unknown } | null,
): { names: string[]; note: string } | null {
  if (!raw) return null;
  const names = Array.isArray(raw.names)
    ? raw.names.filter((x): x is string => typeof x === "string")
    : [];
  const note = typeof raw.note === "string" ? raw.note : "";
  if (names.length === 0 && note === "") return null;
  return { names, note };
}

export default async function RunDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { supabase } = await verifySession();

  const { data: run, error: runErr } = await supabase
    .from("runs")
    .select(
      "id, name, csv_filename, total_accounts, excluded_count, ready_count, status, created_at",
    )
    .eq("id", id)
    .maybeSingle();

  if (runErr || !run) notFound();

  const { data: rowsRaw, error: rowsErr } = await supabase
    .from("run_accounts")
    .select(
      "id, company_id, alphabet_group, territory_rank, score_snapshot, tier_snapshot, needs_human_review, email_subject, email_body, email_variants, voicemail_variants, sms_variants, stage3_attempted_at, companies(id, display_name, clean_name, industry_guess, exclude_flag, exclude_reason, primary_value_driver, score_breakdown, competitors, competitors_fetched_at)",
    )
    .eq("run_id", id)
    .order("territory_rank", { ascending: true });
  const rows = (rowsRaw ?? []) as unknown as RunAccountRow[];

  const excluded = rows.filter((r) => r.companies.exclude_flag);
  const readyRows = rows.filter((r) => !r.companies.exclude_flag);
  const stage2Processed = readyRows.filter((r) => r.tier_snapshot !== null).length;
  const stage2Remaining = readyRows.length - stage2Processed;

  // Stage 2 tier breakdown
  const tierCounts = new Map<FitTier, number>();
  for (const r of readyRows) {
    if (r.tier_snapshot && r.tier_snapshot !== "excluded") {
      tierCounts.set(r.tier_snapshot, (tierCounts.get(r.tier_snapshot) ?? 0) + 1);
    }
  }

  // Stage 1 industry breakdown
  const industryBreakdown = new Map<string, number>();
  for (const r of excluded) {
    const k = r.companies.industry_guess ?? "Other";
    industryBreakdown.set(k, (industryBreakdown.get(k) ?? 0) + 1);
  }

  // Stage 3: pull enrichment for all companies in this run.
  const companyIds = [...new Set(rows.map((r) => r.companies.id))];
  let contactsByCompany = new Map<string, ContactDbRow[]>();
  let signalByCompany = new Map<string, SignalDbRow>();

  if (companyIds.length > 0) {
    const [{ data: contactsData }, { data: signalsData }] = await Promise.all([
      supabase
        .from("contacts")
        .select(
          "company_id, name, title, email, linkedin, tier, outreach_angle, likely_challenge, fetched_at",
        )
        .in("company_id", companyIds)
        .order("fetched_at", { ascending: false }),
      supabase
        .from("signals")
        .select(
          "company_id, type, agency_name, agency_state, vendor_name, summary, source_link, signal_date, fetched_at",
        )
        .in("company_id", companyIds)
        .order("fetched_at", { ascending: false }),
    ]);

    for (const c of (contactsData ?? []) as ContactDbRow[]) {
      const arr = contactsByCompany.get(c.company_id) ?? [];
      arr.push(c);
      contactsByCompany.set(c.company_id, arr);
    }

    for (const s of (signalsData ?? []) as SignalDbRow[]) {
      // Keep only the most recent signal per company (data already ordered desc).
      if (!signalByCompany.has(s.company_id)) {
        signalByCompany.set(s.company_id, s);
      }
    }
  }

  // Enrichment-eligible tiers (Tier 1/2/3) — Stage 3 + Stage 4 process these.
  // Stays in sync with ENRICHMENT_TIERS in actions.ts.
  const tier12 = readyRows.filter(
    (r) =>
      r.tier_snapshot === "tier_1" ||
      r.tier_snapshot === "tier_2" ||
      r.tier_snapshot === "tier_3",
  );
  const contactsCutoff = Date.now() - CONTACTS_TTL_DAYS * 86400 * 1000;
  const signalsCutoff = Date.now() - SIGNALS_TTL_DAYS * 86400 * 1000;
  const tier12NeedsWork = tier12.filter((r) => {
    const c = contactsByCompany.get(r.companies.id) ?? [];
    const hasFreshContacts = c.some(
      (x) => new Date(x.fetched_at).getTime() >= contactsCutoff,
    );
    const sig = signalByCompany.get(r.companies.id);
    const hasFreshSignal =
      sig && new Date(sig.fetched_at).getTime() >= signalsCutoff;
    return !(hasFreshContacts && hasFreshSignal);
  }).length;

  // Stage 4 progress: Tier 1/2/3 with email_body filled in.
  const stage4Drafted = tier12.filter((r) => r.email_body !== null).length;
  const stage4Remaining = tier12.length - stage4Drafted;

  // Stage 2.5 progress: Tier 1/2/3 companies with fresh competitor research.
  // Mirrors COMPETITORS_TTL_DAYS in actions.ts (90 days).
  const COMPETITORS_TTL_DAYS = 90;
  const competitorsCutoff = Date.now() - COMPETITORS_TTL_DAYS * 86400 * 1000;
  const tier12CompaniesNeedingCompetitors = new Set<string>();
  const tier12CompaniesAll = new Set<string>();
  for (const r of tier12) {
    tier12CompaniesAll.add(r.companies.id);
    const cachedAt = r.companies.competitors_fetched_at;
    if (!cachedAt || new Date(cachedAt).getTime() < competitorsCutoff) {
      tier12CompaniesNeedingCompetitors.add(r.companies.id);
    }
  }
  const stage25Remaining = tier12CompaniesNeedingCompetitors.size;
  const stage25Total = tier12CompaniesAll.size;

  // Build AccountRow[] for the client table.
  const tableRows: AccountRow[] = rows.map((r) => {
    const dedupedContacts = new Map<string, ContactDbRow>();
    for (const c of contactsByCompany.get(r.companies.id) ?? []) {
      const key = `${c.tier}:${(c.name ?? "").toLowerCase()}`;
      if (!dedupedContacts.has(key)) dedupedContacts.set(key, c);
    }
    const sig = signalByCompany.get(r.companies.id) ?? null;

    return {
      id: r.id,
      rank: r.territory_rank,
      displayName: r.companies.display_name,
      scoreSnapshot: r.score_snapshot,
      tierSnapshot: r.tier_snapshot,
      excludeFlag: r.companies.exclude_flag,
      excludeReason: r.companies.exclude_reason,
      industryGuess: r.companies.industry_guess,
      primaryValueDriver: r.companies.primary_value_driver,
      scoreBreakdown: r.companies.score_breakdown,
      stage3Attempted: r.stage3_attempted_at !== null,
      contacts: [...dedupedContacts.values()]
        .filter((c) => c.name && c.tier)
        .map((c) => ({
          name: c.name!,
          title: c.title ?? "",
          tier: c.tier!,
          email: c.email,
          linkedin: c.linkedin,
          outreachAngle: c.outreach_angle,
          likelyChallenge: c.likely_challenge,
        })),
      signal: sig
        ? {
            type: sig.type,
            agencyName: sig.agency_name,
            agencyState: sig.agency_state,
            vendorName: sig.vendor_name,
            summary: sig.summary ?? "",
            sourceLink: sig.source_link,
            signalDate: sig.signal_date,
          }
        : null,
      email:
        r.email_subject && r.email_body
          ? {
              subject: r.email_subject,
              body: r.email_body,
              needsReview: r.needs_human_review,
            }
          : null,
      variants:
        r.email_variants || r.voicemail_variants || r.sms_variants
          ? {
              emails: r.email_variants ?? {},
              voicemails: r.voicemail_variants ?? {},
              smses: r.sms_variants ?? {},
              needsReview: r.needs_human_review,
            }
          : null,
      competitors: parseCompetitors(r.companies.competitors),
    };
  });

  const searchProviderName = process.env.BRAVE_API_KEY?.trim() ? "brave" : "mock";
  const hasAnthropicKey = !!process.env.PROSPECT_ANTHROPIC_KEY?.trim();
  const contactProviderName = getContactProvider().name;
  const signalProviderName = getSignalProvider().name;
  const competitorProviderName = getCompetitorProvider().name;

  return (
    <AppShell>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{run.name}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {run.csv_filename ?? "—"} · {new Date(run.created_at).toLocaleString()}
          </p>
        </div>
      </div>

      <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Total accounts</CardDescription>
            <CardTitle className="text-3xl tabular-nums">
              {run.total_accounts}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Stage 1 excluded</CardDescription>
            <CardTitle className="text-3xl tabular-nums text-red-600">
              {run.excluded_count}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Stage 2 scored</CardDescription>
            <CardTitle className="text-3xl tabular-nums text-emerald-600">
              {stage2Processed}
              <span className="text-sm font-normal text-muted-foreground">
                {" "}/ {readyRows.length}
              </span>
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Enrichable (Tier 1/2/3)</CardDescription>
            <CardTitle className="text-3xl tabular-nums text-emerald-600">
              {(tierCounts.get("tier_1") ?? 0) +
                (tierCounts.get("tier_2") ?? 0) +
                (tierCounts.get("tier_3") ?? 0)}
            </CardTitle>
          </CardHeader>
        </Card>
      </div>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>Pipeline</CardTitle>
          <CardDescription>
            Run Stage 2 → 3 → 4 in one click. Auto-starts when you arrive from the
            upload page. Per-stage controls below for granular retries.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <AutoPipelineRunner
            runId={run.id}
            stage2={{ processed: stage2Processed, total: readyRows.length }}
            stage25={{ processed: stage25Total - stage25Remaining, total: stage25Total }}
            stage3={{ processed: tier12.length - tier12NeedsWork, total: tier12.length }}
            stage4={{ processed: stage4Drafted, total: tier12.length }}
          />
        </CardContent>
      </Card>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>Stage 2 — web fit scoring</CardTitle>
          <CardDescription>
            One web search per company, scored against the 100-point rubric. 90-day cache
            hit when a company has been scored before. No LLM tokens spent here.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Stage2Controls
            runId={run.id}
            remaining={stage2Remaining}
            totalReady={readyRows.length}
            providerName={searchProviderName}
          />
        </CardContent>
      </Card>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>Stage 2.5 — competitor research (Tier 1/2/3)</CardTitle>
          <CardDescription>
            Up to 3 named competitors per company via Anthropic web_search.
            Cached on the companies table for 90 days, so repeat companies on
            future CSVs are free.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Stage25Controls
            runId={run.id}
            remaining={stage25Remaining}
            totalEnrichable={stage25Total}
            providerName={competitorProviderName}
          />
        </CardContent>
      </Card>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>Stage 3 — enrichment (Tier 1/2/3)</CardTitle>
          <CardDescription>
            Up to 3 contacts (exec / manager / IC) per account from ZoomInfo, plus the single
            strongest GovSpend signal. Contacts cache 30 days, signals 7 days.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Stage3Controls
            runId={run.id}
            remaining={tier12NeedsWork}
            totalTier12={tier12.length}
            contactProviderName={contactProviderName}
            signalProviderName={signalProviderName}
          />
        </CardContent>
      </Card>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>Stage 4 — email drafting</CardTitle>
          <CardDescription>
            One email per Tier 1/2/3 account, Josh Braun style, sent through Claude
            Sonnet 4.6. Defaults to the exec contact; falls back to manager or IC.
            Validates output against the banned-phrase + em-dash rules from the spec.
            Each draft logged to <code>usage_log</code> with token counts.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Stage4Controls
            runId={run.id}
            remaining={stage4Remaining}
            totalTier12={tier12.length}
            hasAnthropicKey={hasAnthropicKey}
          />
          {stage4Drafted > 0 ? (
            <p className="mt-2 text-xs text-muted-foreground">
              {stage4Drafted} email{stage4Drafted === 1 ? "" : "s"} drafted so far.
              Click <strong>Details</strong> on a Tier 1/2/3 row in the Accounts table to read
              and copy.
            </p>
          ) : null}
        </CardContent>
      </Card>

      {tierCounts.size > 0 ? (
        <Card className="mt-6">
          <CardHeader>
            <CardTitle>Stage 2 tier distribution</CardTitle>
            <CardDescription>Among {stage2Processed} scored accounts</CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Tier</TableHead>
                  <TableHead className="text-right">Count</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {TIER_ORDER.filter((t) => t !== "excluded" && tierCounts.has(t)).map(
                  (t) => (
                    <TableRow key={t}>
                      <TableCell>
                        <TierBadge tier={t} />
                        <span className="ml-2">{TIER_LABEL[t]}</span>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {tierCounts.get(t)}
                      </TableCell>
                    </TableRow>
                  ),
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      ) : null}

      {industryBreakdown.size > 0 ? (
        <Card className="mt-6">
          <CardHeader>
            <CardTitle>Stage 1 — excluded by industry</CardTitle>
            <CardDescription>Keyword pre-filter matches</CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Industry</TableHead>
                  <TableHead className="text-right">Count</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {[...industryBreakdown.entries()]
                  .sort((a, b) => b[1] - a[1])
                  .map(([k, v]) => (
                    <TableRow key={k}>
                      <TableCell>{k}</TableCell>
                      <TableCell className="text-right tabular-nums">{v}</TableCell>
                    </TableRow>
                  ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      ) : null}

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>Accounts</CardTitle>
          <CardDescription>
            {rowsErr ? rowsErr.message : `${rows.length} rows · click "Details" on Tier 1/2/3 rows to see contacts + signal`}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <AccountsTable
            rows={tableRows}
            contactProviderChain={contactProviderName}
            signalProviderName={signalProviderName}
          />
        </CardContent>
      </Card>
    </AppShell>
  );
}
