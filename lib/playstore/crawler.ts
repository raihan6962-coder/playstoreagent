import { evaluateApp } from "@/lib/filters/leadFilter";
import type {
  DoneReason,
  GenerationEvent,
  GenerationStats,
  LeadFilters,
  QueryPlanEntry,
  SessionCounters,
  SessionCursor,
  SimilarSeed,
  StoreApp,
} from "@/types/lead";
import {
  PlayClient,
  PlayParseError,
  PlayRateLimitError,
} from "./client";
import { fetchAppDetail } from "./detail";
import { buildPlan, MAX_PLAN_SIZE } from "./queryPlan";
import { searchApps } from "./search";
import { fetchSearchSuggestions } from "./suggest";

/** How many "similar apps" detail pages one session may fetch. */
const MAX_EXPAND_REQUESTS = 12;
/** Stop queueing expansion seeds beyond this size. */
const MAX_SIMILAR_QUEUE = 300;
/** Consecutive malformed pages before we assume Play changed its markup. */
const MAX_PARSE_FAILURES = 3;
/** Consecutive transport failures before we give up. */
const MAX_TRANSPORT_FAILURES = 4;
/** Remaining time (ms) below which we no longer start a new request. */
const REQUEST_HEADROOM_MS = 1_500;
const MAX_SUGGESTIONS = 12;

function emptyCounters(): SessionCounters {
  return {
    discovered: 0,
    evaluated: 0,
    matched: 0,
    duplicates: 0,
    queriesRun: 0,
    pagesFetched: 0,
    requests: 0,
    lowestRatingSeen: null,
  };
}

export function createInitialCursor(keyword: string): SessionCursor {
  return {
    keyword,
    plan: buildPlan(keyword),
    planIndex: 0,
    phase: "search",
    seen: [],
    similarQueue: [],
    expanded: [],
    enrichQueue: [],
    counters: emptyCounters(),
  };
}

export interface StepOptions {
  filters: LeadFilters;
  cursor: SessionCursor;
  budgetMs: number;
  emit: (event: GenerationEvent) => void;
  client?: PlayClient;
  /** Return true when the caller went away; the step then wraps up early. */
  aborted?: () => boolean;
}

export interface StepResult {
  reason: DoneReason;
  message: string;
  cursor: SessionCursor | null;
  stats: GenerationStats;
}

function buildStats(
  cursor: SessionCursor,
  filters: LeadFilters,
  startedAt: number,
  currentQuery: string | null,
): GenerationStats {
  return {
    ...cursor.counters,
    keyword: filters.keyword,
    target: filters.limit,
    queriesTotal: cursor.plan.length,
    currentQuery,
    phase: cursor.phase,
    elapsedMs: Date.now() - startedAt,
  };
}

/**
 * Runs one bounded slice of the lead-generation session.
 *
 * The session is fully resumable: the cursor carries the query plan position,
 * the dedupe set and the counters, so a serverless invocation can stop on its
 * time budget and the next invocation continues exactly where it left off.
 */
