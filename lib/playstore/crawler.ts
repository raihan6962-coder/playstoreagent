import { detailAppQualifies, evaluateApp } from "@/lib/filters/leadFilter";
import { roundRating } from "@/lib/parser/rating";
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
  PlayHttpError,
  PlayParseError,
  PlayRateLimitError,
} from "./client";
import { fetchAppDetail } from "./detail";
import {
  buildPlanQueries,
  entryAt,
  keepsKeyword,
  MAX_SUGGESTION_QUERIES,
  MAX_WAVES,
  planSize,
  suggestPrefixes,
} from "./queryPlan";
import { searchApps } from "./search";
import { fetchSearchSuggestions } from "./suggest";

/** Requests issued in parallel inside one batch (search, expand or enrich). */
export const SEARCH_CONCURRENCY = 24;
/**
 * Minimum spacing between request starts. Throughput is bounded by the gate
 * (1 / intervalMs) and by latency inside a window, so both ends move together:
 * production measured 8.0–8.2 req/s at 16 × 120 ms (cap 8.3) and then
 * 9.5 req/s at 24 × 100 ms (cap 10) across full E2E runs — consistently
 * gate-bound, so the spacing drops to 80 ms (cap 12.5) with the same 24
 * slots. Any Play pushback still goes through RateGate.penalize, which
 * doubles the spacing up to 4 s and creeps back after successful requests.
 */
export const CLIENT_INTERVAL_MS = 80;
/** Suggest lookups issued in parallel inside one step. */
export const SUGGEST_CONCURRENCY = 24;
/** Detail pages fetched per step to backfill lead metadata. */
export const ENRICH_CONCURRENCY = 24;
/** Suggest prefixes processed per step (the rest resume later). */
const SUGGESTS_PER_PREFIX = 10;
/**
 * Detail pages per step spent walking "similar apps". Measured in
 * research3.test.ts: that walk yields ~6x the qualified leads per request of a
 * fresh search, so expansion gets the larger half of each window (see
 * EXPAND_SLOTS_*) and this cap is sized to keep it fed for a whole step.
 */
const MAX_EXPAND_REQUESTS = 1_500;
/** Stop queueing expansion seeds beyond this size. */
const MAX_SIMILAR_QUEUE = 2_000;
/**
 * Leads waiting for their canonical detail page. Every emitted lead is queued;
 * the search window pulls these first (see `pullSearchTask`) so the rating the
 * table shows is refreshed from the run's own country within seconds instead
 * of waiting for a phase that may never run within the time budget.
 */
const MAX_ENRICH_QUEUE = 1_000;
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
 * Detail pages and searches share every window: walking "similar apps"
 * measured ~6x the qualified leads per request of a fresh search (see
 * research3.test.ts), so a healthy seed queue gets the larger half of the
 * window — eight of 24 slots — and a sparse queue still gets a quarter.
 */
const EXPAND_SLOTS_FULL = 10;
const EXPAND_SLOTS_SPARSE = 3;
/** Seed queue size considered "healthy" for the full expansion slot share. */
const EXPAND_QUEUE_HEALTHY = 8;

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
    rateLimitHits: 0,
    lowestRatingSeen: null,
  };
}

/**
 * Runs tasks through a sliding window instead of a fixed batch.
 *
 * A batch barrier idles every slot that finished early while it waits for the
 * slowest page of that batch (production measured ~2.7 s per 16-wide batch at
 * 5.9 req/s, i.e. 16 slots held open for the tail alone). A window refills a
 * slot the moment its task settles, so one slow detail page can no longer
 * throttle the other 15.
 *
 * `pullTask` supplies the next task, or null when this window's queues are
 * exhausted; `shouldContinue` gates new starts (time budget, target, failure
 * limits). Target and rate-limit outcomes close the window so in-flight work
 * drains without pulling anything new.
 */
async function runWindow(
  concurrency: number,
  pullTask: () => Promise<TaskOutcome> | null,
  shouldContinue: () => boolean,
): Promise<TaskOutcome[]> {
  const outcomes: TaskOutcome[] = [];
  const running = new Set<Promise<void>>();
  let open = true;
  let crash: unknown = null;
  let crashed = false;

  const fill = (): void => {
    while (open && running.size < concurrency && shouldContinue()) {
      let task: Promise<TaskOutcome> | null;
      try {
        task = pullTask();
      } catch (error) {
        crash = error;
        crashed = true;
        open = false;
        break;
      }
      if (!task) {
        open = false;
        break;
      }
      const settled = task.then((outcome) => {
        outcomes.push(outcome);
        if (outcome === "target" || outcome === "rate-limited") open = false;
      });
      running.add(settled);
      void settled.then(
        () => {
          running.delete(settled);
          fill();
        },
        () => {
          running.delete(settled);
        },
      );
    }
  };

  fill();
  while (running.size > 0) {
    await Promise.all(Array.from(running));
  }
  if (crashed) throw crash;
  return outcomes;
}

