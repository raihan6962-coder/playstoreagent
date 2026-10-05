"use client";

import type { DoneReason, GenerationStats } from "@/types/lead";

interface ProgressPanelProps {
  running: boolean;
  stats: GenerationStats | null;
  message: string;
  warnings: string[];
  error: string | null;
  done: { reason: DoneReason; message: string } | null;
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 px-3 py-2.5">
      <div className="text-[11px] uppercase tracking-wide text-zinc-500">{label}</div>
      <div className="mt-0.5 font-mono text-sm text-zinc-100">{value}</div>
    </div>
  );
}

function hintFor(reason: DoneReason): string | null {
  switch (reason) {
    case "plan-exhausted":
      return "Play Store rarely ranks very low rated apps for head-term searches. Try a higher maximum rating, a higher install cap, or a more specific keyword.";
    case "no-results":
      return "Nothing was indexed for that keyword. Try a broader or shorter keyword.";
    case "rate-limited":
      return "Play Store throttled the requests — the runner resumes itself once the window clears.";
    case "budget-exhausted":
      return "The step ran out of time — the search continues automatically.";
    case "query-cap":
      return "Safety cap so an unproductive keyword cannot spin forever. Press Resume to grant another 50,000 queries and keep searching.";
    case "failed":
      return "The run stopped because the Play Store could no longer be read.";
    default:
      return null;
  }
}

export function ProgressPanel({
  running,
  stats,
  message,
  warnings,
  error,
  done,
}: ProgressPanelProps) {
  const target = stats?.target ?? 0;
  const matched = stats?.matched ?? 0;
  const percent = target > 0 ? Math.min(100, Math.round((matched / target) * 100)) : 0;
  const queries = stats
    ? `${stats.queriesRun}/${stats.queriesTotal}` +
      (stats.wave > 0 ? ` · wave ${stats.wave + 1}` : "")
    : "0/0";
  const showPanel = running || Boolean(done) || Boolean(error) || warnings.length > 0;
  if (!showPanel) return null;

  const tone =
    error || done?.reason === "failed"
      ? "border-rose-500/40 bg-rose-500/5"
      : done?.reason === "plan-exhausted" ||
          done?.reason === "no-results" ||
          done?.reason === "query-cap"
        ? "border-amber-500/40 bg-amber-500/5"
        : done
          ? "border-emerald-500/40 bg-emerald-500/5"
          : "border-zinc-800 bg-zinc-900/60";

  return (
    <section className={`rounded-2xl border p-5 sm:p-6 ${tone}`}>
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-2.5 text-sm text-zinc-200">
          <span
            className={`inline-block h-2 w-2 rounded-full ${
              running ? "animate-pulse bg-emerald-400" : "bg-zinc-500"
            }`}
          />
          <span>{error ?? message}</span>
        </div>
        {stats && (
          <span className="font-mono text-xs text-zinc-400">
            {matched}/{target} leads
          </span>
        )}
      </div>

      <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-zinc-800">
        <div
          className="h-full rounded-full bg-emerald-500 transition-all duration-500"
          style={{ width: `${percent}%` }}
        />
      </div>

      {stats && (
        <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
          <Stat label="Apps discovered" value={String(stats.discovered)} />
          <Stat label="Apps evaluated" value={String(stats.evaluated)} />
          <Stat label="Duplicates skipped" value={String(stats.duplicates)} />
          <Stat label="Queries run" value={queries} />
          <Stat label="Pages fetched" value={String(stats.pagesFetched)} />
          <Stat
            label="Lowest rating seen"
            value={stats.lowestRatingSeen === null ? "—" : stats.lowestRatingSeen.toFixed(1)}
          />
        </div>
      )}

      {done && (
        <div className="mt-4 flex flex-col gap-1">
          <p className="text-sm font-medium text-zinc-100">{done.message}</p>
          {hintFor(done.reason) && (
            <p className="text-xs leading-relaxed text-zinc-400">{hintFor(done.reason)}</p>
          )}
        </div>
      )}

      {warnings.length > 0 && (
        <ul className="mt-4 flex flex-col gap-1 border-t border-zinc-800 pt-3">
          {warnings.slice(-4).map((warning, index) => (
            <li key={`${warning}-${index}`} className="text-xs text-zinc-400">
              {warning}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
