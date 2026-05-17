"use client";

import { Fragment, useMemo, useState } from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { TierBadge } from "@/components/tier-badge";
import { cn } from "@/lib/utils";
import type { FitTier } from "@/lib/types";

// Ordering for the tier column. Higher = better fit, so desc sort puts Tier 1 on top.
const TIER_RANK: Record<FitTier, number> = {
  tier_1: 6,
  tier_2: 5,
  tier_3: 4,
  needs_review: 3,
  low_fit: 2,
  excluded: 1,
};

type SortCol = "rank" | "name" | "score" | "tier";
type SortDir = "asc" | "desc";
type SortState = { col: SortCol; dir: SortDir };

// 100-point rubric labels, mirroring src/lib/scoring/rubric.ts.
const BREAKDOWN_DEFS = [
  {
    short: "SLED",
    label: "SLED evidence",
    max: 30,
    desc: "Public-sector marketing, named agency clients, government landing page",
  },
  {
    short: "category",
    label: "Product category",
    max: 20,
    desc: "Product type government agencies commonly buy (gov software, public safety, edtech, etc.)",
  },
  {
    short: "states",
    label: "Multi-state",
    max: 15,
    desc: "Nationwide claims or multiple state names visible in results",
  },
  {
    short: "gov motion",
    label: "Gov sales motion",
    max: 15,
    desc: "GSA schedule, capture team, public sector sales contact",
  },
  {
    short: "comp",
    label: "Competitive context",
    max: 10,
    desc: "G2 / Capterra / 'alternatives to' pages",
  },
  {
    short: "category fit",
    label: "Clear product category",
    max: 10,
    desc: "Buyer persona is obvious from the website",
  },
] as const;

type BreakdownItem = (typeof BREAKDOWN_DEFS)[number] & { score: number };

function parseBreakdown(
  s: string | null,
): { items: BreakdownItem[]; total: number } | null {
  if (!s) return null;
  const m = s.match(/^(\d+)\/(\d+)\/(\d+)\/(\d+)\/(\d+)\/(\d+)\s*=\s*(\d+)/);
  if (!m) return null;
  const scores = m.slice(1, 7).map(Number);
  const total = Number(m[7]);
  return {
    total,
    items: BREAKDOWN_DEFS.map((d, i) => ({ ...d, score: scores[i] ?? 0 })),
  };
}

export type AccountRow = {
  id: string;
  rank: number | null;
  displayName: string;
  scoreSnapshot: number | null;
  tierSnapshot: FitTier | null;
  excludeFlag: boolean;
  excludeReason: string | null;
  industryGuess: string | null;
  primaryValueDriver: string | null;
  scoreBreakdown: string | null;
  stage3Attempted: boolean;
  contacts: Array<{
    name: string;
    title: string;
    tier: "exec" | "manager" | "ic";
    email: string | null;
    linkedin: string | null;
    // SDR-facing per-contact notes from Stage 3 tailoring. Null when the
    // tailoring call failed or was skipped (no Anthropic key).
    outreachAngle: string | null;
    likelyChallenge: string | null;
  }>;
  signal: {
    type: string;
    agencyName: string | null;
    agencyState: string | null;
    vendorName: string | null;
    summary: string;
    sourceLink: string | null;
    signalDate: string | null;
  } | null;
  email: {
    subject: string;
    body: string;
    needsReview: boolean;
  } | null;
  // Stage 4 multi-channel output. Each map is keyed by tier
  // ("exec" | "manager" | "ic"); a tier is present only if a contact at that
  // level was available when Stage 4 ran. Rows drafted before the variants
  // migration will have variants === null and fall back to the legacy `email`
  // field above.
  variants: {
    emails: Record<string, { subject: string; body: string }>;
    voicemails: Record<string, string>;
    smses: Record<string, string>;
    needsReview: boolean;
  } | null;
  // Stage 2.5 competitor research, cached on companies (90-day TTL). Null
  // when never researched OR researched but came back empty for both fields.
  competitors: {
    names: string[];
    note: string;
  } | null;
};

const SIGNAL_LABEL: Record<string, string> = {
  open_bid: "Open Bid",
  expiring_contract: "Expiring Competitor Contract",
  po_breadcrumb: "PO Breadcrumb",
  meeting: "Meeting Intelligence",
  spend_pattern: "Spend Pattern",
};

const TIER_LABEL: Record<"exec" | "manager" | "ic", string> = {
  exec: "Exec",
  manager: "Manager",
  ic: "IC",
};