export function createInitialCursor(keyword: string): SessionCursor {
  return {
    keyword,
    suggestions: [],
    suggestIndex: 0,
    planIndex: 0,
    wave: 0,
    waveDiscovered: 0,
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
    wave: cursor.wave,
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
    new PlayClient({ concurrency: SEARCH_CONCURRENCY, intervalMs: CLIENT_INTERVAL_MS });
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
  let suggestFailed = false;
  let currentQuery: string | null = null;

  // `let` because the search loop appends a new query wave when the plan runs
  // out before the lead limit is reached (see below).
  let queries = buildPlanQueries(cursor.keyword, suggestions, cursor.wave);
  let totalPlan = planSize(queries);

  const stats = () =>
    buildStats(cursor, filters, startedAt, currentQuery, totalPlan);
  const hasTimeForRequest = (headroom = REQUEST_HEADROOM_MS) =>
    options.aborted?.() !== true && Date.now() + headroom < deadline;

  const finish = (reason: DoneReason, message: string, attachCursor: boolean): StepResult => {
    cursor.seen = Array.from(seen).slice(-MAX_SEEN_PACKAGES);
    cursor.emitted = Array.from(emitted);
    cursor.suggestions = suggestions.slice(0, MAX_SUGGESTION_QUERIES);
    cursor.counters.requests += client.requests;
    cursor.counters.rateLimitHits += client.rateLimitHits;
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

  /**
   * Removes a lead the store can no longer back: a detail page that stopped
   * qualifying (ceiling breach, or no rating from this run's country) or an
   * app whose page now 404s. Carries the counters with it so the reported
   * total always matches what the table and the CSV show.
   */
  function dropLead(pkg: string): boolean {
    if (!emitted.has(pkg)) return false;
    emitted.delete(pkg);
    if (queuedEnrich.delete(pkg)) {
      cursor.enrichQueue = cursor.enrichQueue.filter((item) => item !== pkg);
    }
    if (cursor.counters.matched > 0) cursor.counters.matched -= 1;
    emit({ type: "lead-remove", packageName: pkg });
    return true;
  }

  /**
   * Applies an authoritative detail page to a lead the user may already be
   * looking at.
   *
   * The detail page reports the precise rating behind the rounded search-card
   * value (3.54 behind a printed "3.5"), so a merge can push a lead over the
   * rating ceiling the user set. When the detail data no longer qualifies the
   * lead — or cannot confirm a rating from this run's country at all — it is
   * removed again.
   */
  function applyDetail(pkg: string, app: StoreApp | null): void {
    if (!app || app.packageName !== pkg) {
      dropLead(pkg);
      return;
    }

    const qualifies = detailAppQualifies(app, filters);
    if (qualifies) {
      // The store prints one decimal; hand the client the same number Play
      // shows so the table and the CSV never differ from the store listing.
      if (emitted.has(pkg)) emit({ type: "lead-update", app: { ...app, rating: roundRating(app.rating) } });
      return;
    }

    dropLead(pkg);
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
      const detail = await fetchAppDetail(client, seed.p, "en", filters.country);
      cursor.counters.pagesFetched += 1;
      parseFailures = 0;
      transportFailures = 0;

      if (cursor.enrichQueue.includes(seed.p)) {
        cursor.enrichQueue = cursor.enrichQueue.filter((pkg) => pkg !== seed.p);
        queuedEnrich.delete(seed.p);
      }
      applyDetail(seed.p, detail.app);

      if (ingest(detail.similarApps)) return "target";
      return "ok";
    } catch (error) {
      if (error instanceof PlayRateLimitError) return "rate-limited";
      if (error instanceof PlayParseError) {
        parseFailures += 1;
        return "parse-failure";
      }
      // Definitive answer, not a transport failure: the app is gone. Drop the
      // row instead of keeping a lead whose link no longer opens.
      if (error instanceof PlayHttpError && error.status === 404) {
        if (dropLead(seed.p)) {
          emit({
            type: "warning",
            message: `Play Store no longer lists “${seed.p}” — removed it from the leads.`,
          });
        }
        return "ok";
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
      const detail = await fetchAppDetail(client, pkg, "en", filters.country);
      cursor.counters.pagesFetched += 1;
      enrichRequests += 1;
      parseFailures = 0;
      transportFailures = 0;

      applyDetail(pkg, detail.app);
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
      if (error instanceof PlayHttpError && error.status === 404) {
        if (dropLead(pkg)) {
          emit({
            type: "warning",
            message: `Play Store no longer lists “${pkg}” — removed it from the leads.`,
          });
        }
        return "ok";
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
        } catch (error) {
          if (!suggestFailed) {
            suggestFailed = true;
            emit({
              type: "warning",
              message:
                `Play's suggest endpoint is unavailable (${error instanceof Error ? error.message : "unknown error"}). ` +
                "Continuing with the built-in query plan.",
            });
          }
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

    let expandCredit = 0;
    const enrichFlight = new Set<string>();
    const pullSearchTask = (): Promise<TaskOutcome> | null => {
      // Canonical detail pages for leads already on screen come first: the
      // table must show this run's country rating, and the search phase is the
      // only phase guaranteed to execute before the step's budget runs out.
      if (enrichRequests + enrichFlight.size < MAX_ENRICH_PER_STEP) {
        for (const pkg of cursor.enrichQueue) {
          if (enrichFlight.has(pkg)) continue;
          enrichFlight.add(pkg);
          return runEnrichTask(pkg).then((outcome) => {
            enrichFlight.delete(pkg);
            return outcome;
          });
        }
      }

      const seedsAvailable =
        cursor.similarQueue.length > 0 && expandRequests < MAX_EXPAND_REQUESTS;
      if (seedsAvailable) {
        expandCredit +=
          (cursor.similarQueue.length >= EXPAND_QUEUE_HEALTHY
            ? EXPAND_SLOTS_FULL
            : EXPAND_SLOTS_SPARSE) / SEARCH_CONCURRENCY;
      }
      if (expandCredit >= 1) {
        const [seed] = takeSeeds(1);
        if (seed) {
          expandCredit = Math.min(expandCredit - 1, 1);
          return runExpandTask(seed);
        }
        expandCredit = 0;
      }

      const entry = entryAt(queries, cursor.planIndex);
      if (!entry) {
        if (!seedsAvailable) return null;
        const [seed] = takeSeeds(1);
        if (!seed) return null;
        return runExpandTask(seed);
      }
      cursor.planIndex += 1;
      currentQuery = entry.query;
      emit({
        type: "progress",
        stats: stats(),
        message: `Searching Play Store for “${entry.query}” (${entry.gl})…`,
      });
      return runSearchTask(entry);
    };

    const outcomes = await runWindow(SEARCH_CONCURRENCY, pullSearchTask, () =>
      cursor.counters.matched < filters.limit &&
      hasTimeForRequest(BATCH_HEADROOM_MS) &&
      parseFailures < MAX_PARSE_FAILURES &&
      transportFailures < MAX_TRANSPORT_FAILURES,
    );

    const failure = batchFailure(outcomes);
    if (failure) return failure;
    if (outcomes.includes("target")) {
      cursor.phase = "enrich";
      break;
    }
    if (cursor.planIndex >= totalPlan || entryAt(queries, cursor.planIndex) === null) {
      // The plan ran out before the lead limit: keep generating. Each wave
      // appends a fresh deterministic batch of long-tail queries (appended
      // only, so `planIndex` stays valid). A wave that finds no new app means
      // the reachable supply under these ceilings is genuinely exhausted —
      // then (and only then) the search phase ends honestly.
      if (cursor.wave < MAX_WAVES && cursor.counters.discovered > cursor.waveDiscovered) {
        cursor.wave += 1;
        cursor.waveDiscovered = cursor.counters.discovered;
        queries = buildPlanQueries(cursor.keyword, suggestions, cursor.wave);
        totalPlan = planSize(queries);
        emit({
          type: "progress",
          stats: stats(),
          message: `Lead limit not reached yet — extending the query plan (wave ${cursor.wave} of ${MAX_WAVES}).`,
        });
        continue;
      }
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

    const outcomes = await runWindow(
      SEARCH_CONCURRENCY,
      () => {
        const [seed] = takeSeeds(1);
        return seed ? runExpandTask(seed) : null;
      },
      () =>
        cursor.counters.matched < filters.limit &&
        expandRequests < MAX_EXPAND_REQUESTS &&
        hasTimeForRequest(BATCH_HEADROOM_MS) &&
        parseFailures < MAX_PARSE_FAILURES &&
        transportFailures < MAX_TRANSPORT_FAILURES,
    );

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

    const inFlight = new Set<string>();
    const outcomes = await runWindow(
      ENRICH_CONCURRENCY,
      () => {
        if (enrichRequests + inFlight.size >= MAX_ENRICH_PER_STEP) return null;
        for (const pkg of cursor.enrichQueue) {
          if (inFlight.has(pkg)) continue;
          inFlight.add(pkg);
          return runEnrichTask(pkg).then((outcome) => {
            inFlight.delete(pkg);
            return outcome;
          });
        }
        return null;
      },
      () =>
        hasTimeForRequest(BATCH_HEADROOM_MS) &&
        parseFailures < MAX_PARSE_FAILURES &&
        transportFailures < MAX_TRANSPORT_FAILURES,
    );

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
    `Only ${cursor.counters.matched} matching app${cursor.counters.matched === 1 ? " was" : "s were"} found before the available results were exhausted.` +
      (cursor.wave > 0
        ? ` Searched through ${cursor.wave + 1} query waves — no further apps under the given rating/install limits exist in the reachable results.`
        : ""),
    false,
  );
}