export async function runGenerationStep(options: StepOptions): Promise<StepResult> {
  const { filters, budgetMs, emit } = options;
  const cursor = options.cursor;
  const client = options.client ?? new PlayClient();
  const startedAt = Date.now();
  const deadline = startedAt + budgetMs;

  const seen = new Set(cursor.seen);
  const expanded = new Set(cursor.expanded);
  const queuedSeeds = new Set(cursor.similarQueue.map((seed) => seed.p));
  const queuedEnrich = new Set(cursor.enrichQueue);
  let expandRequests = 0;
  let parseFailures = 0;
  let transportFailures = 0;
  let currentQuery: string | null = null;
  let suggestionsAdded = cursor.plan.some((item) => item.kind === "suggestion");

  const stats = () => buildStats(cursor, filters, startedAt, currentQuery);
  const hasTimeForRequest = () =>
    options.aborted?.() !== true && Date.now() + REQUEST_HEADROOM_MS < deadline;

  const finish = (reason: DoneReason, message: string, attachCursor: boolean): StepResult => {
    cursor.seen = Array.from(seen);
    cursor.counters.requests += client.requests;
    if (reason !== "budget-exhausted" && reason !== "rate-limited") {
      cursor.phase = "done";
    }
    const finalStats = buildStats(cursor, filters, startedAt, currentQuery);
    const result = attachCursor ? cursor : null;
    emit({ type: "done", reason, message, stats: finalStats, cursor: result });
    return { reason, message, cursor: result, stats: finalStats };
  };

  /** Returns true when the lead target has been reached. */
  const ingest = (apps: StoreApp[]): boolean => {
    for (const app of apps) {
      const evaluation = evaluateApp(app, filters, seen);

      if (evaluation.reasons.includes("duplicate")) {
        cursor.counters.duplicates += 1;
        continue;
      }

      seen.add(app.packageName);
      cursor.counters.discovered += 1;
      cursor.counters.evaluated += 1;

      if (app.rating !== null) {
        const lowest = cursor.counters.lowestRatingSeen;
        cursor.counters.lowestRatingSeen =
          lowest === null || app.rating < lowest ? app.rating : lowest;
      }

      if (evaluation.status === "match" && evaluation.lead) {
        if (cursor.counters.matched >= filters.limit) return true;
        const lead = evaluation.lead;
        cursor.counters.matched += 1;
        if (lead.ratingsCount === null && !queuedEnrich.has(lead.packageName)) {
          queuedEnrich.add(lead.packageName);
          cursor.enrichQueue.push(lead.packageName);
        }
        pushSeed({ p: lead.packageName, i: lead.installs }, queuedSeeds);
        emit({ type: "lead", lead, stats: stats() });
        if (cursor.counters.matched >= filters.limit) return true;
        continue;
      }

      const relevant = !evaluation.reasons.includes("not-relevant");
      if (relevant) {
        pushSeed({ p: app.packageName, i: app.installs }, queuedSeeds);
      }
    }
    return false;
  };

  function pushSeed(seed: SimilarSeed, queued: Set<string>): void {
    if (queued.has(seed.p) || cursor.similarQueue.length >= MAX_SIMILAR_QUEUE) return;
    queued.add(seed.p);
    cursor.similarQueue.push(seed);
  }

  const addSuggestions = (queries: string[], hl: string, gl: string): void => {
    const existing = new Set(
      cursor.plan.map((item) => `${item.query.toLowerCase()}|${item.hl}|${item.gl}`),
    );
    const extra: QueryPlanEntry[] = [];
    for (const query of queries) {
      const key = `${query.toLowerCase()}|${hl}|${gl}`;
      if (existing.has(key)) continue;
      existing.add(key);
      extra.push({ query, hl, gl, kind: "suggestion" });
    }
    if (extra.length === 0) return;
    const room = MAX_PLAN_SIZE - cursor.plan.length;
    if (room <= 0) return;
    cursor.plan = [
      ...cursor.plan.slice(0, cursor.planIndex + 1),
      ...extra.slice(0, room),
      ...cursor.plan.slice(cursor.planIndex + 1),
    ].slice(0, MAX_PLAN_SIZE);
  };

  // ---------------------------------------------------------------- search --
  while (cursor.phase === "search") {
    if (cursor.counters.matched >= filters.limit) {
      cursor.phase = "enrich";
      break;
    }
    if (cursor.planIndex >= cursor.plan.length) {
      cursor.phase = "expand";
      break;
    }
    if (!hasTimeForRequest()) {
      return finish("budget-exhausted", "Time budget reached for this step — resume to continue.", true);
    }

    const entry: QueryPlanEntry = cursor.plan[cursor.planIndex];
    currentQuery = entry.query;
    emit({
      type: "progress",
      stats: stats(),
      message: `Searching Play Store for “${entry.query}”…`,
    });

    try {
      const result = await searchApps(client, {
        query: entry.query,
        hl: entry.hl,
        gl: entry.gl,
        price: entry.price,
      });

      cursor.counters.queriesRun += 1;
      cursor.counters.pagesFetched += 1;
      parseFailures = 0;
      transportFailures = 0;

      if (!suggestionsAdded) {
        suggestionsAdded = true;
        try {
          const suggestions = await fetchSearchSuggestions(
            client,
            filters.keyword,
            entry.hl,
            entry.gl,
            result.buildLabel,
            MAX_SUGGESTIONS,
          );
          addSuggestions(suggestions, entry.hl, entry.gl);
        } catch {
          // Suggestions are optional; the deterministic plan still runs.
        }
      }

      const targetReached = ingest(result.apps);
      cursor.planIndex += 1;

      if (targetReached) {
        cursor.phase = "enrich";
        break;
      }
    } catch (error) {
      cursor.planIndex += 1;

      if (error instanceof PlayRateLimitError) {
        return finish(
          "rate-limited",
          "Play Store temporarily rejected requests. Please try again in a few minutes.",
          true,
        );
      }

      if (error instanceof PlayParseError) {
        parseFailures += 1;
        emit({ type: "warning", message: "Play Store returned an unexpected page layout." });
        if (parseFailures >= MAX_PARSE_FAILURES) {
          return finish(
            "failed",
            "Play Store changed its page structure and results could no longer be read.",
            false,
          );
        }
        continue;
      }

      transportFailures += 1;
      emit({
        type: "warning",
        message: `A Play Store request failed (${error instanceof Error ? error.message : "unknown error"}). Moving on to the next query.`,
      });
      if (transportFailures >= MAX_TRANSPORT_FAILURES) {
        return finish(
          "failed",
          "Could not reach the Play Store after several attempts. Please try again later.",
          false,
        );
      }
    }
  }

  // ---------------------------------------------------------------- expand --
  while (cursor.phase === "expand") {
    if (cursor.counters.matched >= filters.limit) {
      cursor.phase = "enrich";
      break;
    }
    if (cursor.similarQueue.length === 0 || expandRequests >= MAX_EXPAND_REQUESTS) {
      cursor.phase = "enrich";
      break;
    }
    if (!hasTimeForRequest()) {
      return finish("budget-exhausted", "Time budget reached for this step — resume to continue.", true);
    }

    // Smallest apps first: they lead to the same low-install neighbourhood.
    cursor.similarQueue.sort(
      (a, b) => (a.i ?? Number.MAX_SAFE_INTEGER) - (b.i ?? Number.MAX_SAFE_INTEGER),
    );
    const seed = cursor.similarQueue.shift();
    if (!seed) {
      cursor.phase = "enrich";
      break;
    }
    queuedSeeds.delete(seed.p);
    if (expanded.has(seed.p)) continue;
    expanded.add(seed.p);
    cursor.expanded.push(seed.p);
    expandRequests += 1;
    currentQuery = seed.p;

    emit({
      type: "progress",
      stats: stats(),
      message: `Exploring apps related to “${seed.p}”…`,
    });

    try {
      const detail = await fetchAppDetail(client, seed.p);
      cursor.counters.pagesFetched += 1;
      parseFailures = 0;
      transportFailures = 0;

      if (cursor.enrichQueue.includes(seed.p)) {
        cursor.enrichQueue = cursor.enrichQueue.filter((pkg) => pkg !== seed.p);
        queuedEnrich.delete(seed.p);
        if (detail.app) emit({ type: "lead-update", app: detail.app });
      }

      if (ingest(detail.similarApps)) {
        cursor.phase = "enrich";
        break;
      }
    } catch (error) {
      if (error instanceof PlayRateLimitError) {
        return finish(
          "rate-limited",
          "Play Store temporarily rejected requests. Please try again in a few minutes.",
          true,
        );
      }
      if (error instanceof PlayParseError) {
        parseFailures += 1;
        if (parseFailures >= MAX_PARSE_FAILURES) {
          return finish(
            "failed",
            "Play Store changed its page structure and results could no longer be read.",
            false,
          );
        }
      } else {
        transportFailures += 1;
        if (transportFailures >= MAX_TRANSPORT_FAILURES) {
          return finish(
            "failed",
            "Could not reach the Play Store after several attempts. Please try again later.",
            false,
          );
        }
      }
    }
  }

  // ---------------------------------------------------------------- enrich --
  while (cursor.phase === "enrich") {
    if (cursor.enrichQueue.length === 0) break;
    if (!hasTimeForRequest()) {
      return finish("budget-exhausted", "Time budget reached for this step — resume to continue.", true);
    }

    const pkg = cursor.enrichQueue[0];
    currentQuery = pkg;
    emit({
      type: "progress",
      stats: stats(),
      message: `Fetching details for ${pkg}…`,
    });

    try {
      const detail = await fetchAppDetail(client, pkg);
      cursor.counters.pagesFetched += 1;
      parseFailures = 0;
      transportFailures = 0;

      if (detail.app) emit({ type: "lead-update", app: detail.app });
      if (!expanded.has(pkg)) {
        expanded.add(pkg);
        cursor.expanded.push(pkg);
        ingest(detail.similarApps);
      }

      cursor.enrichQueue = cursor.enrichQueue.filter((item) => item !== pkg);
      queuedEnrich.delete(pkg);
    } catch (error) {
      cursor.enrichQueue = cursor.enrichQueue.filter((item) => item !== pkg);
      queuedEnrich.delete(pkg);

      if (error instanceof PlayRateLimitError) {
        return finish(
          "rate-limited",
          "Leads are ready, but Play Store rejected further detail requests. Resume later to finish enriching them.",
          true,
        );
      }

      if (error instanceof PlayParseError) {
        parseFailures += 1;
        if (parseFailures >= MAX_PARSE_FAILURES) {
          return finish(
            "failed",
            "Play Store changed its page structure and results could no longer be read.",
            false,
          );
        }
      } else {
        transportFailures += 1;
        emit({
          type: "warning",
          message: `Could not fetch details for ${pkg}.`,
        });
        if (transportFailures >= MAX_TRANSPORT_FAILURES) {
          return finish(
            "budget-exhausted",
            "Leads are ready; some detail pages could not be fetched. Resume to finish them.",
            true,
          );
        }
      }
    }
  }

  // ------------------------------------------------------------------ done --
  if (cursor.counters.matched >= filters.limit) {
    return finish(
      "target-reached",
      `Found ${cursor.counters.matched} matching leads for “${filters.keyword}”.`,
      false,
    );
  }

  if (cursor.counters.discovered === 0) {
    return finish(
      "no-results",
      `No apps were found for “${filters.keyword}”. Try a broader keyword.`,
      false,
    );
  }

  return finish(
    "plan-exhausted",
    `Only ${cursor.counters.matched} matching app${cursor.counters.matched === 1 ? " was" : "s were"} found before the available results were exhausted.`,
    false,
  );
}
