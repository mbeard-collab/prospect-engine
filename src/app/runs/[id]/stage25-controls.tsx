"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { ProgressBar } from "@/components/progress-bar";
import { runStage25Batch } from "./actions";

// Stage 2.5 controls: web-grounded competitor research for Tier 1/2/3
// companies. Cached on companies with 90-day TTL; re-running the same CSV is
// a no-op for repeat companies.

type Props = {
  runId: string;
  remaining: number;
  totalEnrichable: number;
  providerName: string;
};

export function Stage25Controls({
  runId,
  remaining,
  totalEnrichable,
  providerName,
}: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [runAll, setRunAll] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [errorList, setErrorList] = useState<
    Array<{ company: string; message: string }>
  >([]);

  const processed = totalEnrichable - remaining;

  const runOnce = (continueAll: boolean) => {
    setStatus(null);
    setErrorList([]);
    if (continueAll) setRunAll(true);

    const loop = async () => {
      let keepGoing = true;
      while (keepGoing) {
        const result = await runStage25Batch(runId);
        const where = result.currentCompany
          ? ` · last: ${result.currentCompany}`
          : "";
        setStatus(
          `Researched ${result.processed}; ${result.remaining} remaining (${result.total} need work)${where}.`,
        );
        if (result.errors.length) {
          setErrorList((prev) => [...prev, ...result.errors]);
        }
        keepGoing = continueAll && result.remaining > 0 && result.processed > 0;
        router.refresh();
      }
      setRunAll(false);
    };
    startTransition(() => {
      void loop();
    });
  };

  if (totalEnrichable === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No Tier 1/2/3 accounts in this run yet. Run Stage 2 first.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <ProgressBar
        done={processed}
        total={totalEnrichable}
        pending={pending}
        label={
          pending
            ? "Researching competitors…"
            : "Competitor research progress"
        }
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button
          onClick={() => runOnce(false)}
          disabled={pending || remaining === 0}
        >
          {pending && !runAll ? "Running…" : "Research next 3"}
        </Button>
        <Button
          variant="outline"
          onClick={() => runOnce(true)}
          disabled={pending || remaining === 0}
        >
          {pending && runAll ? "Researching all…" : "Research all"}
        </Button>
        <span className="text-xs text-muted-foreground">
          provider: <code>{providerName}</code>
        </span>
      </div>
      {status ? <p className="text-xs text-muted-foreground">{status}</p> : null}
      {errorList.length > 0 ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 p-2 text-xs">
          <div className="font-medium text-destructive">
            {errorList.length} error{errorList.length === 1 ? "" : "s"}:
          </div>
          <ul className="mt-1 list-disc pl-4 text-muted-foreground">
            {errorList.slice(0, 5).map((e, i) => (
              <li key={i}>
                <span className="font-medium">{e.company}</span>: {e.message}
              </li>
            ))}
            {errorList.length > 5 ? (
              <li>… and {errorList.length - 5} more</li>
            ) : null}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
