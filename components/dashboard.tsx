"use client";

import { useRef, useState } from "react";
import { mergeLead, runGeneration } from "@/lib/client/generation";
import { csvFilename, leadsToCsv } from "@/lib/csv/export";
import { leadPassesFilters } from "@/lib/filters/leadFilter";
import {
  parseInstallInput,
  validateCountry,
  validateKeyword,
  validateLimit,
  validateMaxRating,
} from "@/lib/validation/input";
import type {
  DoneReason,
  GenerationEvent,
  GenerationStats,
  Lead,
  LeadFilters,
  SessionCursor,
} from "@/types/lead";
import { LeadTable } from "./lead-table";
import { ProgressPanel } from "./progress-panel";
import { SearchForm, type SearchValues } from "./search-form";

/**
 * Each step streams for up to ~4 minutes server-side; these bound a full run.
 * The server keeps appending query waves until the lead limit or the supply
 * runs out, so the client budget has to comfortably cover the whole run —
 * 48 passes × ~4 min ≈ 3 hours of continuous generation.
 */
const MAX_AUTO_RESUMES = 48;
const MAX_AUTO_MS = 180 * 60_000;

function sameFilters(a: LeadFilters, b: LeadFilters): boolean {
  return (
    a.keyword === b.keyword &&
    a.maxRating === b.maxRating &&
    a.maxInstalls === b.maxInstalls &&
    a.limit === b.limit &&
    a.country === b.country
  );
}

