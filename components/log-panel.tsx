"use client";

import { useEffect, useRef } from "react";
import type { LogEntry, LogKind } from "@/types/run";

interface LogPanelProps {
  entries: LogEntry[];
}

const KIND_CLASS: Record<LogKind, string> = {
  info: "text-zinc-400",
  warn: "text-amber-400",
  error: "text-rose-400",
  lead: "text-emerald-400",
  phase: "text-sky-400",
  done: "text-emerald-300 font-medium",
};

const KIND_TAG: Record<LogKind, string> = {
  info: "",
  warn: "warn",
  error: "error",
  lead: "lead",
  phase: "phase",
  done: "done",
};

function clock(t: number): string {
  const d = new Date(t);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * The live, timestamped activity log: every phase change, keyword round,
 * wave, lead and warning the run produces, newest at the bottom. The server
 * curates this list (per-query spam stays in the counters), so it stays
 * readable while a run issues thousands of requests.
 */
export function LogPanel({ entries }: LogPanelProps) {
  const endRef = useRef<HTMLDivElement | null>(null);
  const lastId = entries[entries.length - 1]?.id;

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "nearest" });
  }, [entries.length, lastId]);

  return (
    <section className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-5 sm:p-6">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-xs font-medium uppercase tracking-[0.2em] text-zinc-400">Live log</h2>
        <span className="font-mono text-xs text-zinc-500">{entries.length} entries</span>
      </div>
      <div className="mt-3 max-h-64 overflow-y-auto rounded-lg border border-zinc-800/80 bg-zinc-950/60 p-3">
        {entries.length === 0 ? (
          <p className="py-2 text-xs text-zinc-600">
            No activity yet — the run logs its first line as soon as the runner picks it up.
          </p>
        ) : (
          <ul className="flex flex-col gap-1 font-mono text-xs leading-relaxed">
            {entries.map((entry) => (
              <li key={entry.id} className="flex gap-2.5">
                <span className="shrink-0 text-zinc-600">{clock(entry.t)}</span>
                {KIND_TAG[entry.kind] && (
                  <span
                    className={`shrink-0 uppercase tracking-wide ${KIND_CLASS[entry.kind]} opacity-70`}
                  >
                    {KIND_TAG[entry.kind]}
                  </span>
                )}
                <span className={KIND_CLASS[entry.kind]}>{entry.message}</span>
              </li>
            ))}
            <div ref={endRef} />
          </ul>
        )}
      </div>
    </section>
  );
}
