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
import {
  buildPlanQueries,
  entryAt,
  keepsKeyword,
  MAX_SUGGESTION_QUERIES,
  planSize,
  suggestPrefixes,
} from "./queryPlan";
import { searchApps } from "./search";
import { fetchSearchSuggestions } from "./suggest";

/** Requests issued in parallel inside one batch (search, expand or enrich). */
const SEARCH_CONCURRENCY = 6;
/** Suggest lookups issued in parallel inside one step. */
const SUGGEST_CONCURRENCY = 6;
/** Detail pages fetched per step to backfill lead metadata. */
const ENRICH_CONCURRENCY = 6;
/** Suggest prefixes processed per step (the rest resume later). */
const SUGGESTS_PER_PREFIX = 10;
/** How many "similar apps" detail pages one step may fetch. */
const MAX_EXPAND_REQUESTS = 300;
/** Stop queueing expansion seeds beyond this size. */
const MAX_SIMILAR_QUEUE = 2_000;
const MAX_ENRICH_QUEUE = 200;
/** Enriched detail pages per step before the step reports back to the caller. */
const MAX_ENRICH_PER_STEP = 200;
/**
 * Package names kept for dedupe. Past this point repeats may be re-evaluated;
 * `emitted` still guarantees a lead is only counted once. The cap also keeps
 * the resume cursor small enough to round trip through the browser.
 */
const MAX_SEEN_PACKAGES = 10_000;
/** Consecutive malformed pages before we assume Play changed its markup. */
const MAX_PARSE_FAILURES = 6;
/** Consecutive transport failures before we give up. */
const MAX_TRANSPORT_FAILURES = 8;
/** Remaining time (ms) below which we no longer start a new request. */
const REQUEST_HEADROOM_MS = 1_500;
/** A parallel batch needs more slack than a single request. */
const BATCH_HEADROOM_MS = 5_000;
/**
 * Detail pages and searches share every batch: walking "similar apps" measured
 * ~6x the qualified leads per request of a fresh search (see research3.test.ts),
 * so a healthy seed queue keeps half of the batch busy with expansion.
 */
const EXPAND_SLOTS_FULL = 3;
const EXPAND_SLOTS_SPARSE = 1;
/** Seed queue size considered "healthy" for a full expansion slot share. */
const EXPAND_QUEUE_HEALTHY = 12;

type TaskOutcome = "ok" | "target" | "rate-limited" | "parse-failure" | "transport-failure";

const RATE_LIMITED_MESSAGE =
  "Play Store temporarily rejected requests. Please try again in a few minutes.";
const STRUCTURE_MESSAGE =
  "Play Store changed its page structure and results could no longer be read.";
const NETWORK_MESSAGE =
  "Could not reach the Play Store after several attempts. Please try again later.";

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
    suggestions: [],
    suggestIndex: 0,
    planIndex: 0,
    phase: "suggest",
    seen: [],
    emitted: [],
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
  queriesTotal: number,
): GenerationStats {
  return {
    ...cursor.counters,
    keyword: filters.keyword,
    target: filters.limit,
    queriesTotal,
    currentQuery,
    phase: cursor.phase,
    elapsedMs: Date.now() - startedAt,
  };
}

/**
 * Runs one bounded slice of the lead-generation session.
 *
 * The session is fully resumable: the cursor carries the storefront sweep
 * position, the suggestion list and the dedupe set, so a serverless invocation
 * can stop on its time budget and the next invocation continues exactly where
 * it left off.
 */
