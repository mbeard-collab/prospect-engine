"use client";

type Props = {
  done: number;
  total: number;
  pending?: boolean;
  // Average seconds per unit, used to display ETA when pending.
  secondsPerUnit?: number | null;
  label?: string;
};

function formatEta(sec: number): string {
  if (sec < 60) return `${Math.ceil(sec)}s`;
  const m = Math.floor(sec / 60);
  const s = Math.ceil(sec % 60);
  return s === 0 ? `${m}m` : `${m}m ${s}s`;
}

export function ProgressBar({
  done,
  total,
  pending = false,
  secondsPerUnit = null,
  label,
}: Props) {
  const pct = total === 0 ? 100 : Math.min(100, Math.round((done / total) * 100));
  const remaining = Math.max(0, total - done);
  const etaSeconds =
    pending && secondsPerUnit && remaining > 0
      ? secondsPerUnit * remaining
      : null;

  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between text-xs text-muted-foreground">
        <span>{label ?? "Progress"}</span>
        <span className="tabular-nums">
          {done} / {total} ({pct}%)
          {etaSeconds !== null ? ` · ~${formatEta(etaSeconds)} remaining` : null}
        </span>
      </div>
      <div className="relative h-2 w-full overflow-hidden rounded-full bg-muted">
        <div
          className="h-full bg-foreground/80 transition-all duration-300 ease-out"
          style={{ width: `${pct}%` }}
        />
        {pending && pct < 100 ? (
          <div
            className="absolute inset-y-0 w-1/4 animate-[shimmer_1.4s_ease-in-out_infinite] bg-gradient-to-r from-transparent via-white/40 to-transparent dark:via-white/15"
            style={{ left: `${Math.max(0, pct - 12)}%` }}
          />
        ) : null}
      </div>
    </div>
  );
}
