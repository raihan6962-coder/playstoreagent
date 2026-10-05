"use client";

import { useEffect, useRef, useState } from "react";
import {
  clearAttachedRun,
  createRun,
  fetchSnapshot,
  loadAttachedRun,
  runAction,
  RunRequestError,
  type AttachedRun,
} from "@/lib/client/runs";
import { csvFilename, leadsToCsv } from "@/lib/csv/export";
import {
  parseInstallInput,
  validateKeyword,
  validateLimit,
  validateMaxRating,
} from "@/lib/validation/input";
import type { DoneReason, GenerationStats, Lead } from "@/types/lead";
import type { LogEntry, SnapshotStatus } from "@/types/run";
import { LeadTable } from "./lead-table";
import { LogPanel } from "./log-panel";
import { ProgressPanel } from "./progress-panel";
import { SearchForm, type SearchValues } from "./search-form";

/** Active run: keep the dashboard live. Finished/stalled: poll cheaply. */
const POLL_ACTIVE_MS = 3_000;
const POLL_IDLE_MS = 15_000;
/** Client-side cap; the server log already caps at 300 curated entries. */
const LOG_CLIENT_MAX = 500;
/** Throttle for the automatic Resume of a stalled run (browser open case). */
const AUTO_RESUME_MS = 45_000;
/** Rate-limited runs retry much less often — the window only moves hourly. */
const RATE_LIMITED_RESUME_MS = 10 * 60_000;

const STALLED_TEXT = "The runner stalled — resuming it automatically…";

