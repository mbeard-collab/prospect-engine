"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { ProgressBar } from "@/components/progress-bar";
import {
  runStage2Batch,
  runStage25Batch,
  runStage3Batch,
  runStage4Batch,
} from "./actions";

type StageId = "stage2" | "stage25" | "stage3" | "stage4";

type Props = {
  runId: string;
  // Initial counts from the server, used to decide whether to auto-start and
  // to render starting progress before the first batch returns.
  stage2: { processed: number; total: number };
  stage25: { processed: number; total: number };
  stage3: { processed: number; total: number };
  stage4: { processed: number; total: number };
};

type StageState = {
  id: StageId;
  label: string;
  processed: number;
  total: number;
  currentCompany: string | null;
};

const STAGE_LABELS: Record<StageId, string> = {
  stage2: "Stage 2 — web fit scoring",
  stage25: "Stage 2.5 — competitor research",
  stage3: "Stage 3 — contact + signal enrichment",
  stage4: "Stage 4 — email drafting",
};

export function AutoPipelineRunner({
  runId,
  stage2: stage2Init,
  stage25: stage25Init,
  stage3: stage3Init,
  stage4: stage4Init,
}: Props) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [stage, setStage] = useState<StageState | null>(null);
  const [errors, setErrors] = useState<Array<{ company: string; message: string }>>([]);
  const [totalDollars, setTotalDollars] = useState(0);
  const autoStartedRef = useRef(false);

  const stage2Remaining = stage2Init.total - stage2Init.processed;
  const stage25Remaining = stage25Init.total - stage25Init.processed;
  const stage3Remaining = stage3Init.total - stage3Init.processed;
  const stage4Remaining = stage4Init.total - stage4Init.processed;
  const totalRemaining =
    stage2Remaining + stage25Remaining + stage3Remaining + stage4Remaining;

  // Auto-start if the URL says ?auto=1 (set by /runs/new on redirect) and
  // there's work to do. Only fires once per mount.
  useEffect(() => {
    if (autoStartedRef.current) return;
    if (searchParams.get("auto") !== "1") return;
    if (totalRemaining === 0) return;
    if (running || done) return;
    autoStartedRef.current = true;
    // Defer one tick so the page can hydrate first.
    setTimeout(() => void run(), 100);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const run = async () => {
    setRunning(true);
    setErrorMsg(null);
    setErrors([]);
    setDone(false);

    try {
      // STAGE 2
      let s2 = { ...stage2Init };
      while (s2.total - s2.processed > 0) {
        setStage({
          id: "stage2",
          label: STAGE_LABELS.stage2,
          processed: s2.processed,
          total: s2.total,
          currentCompany: null,
        });
        const r = await runStage2Batch(runId);
        if (r.errors.length) setErrors((p) => [...p, ...r.errors]);
        s2 = { processed: s2.total - r.remaining, total: s2.total };
        setStage({
          id: "stage2",
          label: STAGE_LABELS.stage2,
          processed: s2.processed,
          total: s2.total,
          currentCompany: r.currentCompany ?? null,
        });
        if (r.remaining === 0 || r.processed === 0) break;
      }
      router.refresh();

      // STAGE 2.5 — competitor research for Tier 1/2/3 companies. Total can
      // grow once Stage 2 has tagged tiers, so we drive at least one call and
      // let the action report its real total.
      let s25Total = stage25Init.total;
      let s25Processed = stage25Init.processed;
      while (true) {
        setStage({
          id: "stage25",
          label: STAGE_LABELS.stage25,
          processed: s25Processed,
          total: Math.max(s25Total, 1),
          currentCompany: null,
        });
        const r = await runStage25Batch(runId);
        if (r.errors.length) setErrors((p) => [...p, ...r.errors]);
        s25Total = Math.max(s25Total, r.processed + r.remaining + s25Processed);
        s25Processed += r.processed;
        setStage({
          id: "stage25",
          label: STAGE_LABELS.stage25,
          processed: s25Processed,
          total: s25Total,
          currentCompany: r.currentCompany ?? null,
        });
        if (r.remaining === 0 || r.processed === 0) break;
      }
      router.refresh();

      // STAGE 3 — total may grow once Stage 2 has run, so requery via 0/0 first
      // and let the action tell us the real total.
      let s3Total = stage3Init.total;
      let s3Processed = stage3Init.processed;
      // Drive at least once so the action returns fresh `total` based on
      // post-Stage-2 tier_1/2 counts.
      while (true) {
        setStage({
          id: "stage3",
          label: STAGE_LABELS.stage3,
          processed: s3Processed,
          total: Math.max(s3Total, 1),
          currentCompany: null,
        });
        const r = await runStage3Batch(runId);
        if (r.errors.length) setErrors((p) => [...p, ...r.errors]);
        // First call: action's `total` includes already-processed + remaining.
        // Use it to update our view.
        s3Total = Math.max(s3Total, r.processed + r.remaining + s3Processed);
        s3Processed += r.processed;
        setStage({
          id: "stage3",
          label: STAGE_LABELS.stage3,
          processed: s3Processed,
          total: s3Total,
          currentCompany: r.currentCompany ?? null,
        });
        if (r.remaining === 0 || r.processed === 0) break;
      }
      router.refresh();

      // STAGE 4
      let s4Total = stage4Init.total;
      let s4Processed = stage4Init.processed;
      while (true) {
        setStage({
          id: "stage4",
          label: STAGE_LABELS.stage4,
          processed: s4Processed,
          total: Math.max(s4Total, 1),
          currentCompany: null,
        });
        const r = await runStage4Batch(runId);
        if (r.errors.length) setErrors((p) => [...p, ...r.errors]);
        if (r.totalDollars) setTotalDollars((d) => d + r.totalDollars);
        s4Total = Math.max(s4Total, r.processed + r.remaining + s4Processed);
        s4Processed += r.processed;
        setStage({
          id: "stage4",
          label: STAGE_LABELS.stage4,
          processed: s4Processed,
          total: s4Total,
          currentCompany: r.currentCompany ?? null,
        });
        if (r.remaining === 0 || r.processed === 0) break;
      }
      router.refresh();
      setDone(true);
      setStage(null);
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  };

  if (totalRemaining === 0 && !running && !done) {
    return null; // nothing to do — hide
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={run} disabled={running}>
          {running
            ? "Running pipeline…"
            : done
              ? "Re-run pipeline"
              : "Run full pipeline (Stage 2 → 3 → 4)"}
        </Button>
        {totalDollars > 0 ? (
          <span className="text-xs text-muted-foreground">
            Anthropic spend: ${totalDollars.toFixed(4)}
          </span>
        ) : null}
      </div>

      {stage ? (
        <div className="space-y-2 rounded-md border bg-muted/30 p-3">
          <div className="text-sm font-medium">{stage.label}</div>
          <ProgressBar
            done={stage.processed}
            total={stage.total}
            pending={running}
            label={
              stage.currentCompany
                ? `Currently: ${stage.currentCompany}`
                : "Working…"
            }
          />
        </div>
      ) : null}

      {done && !errorMsg ? (
        <p className="text-sm text-emerald-600">
          Pipeline complete. Scroll down to review tier distribution, signals,
          and email drafts.
        </p>
      ) : null}

      {errorMsg ? (
        <p className="text-sm text-destructive">{errorMsg}</p>
      ) : null}

      {errors.length > 0 ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 p-2 text-xs">
          <div className="font-medium text-destructive">
            {errors.length} error{errors.length === 1 ? "" : "s"} during pipeline:
          </div>
          <ul className="mt-1 list-disc pl-4 text-muted-foreground">
            {errors.slice(0, 6).map((e, i) => (
              <li key={i}>
                <span className="font-medium">{e.company}</span>: {e.message}
              </li>
            ))}
            {errors.length > 6 ? <li>… and {errors.length - 6} more</li> : null}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
