"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { parseAccountsCsv, readCsvText } from "@/lib/csv";
import {
  checkExclusion,
  cleanCompanyName,
  type IndustryCategory,
} from "@/lib/prefilter";
import { TierBadge } from "@/components/tier-badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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

type Row = {
  original: string;
  clean: string;
  rank: number;
  excluded: boolean;
  industry: IndustryCategory | null;
  reason: string | null;
};

const SAMPLE_CSV = `Company Name,Website,State
Tyler Technologies,tylertech.com,TX
Acme Construction LLC,acmebuilders.com,FL
First National Bank,fnb.com,OH
Smith & Jones Attorneys at Law,smithjones.com,NY
Acme HVAC and Plumbing,acmehvac.com,GA
Civic Systems Inc,civicsys.com,CA
Granicus,granicus.com,CO
OpenGov,opengov.com,CA
Beard Plumbing,beardplumbing.com,FL
Quantum Engineering Software,quantumeng.com,WA
Sigma Engineering Associates,sigmaeng.com,IL
Veritas Real Estate Brokers,veritasre.com,NJ
ChiroCare Family Practice,chirocare.com,CA
Axon Public Safety,axon.com,AZ
Capital Wealth Management,capitalwealth.com,MA
Motorola Solutions,motorolasolutions.com,IL
NIC Inc,nicusa.com,KS
Acme Roofing & Drywall,acmeroof.com,TX
Frontier Real Estate Realtors,frontierre.com,UT
Esri,esri.com,CA`;

export default function DemoPage() {
  const [csvText, setCsvText] = useState("");
  const [filename, setFilename] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rows, setRows] = useState<Row[] | null>(null);

  const run = (text: string, name: string | null) => {
    setError(null);
    try {
      const parsed = parseAccountsCsv(text);
      const seen = new Set<string>();
      const built: Row[] = [];
      for (const r of parsed.rows) {
        const clean = cleanCompanyName(r.name);
        const key = clean.toLowerCase();
        if (!key || seen.has(key)) continue;
        seen.add(key);
        const result = checkExclusion(r.name);
        built.push({
          original: r.name,
          clean,
          rank: 0,
          excluded: result.excluded,
          industry: result.excluded ? result.category : null,
          reason: result.excluded ? result.reason : null,
        });
      }
      built.sort((a, b) =>
        a.clean.localeCompare(b.clean, undefined, { sensitivity: "base" }),
      );
      built.forEach((r, i) => (r.rank = i + 1));
      setRows(built);
      setFilename(name);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setRows(null);
    }
  };

  const onFile = async (file: File) => {
    setCsvText("");
    const text = await readCsvText(file);
    run(text, file.name);
  };

  const counts = useMemo(() => {
    if (!rows) return { total: 0, excluded: 0, ready: 0 };
    const excluded = rows.filter((r) => r.excluded).length;
    return { total: rows.length, excluded, ready: rows.length - excluded };
  }, [rows]);

  const breakdown = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of rows ?? []) {
      if (!r.excluded || !r.industry) continue;
      m.set(r.industry, (m.get(r.industry) ?? 0) + 1);
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [rows]);

  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b bg-background">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-6">
          <div className="flex items-center gap-3">
            <span className="text-sm font-semibold">Prospect Engine</span>
            <span className="rounded border bg-muted/40 px-1.5 py-0.5 text-xs text-muted-foreground">
              Demo · no sign-in
            </span>
          </div>
          <Link
            href="/login"
            className={buttonVariants({ variant: "ghost", size: "sm" })}
          >
            Sign in for full pipeline
          </Link>
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-8">
        <h1 className="text-2xl font-semibold tracking-tight">
          Stage 1 demo — keyword pre-filter
        </h1>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
          Drop a CSV of accounts. We auto-flag obvious Low Fit companies
          (construction, banks, law firms, hyperlocal trades) before any external
          calls. Everything runs in your browser — no data leaves this tab.
        </p>

        <Card className="mt-6">
          <CardHeader>
            <CardTitle>Upload or paste</CardTitle>
            <CardDescription>
              CSV must include a company name column.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="file">CSV file</Label>
              <Input
                id="file"
                type="file"
                accept=".csv,text/csv"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) onFile(f);
                }}
              />
            </div>
            <div className="text-center text-xs uppercase tracking-wide text-muted-foreground">
              or
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="paste">Paste CSV text</Label>
              <textarea
                id="paste"
                value={csvText}
                onChange={(e) => setCsvText(e.target.value)}
                placeholder="Company Name,Website,State&#10;Acme Construction LLC,acme.com,TX&#10;..."
                className="min-h-32 w-full rounded-md border bg-background px-3 py-2 text-sm font-mono"
              />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                onClick={() => run(csvText, "pasted.csv")}
                disabled={!csvText.trim()}
              >
                Run Stage 1
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  setCsvText(SAMPLE_CSV);
                  run(SAMPLE_CSV, "sample-territory.csv");
                }}
              >
                Try sample (20 accounts)
              </Button>
              {filename ? (
                <span className="text-xs text-muted-foreground">{filename}</span>
              ) : null}
            </div>
            {error ? (
              <p className="text-sm text-destructive">{error}</p>
            ) : null}
          </CardContent>
        </Card>

        {rows ? (
          <>
            <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
              <Card>
                <CardHeader className="pb-2">
                  <CardDescription>Total accounts</CardDescription>
                  <CardTitle className="text-3xl tabular-nums">
                    {counts.total}
                  </CardTitle>
                </CardHeader>
              </Card>
              <Card>
                <CardHeader className="pb-2">
                  <CardDescription>Auto-excluded (Stage 1)</CardDescription>
                  <CardTitle className="text-3xl tabular-nums text-red-600">
                    {counts.excluded}
                  </CardTitle>
                </CardHeader>
              </Card>
              <Card>
                <CardHeader className="pb-2">
                  <CardDescription>Ready for Stage 2</CardDescription>
                  <CardTitle className="text-3xl tabular-nums text-emerald-600">
                    {counts.ready}
                  </CardTitle>
                </CardHeader>
              </Card>
            </div>

            {breakdown.length > 0 ? (
              <Card className="mt-6">
                <CardHeader>
                  <CardTitle>Excluded by industry</CardTitle>
                  <CardDescription>From the keyword pre-filter</CardDescription>
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
                      {breakdown.map(([k, v]) => (
                        <TableRow key={k}>
                          <TableCell>{k}</TableCell>
                          <TableCell className="text-right tabular-nums">
                            {v}
                          </TableCell>
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
                  {rows.length} rows · Stage 1 only (Stages 2-4 require sign-in)
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-10">#</TableHead>
                      <TableHead>Original name</TableHead>
                      <TableHead>Clean name</TableHead>
                      <TableHead>Industry</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Reason</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.map((r) => (
                      <TableRow key={r.rank}>
                        <TableCell className="text-muted-foreground tabular-nums">
                          {r.rank}
                        </TableCell>
                        <TableCell className="max-w-[24rem] font-medium whitespace-normal">
                          {r.original}
                        </TableCell>
                        <TableCell className="max-w-[20rem] whitespace-normal text-muted-foreground">
                          {r.clean}
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {r.industry ?? "—"}
                        </TableCell>
                        <TableCell>
                          <TierBadge tier={r.excluded ? "excluded" : null} />
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {r.reason ?? (
                            <span className="text-emerald-600">
                              Ready for Stage 2
                            </span>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </>
        ) : null}
      </main>
    </div>
  );
}
