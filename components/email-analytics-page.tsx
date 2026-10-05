"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

/** Mirrors GET /api/email-analytics (app/api/email-analytics/route.ts). */
interface AnalyticsResponse {
  ok: true;
  totals: { sent: number; failed: number; tasksDone: number; tasksActive: number };
  byDay: { date: string; sent: number; failed: number }[];
  byMailbox: {
    id: string;
    label: string;
    usedToday: number;
    dailyQuota: number;
    totalSent: number;
  }[];
  recent: {
    t: number;
    to: string;
    ok: boolean;
    error?: string;
    taskId: string;
    keyword: string;
    mailboxId: string;
  }[];
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-5">
      <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">{label}</p>
      <p className={`mt-2 text-3xl font-semibold tracking-tight ${accent ? "text-emerald-400" : "text-zinc-100"}`}>
        {value}
      </p>
    </div>
  );
}

/** Email Analytics: what the automation pipeline actually delivered, per day and per mailbox. */
export function EmailAnalyticsPage() {
  const [data, setData] = useState<AnalyticsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/email-analytics", { cache: "no-store" });
      const body = (await response.json()) as AnalyticsResponse & { error?: string };
      if (!response.ok) {
        setError(body.error ?? "Could not load analytics.");
        return;
      }
      setData(body);
      setError("");
    } catch {
      setError("Connection issue — retrying.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Deferred a tick so the effect body stays free of synchronous setState.
    const initial = window.setTimeout(() => void refresh(), 0);
    const timer = window.setInterval(() => void refresh(), 15_000);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(timer);
    };
  }, [refresh]);

  const mailboxLabels = useMemo(() => {
    const labels = new Map<string, string>();
    for (const box of data?.byMailbox ?? []) labels.set(box.id, box.label);
    return labels;
  }, [data]);

  const maxDay = Math.max(1, ...(data?.byDay ?? []).map((day) => day.sent + day.failed));

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-8 sm:px-6 lg:py-12">
      <header className="flex flex-col gap-2">
        <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-[0.2em] text-emerald-400">
          <span className="h-px w-6 bg-emerald-500/60" />
          Email analytics
        </div>
        <h1 className="text-3xl font-semibold tracking-tight text-zinc-50">Delivery report</h1>
        <p className="max-w-2xl text-sm leading-relaxed text-zinc-400">
          Live totals from every automated send — how much went out, what failed, and how each mailbox
          is tracking against its daily quota.{" "}
          <Link href="/email-settings" className="text-emerald-500 hover:text-emerald-400">
            Manage mailboxes →
          </Link>
        </p>
        {error && <p className="text-sm text-amber-400">{error}</p>}
      </header>

      {loading && !data ? (
        <p className="text-sm text-zinc-500">Loading analytics…</p>
      ) : !data ? (
        <p className="text-sm text-zinc-500">No data yet.</p>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Emails sent" value={String(data.totals.sent)} accent />
            <Stat label="Failed" value={String(data.totals.failed)} />
            <Stat label="Tasks done" value={String(data.totals.tasksDone)} />
            <Stat label="Tasks active" value={String(data.totals.tasksActive)} />
          </div>

          <section className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-5 sm:p-6">
            <h2 className="text-sm font-semibold text-zinc-100">Recent days</h2>
            {data.byDay.length === 0 ? (
              <p className="mt-4 text-sm text-zinc-500">No sends yet — schedule a task to get started.</p>
            ) : (
              <ul className="mt-4 flex flex-col gap-2">
                {data.byDay.map((day) => (
                  <li key={day.date} className="flex items-center gap-3">
                    <span className="w-24 shrink-0 font-mono text-xs text-zinc-500">{day.date}</span>
                    <div className="flex h-5 flex-1 overflow-hidden rounded bg-zinc-800">
                      <div
                        className="h-full bg-emerald-500"
                        style={{ width: `${(day.sent / maxDay) * 100}%` }}
                      />
                      <div
                        className="h-full bg-rose-500"
                        style={{ width: `${(day.failed / maxDay) * 100}%` }}
                      />
                    </div>
                    <span className="w-32 shrink-0 text-right font-mono text-xs text-zinc-400">
                      {day.sent} sent{day.failed > 0 ? ` · ${day.failed} failed` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-5 sm:p-6">
            <h2 className="text-sm font-semibold text-zinc-100">By mailbox</h2>
            {data.byMailbox.length === 0 ? (
              <p className="mt-4 text-sm text-zinc-500">
                No mailboxes connected —{" "}
                <Link href="/email-settings" className="text-emerald-500 hover:text-emerald-400">
                  connect one
                </Link>
                .
              </p>
            ) : (
              <ul className="mt-4 flex flex-col divide-y divide-zinc-800">
                {data.byMailbox.map((box) => {
                  const pct = Math.min(
                    100,
                    Math.round((box.usedToday / Math.max(1, box.dailyQuota)) * 100),
                  );
                  return (
                    <li key={box.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                      <span className="text-sm text-zinc-200">
                        {box.label}{" "}
                        <span className="font-mono text-xs text-zinc-500">
                          · {box.totalSent} all-time
                        </span>
                      </span>
                      <div className="flex items-center gap-3">
                        <div className="h-1.5 w-40 overflow-hidden rounded-full bg-zinc-800">
                          <div
                            className={`h-full rounded-full ${pct >= 100 ? "bg-amber-500" : "bg-emerald-500"}`}
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                        <span className="font-mono text-xs text-zinc-400">
                          {box.usedToday} / {box.dailyQuota} today
                        </span>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          <section className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-5 sm:p-6">
            <h2 className="text-sm font-semibold text-zinc-100">Recent sends</h2>
            {data.recent.length === 0 ? (
              <p className="mt-4 text-sm text-zinc-500">Nothing sent yet.</p>
            ) : (
              <div className="mt-4 overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="border-b border-zinc-800 text-xs uppercase tracking-wide text-zinc-500">
                      <th className="py-2 pr-4">Time</th>
                      <th className="py-2 pr-4">To</th>
                      <th className="py-2 pr-4">Keyword</th>
                      <th className="py-2 pr-4">Mailbox</th>
                      <th className="py-2">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-800/70">
                    {data.recent.map((entry, index) => (
                      <tr key={`${entry.t}-${index}`}>
                        <td className="py-2 pr-4 font-mono text-xs text-zinc-500">
                          {new Date(entry.t).toLocaleString()}
                        </td>
                        <td className="max-w-56 truncate py-2 pr-4 text-zinc-300">{entry.to}</td>
                        <td className="max-w-40 truncate py-2 pr-4 text-zinc-400">{entry.keyword}</td>
                        <td className="max-w-40 truncate py-2 pr-4 text-zinc-400">
                          {mailboxLabels.get(entry.mailboxId) ?? entry.mailboxId.slice(0, 8)}
                        </td>
                        <td
                          className={`py-2 ${entry.ok ? "text-emerald-400" : "text-rose-400"}`}
                          title={entry.ok ? undefined : entry.error}
                        >
                          {entry.ok ? "sent" : `failed — ${(entry.error ?? "error").slice(0, 60)}`}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