interface Versions {
  state: number;
  leads: number;
  logLastId: number;
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
    limit: "1000",
  });
  const [errors, setErrors] = useState<Partial<Record<keyof SearchValues, string>>>({});
  const [attached, setAttached] = useState<AttachedRun | null>(null);
  const [status, setStatus] = useState<SnapshotStatus | null>(null);
  const [creating, setCreating] = useState(false);
  const [leads, setLeads] = useState<Lead[]>([]);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [stats, setStats] = useState<GenerationStats | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ reason: DoneReason; message: string } | null>(null);

  const versionsRef = useRef<Versions>({ state: 0, leads: 0, logLastId: 0 });
  const statusRef = useRef<SnapshotStatus | null>(null);

  const applyStatus = (next: SnapshotStatus | null): void => {
    statusRef.current = next;
    setStatus(next);
  };

  /**
   * Reattach after a reload: the run kept collecting with the tab closed,
   * and the first snapshot replaces the optimistic state below. Deferred a
   * tick so the effect body itself stays free of synchronous setState.
   */
  useEffect(() => {
    const run = loadAttachedRun();
    if (!run) return;
    const timer = window.setTimeout(() => {
      setAttached(run);
      applyStatus("running");
      setMessage("Reattached to your previous run — it kept working while you were away.");
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  /**
   * The polling loop — the only thing driving the dashboard now. Adaptive
   * cadence: 3s while the server reports progress, 15s when it is idle or
   * done. Log/leads ship only when their versions moved, so a quiet poll is
   * a few hundred bytes.
   */
  useEffect(() => {
    if (!attached) return;
    const run = attached;
    versionsRef.current = { state: 0, leads: 0, logLastId: 0 };

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let inFlight = false;
    let failures = 0;
    let lastAutoResume = 0;

    /**
     * "Keep going until the target" while the tab is open: a stalled chain
     * or a run that ended on a rate limit resumes itself (throttled). The
     * external sweep covers the tab-closed case; the Resume button stays as
     * the manual fallback for both.
     */
    const maybeAutoResume = (snapshot: Awaited<ReturnType<typeof fetchSnapshot>>): void => {
      const stalled = snapshot.status === "stalled";
      const rateLimited = snapshot.status === "done" && snapshot.reason === "rate-limited";
      if (!stalled && !rateLimited) return;
      const wait = stalled ? AUTO_RESUME_MS : RATE_LIMITED_RESUME_MS;
      const now = Date.now();
      if (now - lastAutoResume < wait) return;
      lastAutoResume = now;
      void runAction(run, "resume")
        .then((result) => {
          if (cancelled || result.status !== "running") return;
          setError(null);
          setMessage(
            stalled
              ? "The runner stalled — resuming it automatically…"
              : "The rate limit cleared — resuming automatically…",
          );
        })
        .catch(() => {
          // Keep the notice up; the next poll (or the external sweep) retries.
        });
    };

    const applySnapshot = (snapshot: Awaited<ReturnType<typeof fetchSnapshot>>): void => {
      setStats(snapshot.stats);
      applyStatus(snapshot.status);
      setDone(
        snapshot.status === "done" && snapshot.reason
          ? { reason: snapshot.reason, message: snapshot.message ?? "Run finished." }
          : null,
      );

      if (snapshot.status === "stalled") {
        setError(STALLED_TEXT);
      } else if (failures >= 2) {
        // Only poll failures clear here — errors set elsewhere (e.g. a failed
        // create) must not be wiped by a healthy poll.
        setError(null);
      }
      if (snapshot.status === "done" || snapshot.status === "stopped") {
        if (snapshot.message) setMessage(snapshot.message);
      }

      if (snapshot.log) {
        setLog((previous) => {
          const lastId = previous[previous.length - 1]?.id ?? 0;
          const fresh = snapshot.log!.filter((entry) => entry.id > lastId);
          if (fresh.length === 0) return previous;
          const latest = fresh[fresh.length - 1];
          if (
            snapshot.status !== "done" &&
            snapshot.status !== "stopped" &&
            snapshot.status !== "stalled"
          ) {
            setMessage(latest.message);
          }
          return [...previous, ...fresh].slice(-LOG_CLIENT_MAX);
        });
      }

      if (snapshot.leads) setLeads(snapshot.leads);
      versionsRef.current = {
        state: snapshot.versions.state,
        leads: snapshot.versions.leads,
        logLastId: snapshot.versions.logLastId,
      };
    };

    const poll = async (): Promise<void> => {
      if (cancelled) return;
      const active =
        statusRef.current === "running" || statusRef.current === "stop-requested";
      if (!inFlight) {
        inFlight = true;
        try {
          const snapshot = await fetchSnapshot(run, {
            logSince: versionsRef.current.logLastId,
            leadsSince: versionsRef.current.leads,
          });
          if (!cancelled) {
            applySnapshot(snapshot);
            maybeAutoResume(snapshot);
            failures = 0;
          }
        } catch (caught) {
          if (!cancelled) {
            failures += 1;
            if (caught instanceof RunRequestError && (caught.code === 401 || caught.code === 404)) {
              clearAttachedRun();
              setAttached(null);
              applyStatus(null);
              setMessage("This run is no longer available.");
              setError(null);
              return;
            }
            if (failures >= 2) {
              setError(
                caught instanceof RunRequestError
                  ? caught.message
                  : "Connection issue — retrying…",
              );
            }
          }
        } finally {
          inFlight = false;
        }
      }
      if (!cancelled) timer = setTimeout(() => void poll(), active ? POLL_ACTIVE_MS : POLL_IDLE_MS);
    };

    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attached?.runId, attached?.token]);

  function validate(): { keyword: string; maxRating: number; maxInstalls: number; limit: number } | null {
    const keyword = validateKeyword(values.keyword);
    const maxRating = validateMaxRating(values.maxRating);
    const maxInstalls = parseInstallInput(values.maxInstalls);
    const limit = validateLimit(values.limit);

    if (!keyword.ok || !maxRating.ok || !maxInstalls.ok || !limit.ok) {
      const next: Partial<Record<keyof SearchValues, string>> = {};
      if (!keyword.ok) next.keyword = keyword.error;
      if (!maxRating.ok) next.maxRating = maxRating.error;
      if (!maxInstalls.ok) next.maxInstalls = maxInstalls.error;
      if (!limit.ok) next.limit = limit.error;
      setErrors(next);
      return null;
    }

    setErrors({});
    return {
      keyword: keyword.value,
      maxRating: maxRating.value,
      maxInstalls: maxInstalls.value,
      limit: limit.value,
    };
  }

  async function start(): Promise<void> {
    const parsed = validate();
    if (!parsed || creating) return;

    setCreating(true);
    setError(null);
    setDone(null);

    // Starting a new search detaches the old run: ask it to stop (fire and
    // forget — its step observes the flag at the next checkpoint), then reset
    // the screen. The new run replaces the localStorage attachment.
    if (attached) {
      void runAction(attached, "stop").catch(() => undefined);
    }
    clearAttachedRun();
    setAttached(null);
    applyStatus(null);
    setLeads([]);
    setLog([]);
    setStats(null);
    setMessage("");

    try {
      const run = await createRun({
        keyword: parsed.keyword,
        maxRating: parsed.maxRating,
        maxInstalls: parsed.maxInstalls,
        limit: parsed.limit,
      });
      setAttached(run);
      applyStatus("running");
      setMessage(`Run created for “${parsed.keyword}” — the server takes it from here.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not start the run.");
    } finally {
      setCreating(false);
    }
  }

  async function requestStop(): Promise<void> {
    if (!attached) return;
    try {
      const result = await runAction(attached, "stop");
      applyStatus(result.status);
      if (result.status === "stopped") {
        setDone(null);
        setMessage("Stopped.");
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not stop the run.");
    }
  }

  async function requestResume(): Promise<void> {
    if (!attached) return;
    try {
      const result = await runAction(attached, "resume");
      applyStatus(result.status);
      setDone(null);
      setError(null);
      setMessage("Resumed — the runner picks up from its last checkpoint.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not resume the run.");
    }
  }

  function reset(): void {
    if (attached) void runAction(attached, "stop").catch(() => undefined);
    clearAttachedRun();
    setAttached(null);
    applyStatus(null);
    setLeads([]);
    setLog([]);
    setStats(null);
    setMessage("");
    setError(null);
    setDone(null);
    setErrors({});
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

  const resumable =
    !creating &&
    attached !== null &&
    (status === "stopped" ||
      status === "stalled" ||
      (status === "done" && (done?.reason === "rate-limited" || done?.reason === "failed")));

  // While the server is mid-query this shows the live request instead of the
  // curated log's last line, which intentionally skips per-query spam.
  const headline =
    status === "running" && stats?.currentQuery
      ? `Searching Play Store for “${stats.currentQuery}”…`
      : message;

  const warnings = log.filter((entry) => entry.kind === "warn").map((entry) => entry.message);

  const statusChip = creating
    ? "Starting…"
    : status === "running"
      ? "Running"
      : status === "stop-requested"
        ? "Stopping…"
        : status === "stalled"
          ? "Stalled"
          : status === "stopped"
            ? "Stopped"
            : status === "done"
              ? "Finished"
              : null;

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
          The server searches the Google Play Store, keeps every app that matches your keyword,
          rating ceiling and install ceiling, and keeps collecting — even after you close this tab.
          No database, no third-party APIs — just server-side Play Store scraping.
        </p>
      </header>

      <SearchForm
        values={values}
        errors={errors}
        running={creating || status === "running" || status === "stop-requested"}
        canResume={resumable}
        onChange={setValues}
        onSubmit={() => void start()}
        onStop={() => void requestStop()}
        onResume={() => void requestResume()}
        onReset={reset}
      />

      <ProgressPanel
        running={status === "running" || status === "stop-requested"}
        stats={stats}
        message={headline}
        warnings={warnings}
        error={error}
        done={done}
      />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="flex items-center gap-3 text-sm text-zinc-400">
          <span>
            <span className="font-medium text-zinc-200">{leads.length}</span> lead
            {leads.length === 1 ? "" : "s"} collected
            {values.keyword.trim() && (
              <>
                {" "}
                for <span className="text-zinc-200">“{values.keyword.trim()}”</span>
              </>
            )}
          </span>
          {statusChip && (
            <span className="rounded-full border border-zinc-700 px-2.5 py-0.5 text-xs text-zinc-400">
              {statusChip}
            </span>
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

      <LogPanel entries={log} />

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
