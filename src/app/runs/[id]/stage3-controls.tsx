"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { ProgressBar } from "@/components/progress-bar";
import { runStage3Batch } from "./actions";

type Props = {
  runId: string;
  remaining: number;
  totalTier12: number;
  contactProviderName: string;
  signalProviderName: string;
};

export function Stage3Controls({
  runId,
  remaining,
  totalTier12,
  contactProviderName,
  signalProviderName,
}: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [runAll, setRunAll] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [errorList, setErrorList] = useState<
    Array<{ company: string; message: string }>
  >([]);

  const processed = totalTier12 - remaining;

  const runOnce = (continueAll: boolean) => {
    setStatus(null);
    setErrorList([]);
    if (continueAll) setRunAll(true);

    const loop = async () => {
      let keepGoing = true;
      while (keepGoing) {
        const result = await runStage3Batch(runId);
        const where = result.currentCompany
          ? ` · last: ${result.currentCompany}`
          : "";
        setStatus(
          `Enriched ${result.processed}; ${result.remaining} remaining (${result.total} need work)${where}.`,
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

  if (totalTier12 === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No Tier 1 or Tier 2 accounts in this run yet. Run Stage 2 first.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <ProgressBar
        done={processed}
        total={totalTier12}
        pending={pending}
        label={pending ? "Enrichment in progress…" : "Enrichment progress"}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button
          onClick={() => runOnce(false)}
          disabled={pending || remaining === 0}
        >
          {pending && !runAll ? "Running…" : `Enrich next 10`}
        </Button>
        <Button
          variant="outline"
          onClick={() => runOnce(true)}
          disabled={pending || remaining === 0}
        >
          {pending && runAll ? "Enriching all…" : "Enrich all"}
        </Button>
        <span className="text-xs text-muted-foreground">
          contacts: <code>{contactProviderName}</code> · signals:{" "}
          <code>{signalProviderName}</code>
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