export async function runGenerationStep(options: StepOptions): Promise<StepResult> {
  const { filters, budgetMs, emit } = options;
  const cursor = options.cursor;
  const client =
    options.client ??
    new PlayClient({ concurrency: SEARCH_CONCURRENCY, intervalMs: 180 });
  const startedAt = Date.now();
  const deadline = startedAt + budgetMs;

  const seen = new Set(cursor.seen);
  const emitted = new Set(cursor.emitted);
  const expanded = new Set(cursor.expanded);
  const queuedSeeds = new Set(cursor.similarQueue.map((seed) => seed.p));
  const queuedEnrich = new Set(cursor.enrichQueue);
  const suggestions = [...cursor.suggestions];
  let expandRequests = 0;
  let enrichRequests = 0;
  let parseFailures = 0;
  let transportFailures = 0;
  let currentQuery: string | null = null;

  const queries = buildPlanQueries(cursor.keyword, suggestions);
  const totalPlan = planSize(queries);

  const stats = () =>
    buildStats(cursor, filters, startedAt, currentQuery, totalPlan);
  const hasTimeForRequest = (headroom = REQUEST_HEADROOM_MS) =>
    options.aborted?.() !== true && Date.now() + headroom < deadline;

  const finish = (reason: DoneReason, message: string, attachCursor: boolean): StepResult => {
    cursor.seen = Array.from(seen).slice(-MAX_SEEN_PACKAGES);
    cursor.emitted = Array.from(emitted);
    cursor.suggestions = suggestions.slice(0, MAX_SUGGESTION_QUERIES);
    cursor.counters.requests += client.requests;
    if (reason !== "budget-exhausted" && reason !== "rate-limited") {
      cursor.phase = "done";
    }
    const finalStats = buildStats(cursor, filters, startedAt, currentQuery, totalPlan);
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

      if (seen.size < MAX_SEEN_PACKAGES) seen.add(app.packageName);
      cursor.counters.discovered += 1;
      cursor.counters.evaluated += 1;

      if (app.rating !== null) {
        const lowest = cursor.counters.lowestRatingSeen;
        cursor.counters.lowestRatingSeen =
          lowest === null || app.rating < lowest ? app.rating : lowest;
      }

      if (evaluation.status === "match" && evaluation.lead) {
        const lead = evaluation.lead;
        if (emitted.has(lead.packageName)) continue;
        if (cursor.counters.matched >= filters.limit) return true;

        emitted.add(lead.packageName);
        cursor.counters.matched += 1;
        if (
          lead.ratingsCount === null &&
          !queuedEnrich.has(lead.packageName) &&
          cursor.enrichQueue.length < MAX_ENRICH_QUEUE
        ) {
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

  /** Pulls the cheapest expansion seeds off the queue, skipping repeats. */
  function takeSeeds(count: number): SimilarSeed[] {
    const picked: SimilarSeed[] = [];
    cursor.similarQueue.sort(
      (a, b) => (a.i ?? Number.MAX_SAFE_INTEGER) - (b.i ?? Number.MAX_SAFE_INTEGER),
    );
    while (
      picked.length < count &&
      cursor.similarQueue.length > 0 &&
      expandRequests + picked.length < MAX_EXPAND_REQUESTS
    ) {
      const seed = cursor.similarQueue.shift();
      if (!seed) break;
      queuedSeeds.delete(seed.p);
      if (expanded.has(seed.p)) continue;
      picked.push(seed);
    }
    return picked;
  }

  /** Turns a batch of task outcomes into a terminal decision for the step. */
  function batchFailure(outcomes: TaskOutcome[]): StepResult | null {
    if (outcomes.includes("rate-limited")) {
      return finish("rate-limited", RATE_LIMITED_MESSAGE, true);
    }
    if (parseFailures >= MAX_PARSE_FAILURES) {
      return finish("failed", STRUCTURE_MESSAGE, false);
    }
    if (transportFailures >= MAX_TRANSPORT_FAILURES) {
      return finish("failed", NETWORK_MESSAGE, false);
    }
    return null;
  }

  async function runSearchTask(entry: QueryPlanEntry): Promise<TaskOutcome> {
    if (options.aborted?.()) return "ok";
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
      currentQuery = entry.query;

      if (ingest(result.apps)) return "target";
      return "ok";
    } catch (error) {
      if (error instanceof PlayRateLimitError) return "rate-limited";

      if (error instanceof PlayParseError) {
        parseFailures += 1;
        emit({ type: "warning", message: "Play Store returned an unexpected page layout." });
        return "parse-failure";
      }

      transportFailures += 1;
      emit({
        type: "warning",
        message: `A Play Store request failed (${error instanceof Error ? error.message : "unknown error"}). Moving on to the next query.`,
      });
      return "transport-failure";
    }
  }

  async function runExpandTask(seed: SimilarSeed): Promise<TaskOutcome> {
    if (options.aborted?.()) return "ok";
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

      if (ingest(detail.similarApps)) return "target";
      return "ok";
    } catch (error) {
      if (error instanceof PlayRateLimitError) return "rate-limited";
      if (error instanceof PlayParseError) {
        parseFailures += 1;
        return "parse-failure";
      }
      transportFailures += 1;
      emit({
        type: "warning",
        message: `Could not explore apps related to “${seed.p}”.`,
      });
      return "transport-failure";
    }
  }

  async function runEnrichTask(pkg: string): Promise<TaskOutcome> {
    if (options.aborted?.()) return "ok";
    currentQuery = pkg;
    emit({
      type: "progress",
      stats: stats(),
      message: `Fetching details for ${pkg}…`,
    });

    try {
      const detail = await fetchAppDetail(client, pkg);
      cursor.counters.pagesFetched += 1;
      enrichRequests += 1;
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
      return "ok";
    } catch (error) {
      cursor.enrichQueue = cursor.enrichQueue.filter((item) => item !== pkg);
      queuedEnrich.delete(pkg);

      if (error instanceof PlayRateLimitError) return "rate-limited";
      if (error instanceof PlayParseError) {
        parseFailures += 1;
        return "parse-failure";
      }

      transportFailures += 1;
      emit({
        type: "warning",
        message: `Could not fetch details for ${pkg}.`,
      });
      return "transport-failure";
    }
  }

  // --------------------------------------------------------------- suggest --
  while (cursor.phase === "suggest") {
    const prefixes = suggestPrefixes(cursor.keyword);
    if (cursor.suggestIndex >= prefixes.length) {
      cursor.phase = "search";
      break;
    }
    if (suggestions.length >= MAX_SUGGESTION_QUERIES) {
      cursor.phase = "search";
      break;
    }
    if (!hasTimeForRequest()) {
      return finish(
        "budget-exhausted",
        "Time budget reached for this step — resume to continue.",
        true,
      );
    }

    const batch: string[] = [];
    for (let offset = 0; offset < SUGGEST_CONCURRENCY; offset += 1) {
      const prefix = prefixes[cursor.suggestIndex + offset];
      if (prefix === undefined) break;
      batch.push(prefix);
    }
    cursor.suggestIndex += batch.length;
    currentQuery = batch[0] ?? null;

    emit({
      type: "progress",
      stats: stats(),
      message: `Expanding “${cursor.keyword}” with Play suggestions…`,
    });

    const collected: string[] = [];
    await Promise.all(
      batch.map(async (prefix) => {
        try {
          const found = await fetchSearchSuggestions(
            client,
            prefix,
            "en",
            "US",
            undefined,
            SUGGESTS_PER_PREFIX,
          );
          for (const label of found) {
            if (keepsKeyword(cursor.keyword, label)) collected.push(label);
          }
        } catch {
          // Suggestions are optional; the deterministic plan still runs.
        }
      }),
    );

    for (const label of collected) {
      if (suggestions.length >= MAX_SUGGESTION_QUERIES) break;
      if (!suggestions.some((item) => item.toLowerCase() === label.toLowerCase())) {
        suggestions.push(label);
      }
    }
  }

  // ---------------------------------------------------------------- search --
  while (cursor.phase === "search") {
    if (cursor.counters.matched >= filters.limit) {
      cursor.phase = "enrich";
      break;
    }
    if (!hasTimeForRequest(BATCH_HEADROOM_MS)) {
      return finish(
        "budget-exhausted",
        "Time budget reached for this step — resume to continue.",
        true,
      );
    }

    const seeds =
      cursor.similarQueue.length > 0 && expandRequests < MAX_EXPAND_REQUESTS
        ? takeSeeds(
            cursor.similarQueue.length >= EXPAND_QUEUE_HEALTHY
              ? EXPAND_SLOTS_FULL
              : EXPAND_SLOTS_SPARSE,
          )
        : [];

    const searchSlots = SEARCH_CONCURRENCY - seeds.length;
    const batch: QueryPlanEntry[] = [];
    for (let offset = 0; offset < searchSlots; offset += 1) {
      const entry = entryAt(queries, cursor.planIndex + offset);
      if (!entry) break;
      batch.push(entry);
    }
    cursor.planIndex += batch.length;

    if (batch.length === 0 && seeds.length === 0) {
      cursor.phase = "expand";
      break;
    }
    currentQuery = batch[0]?.query ?? seeds[0]?.p ?? null;

    emit({
      type: "progress",
      stats: stats(),
      message:
        batch.length > 0
          ? `Searching Play Store for “${batch[0].query}” (${batch[0].gl})…`
          : `Exploring apps related to “${seeds[0].p}”…`,
    });

    const outcomes = await Promise.all([
      ...seeds.map((seed) => runExpandTask(seed)),
      ...batch.map((entry) => runSearchTask(entry)),
    ]);

    const failure = batchFailure(outcomes);
    if (failure) return failure;
    if (outcomes.includes("target")) {
      cursor.phase = "enrich";
      break;
    }
    if (cursor.planIndex >= totalPlan) {
      cursor.phase = "expand";
      break;
    }
  }

  // ---------------------------------------------------------------- expand --
  while (cursor.phase === "expand") {
    if (cursor.counters.matched >= filters.limit) {
      cursor.phase = "enrich";
      break;
    }
    if (cursor.similarQueue.length === 0) {
      cursor.phase = "enrich";
      break;
    }
    if (expandRequests >= MAX_EXPAND_REQUESTS) {
      return finish(
        "budget-exhausted",
        "Exploring related apps — resume to continue.",
        true,
      );
    }
    if (!hasTimeForRequest(BATCH_HEADROOM_MS)) {
      return finish(
        "budget-exhausted",
        "Time budget reached for this step — resume to continue.",
        true,
      );
    }

    const seeds = takeSeeds(SEARCH_CONCURRENCY);
    if (seeds.length === 0) {
      cursor.phase = "enrich";
      break;
    }
    currentQuery = seeds[0].p;

    emit({
      type: "progress",
      stats: stats(),
      message: `Exploring apps related to “${seeds[0].p}”…`,
    });

    const outcomes = await Promise.all(seeds.map((seed) => runExpandTask(seed)));

    const failure = batchFailure(outcomes);
    if (failure) return failure;
    if (outcomes.includes("target")) {
      cursor.phase = "enrich";
      break;
    }
  }

  // ---------------------------------------------------------------- enrich --
  while (cursor.phase === "enrich") {
    if (cursor.enrichQueue.length === 0 || enrichRequests >= MAX_ENRICH_PER_STEP) break;
    if (!hasTimeForRequest(BATCH_HEADROOM_MS)) {
      return finish(
        "budget-exhausted",
        "Time budget reached for this step — resume to continue.",
        true,
      );
    }

    const batch = cursor.enrichQueue.slice(0, ENRICH_CONCURRENCY);
    if (batch.length === 0) break;

    const outcomes = await Promise.all(batch.map((pkg) => runEnrichTask(pkg)));

    const failure = batchFailure(outcomes);
    if (failure) return failure;
  }

  // ------------------------------------------------------------------ done --
  if (cursor.enrichQueue.length > 0 && enrichRequests >= MAX_ENRICH_PER_STEP) {
    return finish(
      "budget-exhausted",
      "Backfilling details for the collected leads — resume to continue.",
      true,
    );
  }

  if (cursor.similarQueue.length > 0 && expandRequests >= MAX_EXPAND_REQUESTS) {
    return finish(
      "budget-exhausted",
      "Exploring related apps — resume to continue.",
      true,
    );
  }

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
