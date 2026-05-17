"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { ProgressBar } from "@/components/progress-bar";
import { runStage4Batch } from "./actions";

type Props = {
  runId: string;
  remaining: number;
  totalTier12: number;
  hasAnthropicKey: boolean;
};

export function Stage4Controls({
  runId,
  remaining,
  totalTier12,
  hasAnthropicKey,
}: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [runAll, setRunAll] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [spend, setSpend] = useState(0);
  const [errorList, setErrorList] = useState<
    Array<{ company: string; message: string }>
  >([]);

  const processed = totalTier12 - remaining;

  if (!hasAnthropicKey) {
    return (
      <p className="text-sm text-muted-foreground">
        Set <code>PROSPECT_ANTHROPIC_KEY</code> in <code>.env.local</code> and restart
        the dev server to enable Stage 4. (Not <code>ANTHROPIC_API_KEY</code> — Netlify
        intercepts that name in production.)
      </p>
    );
  }

  if (totalTier12 === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No Tier 1 or Tier 2 accounts in this run yet. Run Stage 2 first.
      </p>
    );
  }

  const runOnce = (continueAll: boolean) => {
    setStatus(null);
    setErrorList([]);
    if (continueAll) setRunAll(true);

    const loop = async () => {
      let keepGoing = true;
      while (keepGoing) {
        const result = await runStage4Batch(runId);
        setSpend((s) => s + result.totalDollars);
        const where = result.currentCompany
          ? ` · last: ${result.currentCompany}`
          : "";
        setStatus(
          `Drafted ${result.processed} email${result.processed === 1 ? "" : "s"}; ${result.remaining} remaining${where}.`,
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

  return (
    <div className="flex flex-col gap-3">
      <ProgressBar
        done={processed}
        total={totalTier12}
        pending={pending}
        secondsPerUnit={2.5}
        label={pending ? "Drafting in progress…" : "Drafting progress"}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={() => runOnce(false)} disabled={pending || remaining === 0}>
          {pending && !runAll ? "Drafting…" : `Draft next 5`}
        </Button>
        <Button
          variant="outline"
          onClick={() => runOnce(true)}
          disabled={pending || remaining === 0}
        >
          {pending && runAll ? "Drafting all…" : "Draft all"}
        </Button>
        <span className="text-xs text-muted-foreground">
          model: <code>claude-sonnet-4-6</code>
        </span>
      </div>
      {spend > 0 ? (
        <p className="text-xs text-muted-foreground">
          This session: ~${spend.toFixed(4)} ({pending ? "in flight" : "done"})
        </p>
      ) : null}
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