export function AccountsTable({
  rows,
  contactProviderChain,
  signalProviderName,
}: {
  rows: AccountRow[];
  // Display string like "zoominfo-rest → anthropic-web-search → web-search".
  // Shown in expanded-row empty states so users know what was tried.
  contactProviderChain: string;
  signalProviderName: string;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [copied, setCopied] = useState<string | null>(null);
  // Default: score desc so Tier 1/2 float to the top.
  const [sort, setSort] = useState<SortState>({ col: "score", dir: "desc" });

  const toggle = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // Generic copy helper. The `key` namespaces the "Copied!" badge so the
  // right per-variant button highlights instead of all of them at once.
  const copy = async (key: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      setTimeout(() => setCopied((c) => (c === key ? null : c)), 1500);
    } catch {
      // ignore
    }
  };

  const onSort = (col: SortCol) => {
    setSort((s) => {
      if (s.col !== col) {
        // First click on a new column: default to desc for score/tier (best first),
        // asc for rank/name (natural reading order).
        return { col, dir: col === "rank" || col === "name" ? "asc" : "desc" };
      }
      return { col, dir: s.dir === "asc" ? "desc" : "asc" };
    });
  };

  const sortedRows = useMemo(() => {
    const arr = [...rows];
    const dir = sort.dir === "asc" ? 1 : -1;
    arr.sort((a, b) => {
      let av: number | string;
      let bv: number | string;
      switch (sort.col) {
        case "rank":
          av = a.rank ?? Number.POSITIVE_INFINITY;
          bv = b.rank ?? Number.POSITIVE_INFINITY;
          break;
        case "name":
          av = a.displayName.toLowerCase();
          bv = b.displayName.toLowerCase();
          break;
        case "score":
          av = a.scoreSnapshot ?? -1;
          bv = b.scoreSnapshot ?? -1;
          break;
        case "tier":
          av = a.tierSnapshot ? TIER_RANK[a.tierSnapshot] : 0;
          bv = b.tierSnapshot ? TIER_RANK[b.tierSnapshot] : 0;
          break;
      }
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      return 0;
    });
    return arr;
  }, [rows, sort]);

  const headerLabel = (col: SortCol, label: string) => {
    const active = sort.col === col;
    return (
      <button
        type="button"
        onClick={() => onSort(col)}
        className={cn(
          "inline-flex items-center gap-1 font-medium hover:text-foreground",
          active ? "text-foreground" : "text-muted-foreground",
        )}
      >
        {label}
        <span className="text-[10px]">
          {active ? (sort.dir === "asc" ? "▲" : "▼") : "↕"}
        </span>
      </button>
    );
  };

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-10">{headerLabel("rank", "#")}</TableHead>
          <TableHead>{headerLabel("name", "Original name")}</TableHead>
          <TableHead className="text-right">{headerLabel("score", "Score")}</TableHead>
          <TableHead>{headerLabel("tier", "Status")}</TableHead>
          <TableHead>Industry / value driver</TableHead>
          <TableHead>Reason / breakdown</TableHead>
          <TableHead className="w-24" />
        </TableRow>
      </TableHeader>
      <TableBody>
        {sortedRows.map((r) => {
          const breakdown = parseBreakdown(r.scoreBreakdown);
          const confidence = computeConfidence(r);
          const enriched =
            r.contacts.length > 0 ||
            r.signal !== null ||
            r.email !== null ||
            r.variants !== null;
          const isExpanded = expanded.has(r.id);
          // Enable Details on any row with something to show — enrichment or a score breakdown.
          const canExpand = enriched || breakdown !== null;

          // Inline cell content for the Reason / breakdown column:
          // - excluded rows: keep the regex reason
          // - scored rows: show only buckets that fired with short labels
          // - unscored: nudge toward Stage 2
          let breakdownCell: React.ReactNode;
          if (r.excludeFlag) {
            breakdownCell = r.excludeReason ?? "—";
          } else if (breakdown) {
            const fired = breakdown.items.filter((b) => b.score > 0);
            if (fired.length === 0) {
              breakdownCell = (
                <span className="italic">No rubric buckets fired</span>
              );
            } else {
              breakdownCell = (
                <span>
                  {fired.map((b, i) => (
                    <span key={b.short}>
                      {i > 0 ? " · " : ""}
                      <span className="tabular-nums">{b.score}</span>{" "}
                      {b.short}
                    </span>
                  ))}
                </span>
              );
            }
          } else {
            breakdownCell = (
              <span className="text-emerald-600">Ready for Stage 2</span>
            );
          }

          return (
            <Fragment key={r.id}>
              <TableRow>
                <TableCell className="text-muted-foreground tabular-nums">
                  {r.rank ?? "—"}
                </TableCell>
                <TableCell className="max-w-[24rem] font-medium whitespace-normal">
                  {r.displayName}
                </TableCell>
                <TableCell className="text-right tabular-nums text-muted-foreground">
                  {r.scoreSnapshot ?? (r.excludeFlag ? "—" : "")}
                </TableCell>
                <TableCell>
                  <div className="flex items-center gap-1.5">
                    <TierBadge tier={r.tierSnapshot} />
                    {confidence ? <ConfidenceChip c={confidence} /> : null}
                  </div>
                </TableCell>
                <TableCell className="max-w-[18rem] whitespace-normal text-muted-foreground">
                  {r.excludeFlag
                    ? r.industryGuess ?? "—"
                    : r.primaryValueDriver ?? (
                        <span className="italic">Not yet scored</span>
                      )}
                </TableCell>
                <TableCell className="max-w-[22rem] whitespace-normal text-muted-foreground">
                  {breakdownCell}
                </TableCell>
                <TableCell>
                  {canExpand ? (
                    <button
                      type="button"
                      onClick={() => toggle(r.id)}
                      className="text-xs underline text-muted-foreground hover:text-foreground"
                    >
                      {isExpanded ? "Hide" : "Details"}
                    </button>
                  ) : null}
                </TableCell>
              </TableRow>
              {isExpanded ? (
                <TableRow className="bg-muted/30">
                  <TableCell colSpan={7} className="whitespace-normal">
                    <div className="space-y-6 px-2 py-3">
                      {confidence ? (
                        <ConfidenceReasons c={confidence} />
                      ) : null}
                      {breakdown ? (
                        <div>
                          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                            Score breakdown ({breakdown.total} / 100)
                          </div>
                          <div className="grid gap-2 md:grid-cols-2">
                            {breakdown.items.map((b) => (
                              <div
                                key={b.short}
                                className={cn(
                                  "rounded-md border p-2 text-sm",
                                  b.score > 0
                                    ? "bg-background"
                                    : "bg-muted/50 text-muted-foreground",
                                )}
                              >
                                <div className="flex items-baseline justify-between gap-2">
                                  <span className="font-medium">{b.label}</span>
                                  <span className="tabular-nums text-xs">
                                    {b.score} / {b.max}
                                  </span>
                                </div>
                                <div className="mt-0.5 text-xs text-muted-foreground">
                                  {b.desc}
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      ) : null}
                      {r.variants ? (
                        <VariantsPanel
                          rowId={r.id}
                          variants={r.variants}
                          copied={copied}
                          onCopy={copy}
                        />
                      ) : r.email ? (
                        <div>
                          <div className="mb-2 flex items-center justify-between gap-2">
                            <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                              Email draft
                              {r.email.needsReview ? (
                                <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-amber-800 dark:bg-amber-950 dark:text-amber-300">
                                  Needs review
                                </span>
                              ) : null}
                            </div>
                            <button
                              type="button"
                              onClick={() =>
                                copy(
                                  `email:${r.id}`,
                                  `Subject: ${r.email!.subject}\n\n${r.email!.body}`,
                                )
                              }
                              className="rounded border bg-background px-2 py-1 text-xs hover:bg-muted"
                            >
                              {copied === `email:${r.id}` ? "Copied!" : "Copy email"}
                            </button>
                          </div>
                          <div className="rounded-md border bg-background p-3 text-sm">
                            <div className="border-b pb-2">
                              <span className="text-muted-foreground">Subject: </span>
                              <span className="font-medium">{r.email.subject}</span>
                            </div>
                            <pre className="mt-2 whitespace-pre-wrap font-sans text-sm">
                              {r.email.body}
                            </pre>
                          </div>
                        </div>
                      ) : null}
                    <div className="grid gap-6 md:grid-cols-2">
                      <div>
                        <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                          Contacts
                        </div>
                        {r.contacts.length === 0 ? (
                          r.stage3Attempted ? (
                            <div className="text-sm text-muted-foreground">
                              <p className="italic">
                                No contacts found. Flag for manual research.
                              </p>
                              <p className="mt-1 text-xs">
                                Sources tried: <code>{contactProviderChain}</code>
                              </p>
                            </div>
                          ) : (
                            <p className="text-sm text-muted-foreground italic">
                              Not enriched yet
                            </p>
                          )
                        ) : (
                          <ul className="space-y-2">
                            {r.contacts.map((c, i) => (
                              <li key={i} className="text-sm">
                                <div className="flex items-baseline gap-2">
                                  <span className="rounded border bg-background px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                                    {TIER_LABEL[c.tier]}
                                  </span>
                                  <span className="font-medium">{c.name}</span>
                                  <span className="text-muted-foreground">
                                    — {c.title}
                                  </span>
                                </div>
                                <div className="ml-1 text-xs text-muted-foreground">
                                  {c.email ? (
                                    <a
                                      className="hover:underline"
                                      href={`mailto:${c.email}`}
                                    >
                                      {c.email}
                                    </a>
                                  ) : (
                                    "no email"
                                  )}
                                  {c.linkedin ? (
                                    <>
                                      {" · "}
                                      <a
                                        className="hover:underline"
                                        href={c.linkedin}
                                        target="_blank"
                                        rel="noreferrer"
                                      >
                                        LinkedIn
                                      </a>
                                    </>
                                  ) : null}
                                </div>
                                {c.outreachAngle ? (
                                  <div className="ml-1 mt-1 text-xs">
                                    <span className="font-medium text-foreground/80">
                                      Why:
                                    </span>{" "}
                                    <span className="text-muted-foreground">
                                      {c.outreachAngle}
                                    </span>
                                  </div>
                                ) : null}
                                {c.likelyChallenge ? (
                                  <div className="ml-1 text-xs">
                                    <span className="font-medium text-foreground/80">
                                      Likely challenge:
                                    </span>{" "}
                                    <span className="text-muted-foreground">
                                      {c.likelyChallenge}
                                    </span>
                                  </div>
                                ) : null}
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                      <div>
                        <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                          Signal
                        </div>
                        {r.signal === null ? (
                          r.stage3Attempted ? (
                            <div className="text-sm text-muted-foreground">
                              <p className="italic">
                                No GovSpend signal found.
                              </p>
                              <p className="mt-1 text-xs">
                                Source tried: <code>{signalProviderName}</code>
                              </p>
                            </div>
                          ) : (
                            <p className="text-sm text-muted-foreground italic">
                              Not enriched yet
                            </p>
                          )
                        ) : (
                          <div className="space-y-1 text-sm">
                            <div>
                              <span className="rounded border bg-background px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                                {SIGNAL_LABEL[r.signal.type] ?? r.signal.type}
                              </span>
                            </div>
                            <p>{r.signal.summary}</p>
                            <div className="text-xs text-muted-foreground">
                              {[
                                r.signal.agencyName,
                                r.signal.agencyState,
                                r.signal.vendorName
                                  ? `Vendor: ${r.signal.vendorName}`
                                  : null,
                                r.signal.signalDate
                                  ? `Date: ${r.signal.signalDate}`
                                  : null,
                              ]
                                .filter(Boolean)
                                .join(" · ")}
                            </div>
                            {r.signal.sourceLink ? (
                              <div className="pt-1">
                                <a
                                  href={r.signal.sourceLink}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="inline-flex items-center gap-1 rounded border bg-background px-2 py-0.5 text-xs font-medium hover:bg-muted"
                                >
                                  Verify in GovSpend
                                  <span aria-hidden className="text-[10px]">↗</span>
                                </a>
                              </div>
                            ) : (
                              <div className="pt-1 text-xs italic text-muted-foreground">
                                No GovSpend link cached for this signal — verify manually before sending.
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                    {ENRICHABLE_TIERS.has(r.tierSnapshot ?? ("low_fit" as FitTier)) ? (
                      <div>
                        <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                          Competitors
                        </div>
                        {r.competitors ? (
                          <div className="space-y-2 text-sm">
                            {r.competitors.names.length > 0 ? (
                              <div className="flex flex-wrap gap-1.5">
                                {r.competitors.names.map((n, i) => (
                                  <span
                                    key={i}
                                    className="rounded border bg-background px-2 py-0.5 text-xs"
                                  >
                                    {n}
                                  </span>
                                ))}
                              </div>
                            ) : (
                              <p className="italic text-muted-foreground">
                                No clear competitors identified.
                              </p>
                            )}
                            {r.competitors.note ? (
                              <p className="text-xs text-muted-foreground">
                                {r.competitors.note}
                              </p>
                            ) : null}
                          </div>
                        ) : (
                          <p className="text-sm italic text-muted-foreground">
                            Not researched yet — run Stage 2.5.
                          </p>
                        )}
                      </div>
                    ) : null}
                    </div>
                  </TableCell>
                </TableRow>
              ) : null}
            </Fragment>
          );
        })}
      </TableBody>
    </Table>
  );
}

// Multi-channel outreach panel: tier tabs across the top (Exec / Manager / IC,
// only tiers we have variants for), then three stacked channel cards for the
// active tier — email, voicemail, SMS — each with its own copy button. The
// active tier defaults to the highest-seniority tier present.
const TIER_PRIORITY: Array<"exec" | "manager" | "ic"> = ["exec", "manager", "ic"];

function VariantsPanel({
  rowId,
  variants,
  copied,
  onCopy,
}: {
  rowId: string;
  variants: NonNullable<AccountRow["variants"]>;
  copied: string | null;
  onCopy: (key: string, text: string) => void;
}) {
  const tiersPresent = TIER_PRIORITY.filter(
    (t) =>
      variants.emails[t] != null ||
      variants.voicemails[t] != null ||
      variants.smses[t] != null,
  );
  const [activeTier, setActiveTier] = useState<"exec" | "manager" | "ic">(
    tiersPresent[0] ?? "exec",
  );

  if (tiersPresent.length === 0) return null;

  const email = variants.emails[activeTier];
  const voicemail = variants.voicemails[activeTier];
  const sms = variants.smses[activeTier];

  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Outreach drafts
          </div>
          {variants.needsReview ? (
            <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-amber-800 dark:bg-amber-950 dark:text-amber-300">
              Needs review
            </span>
          ) : null}
        </div>
        <div className="flex gap-1">
          {tiersPresent.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setActiveTier(t)}
              className={cn(
                "rounded border px-2 py-0.5 text-xs",
                activeTier === t
                  ? "border-foreground bg-foreground text-background"
                  : "bg-background hover:bg-muted",
              )}
            >
              {TIER_LABEL[t]}
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-3">
        {email ? (
          <ChannelCard
            label="Email"
            copyKey={`email:${rowId}:${activeTier}`}
            copyText={`Subject: ${email.subject}\n\n${email.body}`}
            copied={copied}
            onCopy={onCopy}
          >
            <div className="border-b pb-2">
              <span className="text-muted-foreground">Subject: </span>
              <span className="font-medium">{email.subject}</span>
            </div>
            <pre className="mt-2 whitespace-pre-wrap font-sans text-sm">
              {email.body}
            </pre>
          </ChannelCard>
        ) : null}
        {voicemail ? (
          <ChannelCard
            label="Voicemail"
            copyKey={`vm:${rowId}:${activeTier}`}
            copyText={voicemail}
            copied={copied}
            onCopy={onCopy}
          >
            <pre className="whitespace-pre-wrap font-sans text-sm">{voicemail}</pre>
          </ChannelCard>
        ) : null}
        {sms ? (
          <ChannelCard
            label={`SMS (${sms.length} chars)`}
            copyKey={`sms:${rowId}:${activeTier}`}
            copyText={sms}
            copied={copied}
            onCopy={onCopy}
          >
            <pre className="whitespace-pre-wrap font-sans text-sm">{sms}</pre>
          </ChannelCard>
        ) : null}
      </div>
    </div>
  );
}

// Row confidence: a deterministic 0-100 score derived from existing row data
// (Stage 2 fit, contact coverage, signal quality, Stage 4 lint result). No new
// DB columns or model calls — we just expose the implicit signal that's
// already in the row so the SDR knows which prospects to call first vs. which
// to flag for manual research.
//
// Only computed for rows that were supposed to be enriched (Tier 1/2/3) and
// have actually been through Stage 3. Excluded / low-fit / unprocessed rows
// return null and don't render a chip.
type ConfidenceBucket = "High" | "Medium" | "Low" | "Very Low";
type Confidence = { score: number; bucket: ConfidenceBucket; reasons: string[] };

const ENRICHABLE_TIERS: ReadonlySet<FitTier> = new Set([
  "tier_1",
  "tier_2",
  "tier_3",
]);

function computeConfidence(r: AccountRow): Confidence | null {
  if (!r.tierSnapshot || !ENRICHABLE_TIERS.has(r.tierSnapshot)) return null;
  if (!r.stage3Attempted) return null;

  const reasons: string[] = [];
  let score = 0;

  // Component 1: Stage 2 fit quality (0-25).
  const fit = r.scoreSnapshot ?? 0;
  const fitPts = Math.round(Math.min(25, (fit / 100) * 25));
  score += fitPts;
  if (fitPts >= 21) reasons.push(`Strong Stage 2 fit (${fit}/100)`);
  else if (fitPts >= 12) reasons.push(`Decent Stage 2 fit (${fit}/100)`);
  else reasons.push(`Weak Stage 2 fit (${fit}/100)`);

  // Component 2: Contact coverage (0-25). Bonus for exec presence.
  const n = r.contacts.length;
  const contactPts = n === 0 ? 0 : n === 1 ? 10 : n === 2 ? 18 : 25;
  score += contactPts;
  if (n === 0) {
    reasons.push("No contacts found");
  } else {
    const tiers = r.contacts.map((c) => TIER_LABEL[c.tier]).join(", ");
    reasons.push(`${n} contact${n === 1 ? "" : "s"} found (${tiers})`);
    if (!r.contacts.some((c) => c.tier === "exec")) {
      reasons.push("No exec-level contact");
    }
  }

  // Component 3: Signal quality (0-25). Spark source link is a verifiable
  // evidence URL — worth more than a cached signal with no link.
  if (!r.signal) {
    reasons.push("No GovSpend signal");
  } else if (r.signal.sourceLink) {
    score += 25;
    reasons.push("Signal cached with GovSpend source link");
  } else {
    score += 12;
    reasons.push("Signal cached, no GovSpend source link");
  }

  // Component 4: Outreach quality (0-25). Lint failure is a soft signal — the
  // copy might still be sendable, but a human should look.
  const flagged = r.variants?.needsReview ?? r.email?.needsReview ?? false;
  const hasOutreach = r.variants !== null || r.email !== null;
  if (!hasOutreach) {
    reasons.push("No outreach drafted yet");
  } else if (flagged) {
    score += 10;
    reasons.push("Outreach drafted, flagged for review");
  } else {
    score += 25;
    reasons.push("Outreach drafted and passed lint");
  }

  const bucket: ConfidenceBucket =
    score >= 80
      ? "High"
      : score >= 60
        ? "Medium"
        : score >= 40
          ? "Low"
          : "Very Low";

  return { score, bucket, reasons };
}

const BUCKET_STYLE: Record<ConfidenceBucket, string> = {
  High: "border-emerald-500/40 bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  Medium:
    "border-blue-500/40 bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-300",
  Low: "border-amber-500/40 bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
  "Very Low":
    "border-red-500/40 bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-300",
};

function ConfidenceChip({ c }: { c: Confidence }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide",
        BUCKET_STYLE[c.bucket],
      )}
      title={`Confidence ${c.score}/100`}
    >
      {c.bucket}
      <span className="tabular-nums opacity-70">{c.score}</span>
    </span>
  );
}

function ConfidenceReasons({ c }: { c: Confidence }) {
  const recommend =
    c.bucket === "Very Low" || c.bucket === "Low"
      ? c.bucket === "Very Low"
        ? "Recommend skipping this prospect — too little signal to send a credible email."
        : "Recommend manual research before sending — the drafted outreach may not land."
      : null;
  return (
    <div>
      <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Confidence
        <ConfidenceChip c={c} />
      </div>
      <ul className="space-y-1 text-sm">
        {c.reasons.map((r, i) => (
          <li key={i} className="flex items-baseline gap-2">
            <span className="text-muted-foreground">·</span>
            <span>{r}</span>
          </li>
        ))}
      </ul>
      {recommend ? (
        <div
          className={cn(
            "mt-2 rounded-md border px-3 py-2 text-sm",
            BUCKET_STYLE[c.bucket],
          )}
        >
          {recommend}
        </div>
      ) : null}
    </div>
  );
}

function ChannelCard({
  label,
  copyKey,
  copyText,
  copied,
  onCopy,
  children,
}: {
  label: string;
  copyKey: string;
  copyText: string;
  copied: string | null;
  onCopy: (key: string, text: string) => void;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-1 flex items-center justify-between gap-2">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          {label}
        </div>
        <button
          type="button"
          onClick={() => onCopy(copyKey, copyText)}
          className="rounded border bg-background px-2 py-0.5 text-xs hover:bg-muted"
        >
          {copied === copyKey ? "Copied!" : "Copy"}
        </button>
      </div>
      <div className="rounded-md border bg-background p-3 text-sm">{children}</div>
    </div>
  );
}
