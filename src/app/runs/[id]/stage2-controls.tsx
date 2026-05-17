"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { ProgressBar } from "@/components/progress-bar";
import { runStage2Batch } from "./actions";

type Props = {
  runId: string;
  remaining: number;
  totalReady: number;
  providerName: string;
};

// Brave free tier: 1 req/sec → ~1.1s per query in real-Brave mode.
// Mock provider is ~instant so we don't bother showing ETA.
const SECONDS_PER_BRAVE_QUERY = 1.2;

export function Stage2Controls({ runId, remaining, totalReady, providerName }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [runAll, setRunAll] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [errorList, setErrorList] = useState<
    Array<{ company: string; message: string }>
  >([]);

  const processed = totalReady - remaining;
  const usingRealApi = providerName === "brave";

  const runOnce = (continueAll: boolean) => {
    setStatus(null);
    setErrorList([]);
    if (continueAll) setRunAll(true);

    const loop = async () => {
      let keepGoing = true;
      while (keepGoing) {
        const result = await runStage2Batch(runId);
        const where = result.currentCompany
          ? ` · last: ${result.currentCompany}`
          : "";
        setStatus(`Processed ${result.processed}; ${result.remaining} remaining${where}.`);
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

  if (totalReady === 0) return null;

  return (
    <div className="flex flex-col gap-3">
      <ProgressBar
        done={processed}
        total={totalReady}
        pending={pending}
        secondsPerUnit={usingRealApi ? SECONDS_PER_BRAVE_QUERY : null}
        label={pending ? "Scoring in progress…" : "Scoring progress"}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={() => runOnce(false)} disabled={pending || remaining === 0}>
          {pending && !runAll ? "Running…" : `Run next 5`}
        </Button>
        <Button
          variant="outline"
          onClick={() => runOnce(true)}
          disabled={pending || remaining === 0}
        >
          {pending && runAll ? "Running all…" : "Run all"}
        </Button>
        <span className="text-xs text-muted-foreground">
          search: <code>{providerName}</code>
          {usingRealApi ? " · 1 req/sec (Brave free tier)" : ""}
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
