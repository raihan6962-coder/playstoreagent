"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { LeadTable } from "@/components/lead-table";
import { csvFilename, leadsToCsv } from "@/lib/csv/export";
import type { Lead } from "@/types/lead";

interface LeadGroup {
  runId: string;
  taskId: string | null;
  keyword: string;
  leads: Lead[];
}

/** Everything the pipeline collected: one group per task run + the attached manual run. */
export function LeadsPage() {
  const [groups, setGroups] = useState<LeadGroup[]>([]);
  const [selected, setSelected] = useState<string>("all");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    try {
      const requests: Promise<Response>[] = [fetch("/api/leads", { cache: "no-store" })];
      // The run the Automation page attached to (manual, non-task collection).
      let attached: { runId?: string } | null = null;
      try {
        const raw = window.localStorage.getItem("psa.activeRun");
        if (raw) attached = JSON.parse(raw) as { runId?: string };
      } catch {
        attached = null;
      }
      if (attached?.runId) {
        requests.push(fetch(`/api/leads?runId=${encodeURIComponent(attached.runId)}`, { cache: "no-store" }));
      }

      const responses = await Promise.all(requests);
      const merged: LeadGroup[] = [];
      let failed = 0;
      for (const response of responses) {
        if (!response.ok) {
          failed += 1;
          continue;
        }
        const body = (await response.json()) as { runs?: LeadGroup[] };
        for (const group of body.runs ?? []) {
          if (!merged.some((entry) => entry.runId === group.runId)) merged.push(group);
        }
      }
      setGroups(merged);
      setError(failed > 0 && merged.length === 0 ? "Could not load leads — retrying." : "");
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

  const visible = useMemo(
    () => (selected === "all" ? groups : groups.filter((group) => group.runId === selected)),
    [groups, selected],
  );
  const leads = useMemo(() => visible.flatMap((group) => group.leads), [visible]);

  function exportCsv(): void {
    if (leads.length === 0) return;
    const blob = new Blob(["\uFEFF" + leadsToCsv(leads)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = csvFilename("automation-leads");
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-8 sm:px-6 lg:py-12">
      <header className="flex flex-col gap-2">
        <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-[0.2em] text-emerald-400">
          <span className="h-px w-6 bg-emerald-500/60" />
          Leads
        </div>
        <h1 className="text-3xl font-semibold tracking-tight text-zinc-50">Collected leads</h1>
        <p className="max-w-2xl text-sm leading-relaxed text-zinc-400">
          Every lead the automations found, per run — the same rows the pipeline mails to. Refreshes
          automatically while a collection is live.
        </p>
      </header>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <select
            className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200 outline-none focus:border-emerald-500"
            value={selected}
            onChange={(event) => setSelected(event.target.value)}
          >
            <option value="all">All runs ({groups.length})</option>
            {groups.map((group) => (
              <option key={group.runId} value={group.runId}>
                {group.keyword || "manual run"} — {group.leads.length} leads ·{" "}
                {new Date().toLocaleDateString()}
              </option>
            ))}
          </select>
          <p className="text-sm text-zinc-400">
            <span className="font-medium text-zinc-200">{leads.length}</span> lead
            {leads.length === 1 ? "" : "s"} shown
          </p>
          {error && <span className="text-sm text-amber-400">{error}</span>}
        </div>
        <button
          type="button"
          onClick={exportCsv}
          disabled={leads.length === 0}
          className="rounded-lg border border-zinc-700 px-4 py-2 text-sm font-medium text-zinc-200 transition hover:border-emerald-500 hover:text-emerald-400 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Export CSV
        </button>
      </div>

      {loading ? (
        <p className="text-sm text-zinc-500">Loading leads…</p>
      ) : (
        <LeadTable leads={leads} />
      )}
    </div>
  );
}