export function Dashboard() {
  const [values, setValues] = useState<SearchValues>({
    keyword: "",
    // 4 / 5 M is the pair that keeps a head keyword productive: popular
    // keyword apps cluster at 4.0–4.4, and the outreach point is small
    // publishers — at 3 / 100 K the pool for a head keyword was nearly empty
    // (production measured: 1 lead after minutes of crawl), while the 500 K
    // cap still starved mid-size catalogs that carry exactly the keywords
    // being searched.
    maxRating: "4",
    maxInstalls: "5000000",
    country: "BD",
    limit: "1000",
  });
  const [errors, setErrors] = useState<Partial<Record<keyof SearchValues, string>>>({});
  const [running, setRunning] = useState(false);
  const [leads, setLeads] = useState<Lead[]>([]);
  const [stats, setStats] = useState<GenerationStats | null>(null);
  const [message, setMessage] = useState("");
  const [warnings, setWarnings] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ reason: DoneReason; message: string } | null>(null);

  const cursorRef = useRef<SessionCursor | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const runningRef = useRef(false);
  /** Filters the leads currently on screen were qualified with. */
  const filtersRef = useRef<LeadFilters | null>(null);

  function validate(): LeadFilters | null {
    const keyword = validateKeyword(values.keyword);
    const maxRating = validateMaxRating(values.maxRating);
    const maxInstalls = parseInstallInput(values.maxInstalls);
    const country = validateCountry(values.country);
    const limit = validateLimit(values.limit);

    if (!keyword.ok || !maxRating.ok || !maxInstalls.ok || !country.ok || !limit.ok) {
      const next: Partial<Record<keyof SearchValues, string>> = {};
      if (!keyword.ok) next.keyword = keyword.error;
      if (!maxRating.ok) next.maxRating = maxRating.error;
      if (!maxInstalls.ok) next.maxInstalls = maxInstalls.error;
      if (!country.ok) next.country = country.error;
      if (!limit.ok) next.limit = limit.error;
      setErrors(next);
      return null;
    }

    setErrors({});
    return {
      keyword: keyword.value,
      maxRating: maxRating.value,
      maxInstalls: maxInstalls.value,
      country: country.value,
      limit: limit.value,
    };
  }

  function handleEvent(event: GenerationEvent): void {
    const active = filtersRef.current;

    switch (event.type) {
      case "progress":
        setStats(event.stats);
        setMessage(event.message);
        break;
      case "lead":
        // Last line of defence: a row only ever reaches the table (and the CSV)
        // if it satisfies the filters the run was started with.
        if (active && !leadPassesFilters(event.lead, active)) break;
        setLeads((previous) =>
          previous.some((lead) => lead.packageName === event.lead.packageName)
            ? previous
            : [...previous, event.lead],
        );
        break;
      case "lead-update":
        setLeads((previous) =>
          previous.flatMap((lead) => {
            if (lead.packageName !== event.app.packageName) return [lead];
            const merged = mergeLead(lead, event.app);
            return active && !leadPassesFilters(merged, active) ? [] : [merged];
          }),
        );
        break;
      case "lead-remove":
        setLeads((previous) =>
          previous.filter((lead) => lead.packageName !== event.packageName),
        );
        break;
      case "warning":
        setWarnings((previous) => [...previous, event.message]);
        break;
      case "done":
        setStats(event.stats);
        setMessage(event.message);
        setDone({ reason: event.reason, message: event.message });
        cursorRef.current = event.cursor;
        break;
      case "error":
        setError(event.message);
        setMessage(event.message);
        break;
    }
  }

  async function execute(resume: boolean): Promise<void> {
    const filters = validate();
    if (!filters || runningRef.current) return;

    // The leads on screen were qualified with the previous settings. If those
    // settings changed, restart instead of resuming: a resume would keep rows
    // that no longer match and would skip packages the old rules already saw.
    if (resume && filtersRef.current && !sameFilters(filters, filtersRef.current)) {
      resume = false;
    }
    filtersRef.current = filters;

    runningRef.current = true;
    setRunning(true);
    setError(null);
    setDone(null);
    if (!resume) {
      setLeads([]);
      setStats(null);
      setWarnings([]);
      cursorRef.current = null;
      setMessage(`Searching Play Store for “${filters.keyword}”…`);
    }

    const controller = new AbortController();
    abortRef.current = controller;
    let activeCursor = resume ? cursorRef.current : null;
    let autoResumes = 0;
    let droppedWithoutDone = 0;
    const startedAt = Date.now();

    try {
      for (;;) {
        const terminal = await runGeneration({
          request: {
            ...filters,
            cursor: activeCursor ?? undefined,
          },
          onEvent: handleEvent,
          signal: controller.signal,
        });

        if (controller.signal.aborted) break;

        if (terminal && terminal.type === "error") break;

        if (terminal && terminal.type === "done") {
          droppedWithoutDone = 0;
          activeCursor = terminal.cursor;
          const withinTime = Date.now() - startedAt < MAX_AUTO_MS;
          const canContinue =
            terminal.reason === "budget-exhausted" &&
            terminal.cursor !== null &&
            autoResumes < MAX_AUTO_RESUMES &&
            withinTime;

          if (!canContinue) break;

          autoResumes += 1;
          setDone(null);
          setMessage(`Continuing automatically (pass ${autoResumes + 1})…`);
          continue;
        }

        // The stream closed without a terminal event: a network drop or a
        // platform timeout. One retry keeps a long run alive without risking
        // an endless loop of steps that never make progress.
        droppedWithoutDone += 1;
        const nextCursor = cursorRef.current ?? activeCursor;
        const withinTime = Date.now() - startedAt < MAX_AUTO_MS;
        if (
          nextCursor &&
          droppedWithoutDone < 2 &&
          autoResumes < MAX_AUTO_RESUMES &&
          withinTime
        ) {
          autoResumes += 1;
          activeCursor = nextCursor;
          setDone(null);
          setMessage(`Connection dropped — resuming (pass ${autoResumes + 1})…`);
          continue;
        }

        const text = nextCursor
          ? "The connection dropped before the step finished. Resume to pick up from the last checkpoint."
          : "The connection dropped before the search finished. Please try again.";
        setError(text);
        setMessage(text);
        break;
      }
    } catch (caught) {
      const text = caught instanceof Error ? caught.message : "Unexpected client error.";
      setError(text);
      setMessage(text);
    } finally {
      runningRef.current = false;
      setRunning(false);
      abortRef.current = null;
    }
  }

  function stop(): void {
    abortRef.current?.abort();
  }

  function reset(): void {
    if (runningRef.current) stop();
    setLeads([]);
    setStats(null);
    setWarnings([]);
    setError(null);
    setDone(null);
    setMessage("");
    cursorRef.current = null;
    setErrors({});
    filtersRef.current = null;
  }

  function exportCsv(): void {
    if (leads.length === 0) return;
    const blob = new Blob(["\uFEFF" + leadsToCsv(leads)], {
      type: "text/csv;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = csvFilename(values.keyword || "leads");
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }

  const canResume = !running && cursorRef.current !== null;

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-8 sm:px-6 lg:py-12">
      <header className="flex flex-col gap-3">
        <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-[0.2em] text-emerald-400">
          <span className="h-px w-6 bg-emerald-500/60" />
          Play Store lead generator
        </div>
        <h1 className="text-3xl font-semibold tracking-tight text-zinc-50 sm:text-4xl">
          Find low-rated, low-install apps worth building for
        </h1>
        <p className="max-w-2xl text-sm leading-relaxed text-zinc-400">
          The server searches the Google Play Store in real time, keeps every app that matches your
          keyword, rating ceiling and install ceiling, and streams them here as it works. No
          database, no third-party APIs — just server-side Play Store scraping.
        </p>
      </header>

      <SearchForm
        values={values}
        errors={errors}
        running={running}
        canResume={canResume}
        onChange={setValues}
        onSubmit={() => void execute(false)}
        onStop={stop}
        onResume={() => void execute(true)}
        onReset={reset}
      />

      <ProgressPanel
        running={running}
        stats={stats}
        message={message}
        warnings={warnings}
        error={error}
        done={done}
      />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-zinc-400">
          <span className="font-medium text-zinc-200">{leads.length}</span> lead
          {leads.length === 1 ? "" : "s"} collected
          {values.keyword.trim() && (
            <>
              {" "}
              for <span className="text-zinc-200">“{values.keyword.trim()}”</span>
            </>
          )}
        </p>
        <button
          type="button"
          onClick={exportCsv}
          disabled={leads.length === 0}
          className="rounded-lg border border-zinc-700 px-4 py-2 text-sm font-medium text-zinc-200 transition hover:border-emerald-500 hover:text-emerald-400 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Export CSV
        </button>
      </div>

      <LeadTable leads={leads} />

      <footer className="border-t border-zinc-800 pt-6 text-xs leading-relaxed text-zinc-500">
        Results come from publicly available Google Play Store pages. Play ranks very few apps below
        ~2.5 stars for popular searches, so demanding a rating ceiling of 2.0 will usually return
        little or nothing — the run reports that honestly instead of inventing rows. Install figures
        are store buckets (for example “10,000+”), treated as a lower bound.
      </footer>
    </div>
  );
}
