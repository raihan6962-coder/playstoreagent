import { cardCanStillQualify, detailAppQualifies, evaluateApp } from "@/lib/filters/leadFilter";
import type { Evaluation } from "@/lib/filters/leadFilter";
import { MAX_CONSECUTIVE_DRY_ROUNDS, MAX_SECONDARY_ROUNDS } from "@/lib/keywords/secondary";
import { MAX_DESCRIPTION_LENGTH } from "@/lib/parser/appEntries";
import { roundRating } from "@/lib/parser/rating";
import type {
  DoneReason,
  GenerationEvent,
  GenerationStats,
  Lead,
  LeadFilters,
  PendingVerify,
  PlanQuery,
  QueryPlanEntry,
  SessionCounters,
  SessionCursor,
  SimilarSeed,
  StoreApp,
  TempCandidate,
} from "@/types/lead";
import {
  PlayClient,
  PlayHttpError,
  PlayParseError,
  PlayRateLimitError,
} from "./client";
import { fetchAppDetail } from "./detail";
import { keywordVariants } from "./keywords";
import { type KnownApps } from "./known";
import {
  buildCycleQueries,
  entryAt,
  HARVEST_TARGET,
  keepsKeyword,
  MAX_CYCLE_QUERIES,
  MAX_KEYWORDS,
  MAX_LEAD_DROUGHT_QUERIES,
  MAX_STAGNANT_QUERIES,
  MAX_SUGGESTION_QUERIES,
  MAX_TEMP_CANDIDATES,
  MAX_VARIANT_BACKSTOP,
  planSize,
  SOLO_HARVEST_TARGET,
  SOLO_MAX_CYCLE_QUERIES,
  suggestPrefixes,
} from "./queryPlan";
import { emptyPool, type HarvestPool, toPoolCard } from "./harvest";
import { searchApps } from "./search";
import { fetchSearchSuggestions } from "./suggest";

/** Requests issued in parallel inside one batch (search, expand or enrich). */
export const SEARCH_CONCURRENCY = 32;
/**
 * Minimum spacing between request starts. Throughput is bounded by the gate
 * (1 / intervalMs) and by latency inside a window, so both ends move together:
 * production measured 8.0–8.2 req/s at 16 × 120 ms (cap 8.3) and then
 * 9.5 req/s at 24 × 100 ms (cap 10) across full E2E runs — consistently
 * gate-bound, so the spacing drops to 80 ms (cap 12.5) with the same 24
 * slots. Any Play pushback still goes through RateGate.penalize, which
 * doubles the spacing up to 4 s and creeps back after successful requests.
 */
export const CLIENT_INTERVAL_MS = 60;
/** Suggest lookups issued in parallel inside one step. */
export const SUGGEST_CONCURRENCY = 32;
/** Detail pages fetched per step to backfill lead metadata. */
export const ENRICH_CONCURRENCY = 32;
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
 * Queued summaries are only a fallback for detail pages that arrive without
 * text, but some search cards embed multi-kilobyte snippets — clipped here so
 * a long snippet can never push the resume cursor past the validator's cap
 * (which would make every step restart from scratch instead of resuming).
 */
const QUEUE_SUMMARY_CAP = 1_000;

function clipSummary(summary: string | null): string | null {
  if (summary === null) return null;
  return summary.length > QUEUE_SUMMARY_CAP ? summary.slice(0, QUEUE_SUMMARY_CAP) : summary;
}
/**
 * Leads waiting for their canonical detail page. Every emitted lead is queued;
 * the filter stage pulls these first so the rating the table shows is
 * refreshed from the run's own country within seconds instead of waiting for
 * the terminal enrich phase.
 */
const MAX_ENRICH_QUEUE = 1_000;
/** Enriched detail pages per step before the step reports back to the caller. */
const MAX_ENRICH_PER_STEP = 300;
/**
 * Search-card matches waiting for their country's canonical detail page.
 * Verified candidates are streamed to the table only after that page confirms
 * both ceilings, so the queue holds everything the run has found but not yet
 * been allowed to show. The cap only matters under pathological supply (hundreds
 * of matches inside a single window); overflow falls back to showing the
 * card-verified lead rather than silently discarding a passing candidate.
 */
const MAX_PENDING_QUEUE = 1_000;
/** Detail verifications per step before the step reports back to the caller. */
const MAX_PENDING_PER_STEP = 900;
/**
 * Undecided cards waiting for their detail page: partial keyword hits (the
 * card's text proves some but not all significant terms) and cards missing
 * the rating or install number. Search cards are thin — for a multi-term
 * keyword like "crypto wallet" the card usually carries one term while the
 * listing's description carries the other, and some cards print no rating at
 * all. Fetching the detail page settles both with full text plus this run's
 * country numbers, so these are queued instead of dropped. Capped because
 * every entry costs a request; overflow simply leaves the app at its card
 * verdict.
 */
const MAX_CANDIDATE_QUEUE = 2500;
/** Detail fetches per step spent on undecided cards. */
const MAX_CANDIDATE_PER_STEP = 1500;
/**
 * A card summary shorter than this is treated as possibly incomplete (a stub
 * or layout clip) rather than the listing's full text. Measured live: 169 of
 * 170 BD search cards carried ≥300 chars — the description itself — so under
 * 300 the detail page may still hold wording the card never showed.
 */
const CARD_TEXT_STUB_LENGTH = 300;
/**
 * Package names kept for dedupe. Past this point repeats may be re-evaluated;
 * `emitted` still guarantees a lead is only counted once. The cap also keeps
 * the resume cursor small enough to round trip through the browser.
 */
const MAX_SEEN_PACKAGES = 10_000;
/**
 * Consecutive malformed pages before we assume Play changed its markup. High
 * on purpose: a throttled session serves bot-wall pages that parse as
 * garbage, and over a 25k-query run a cluster of half a dozen transient bad
 * pages is routine — killing the run there once ended an 8-lead run that had
 * barely started its second cycle. A real redesign still trips this within a
 * window or two (every search fails), while transient clusters ride through
 * on the successes that reset the count.
 */
const MAX_PARSE_FAILURES = 30;
/**
 * Consecutive transport failures before we give up. Same reasoning as the
 * parse threshold: flaky stretches cluster, and only a persistently dead
 * route should end the run.
 */
const MAX_TRANSPORT_FAILURES = 24;
/** Remaining time (ms) below which we no longer start a new request. */
const REQUEST_HEADROOM_MS = 1_500;
/** A parallel batch needs more slack than a single request. */
const BATCH_HEADROOM_MS = 5_000;
/**
 * An AI keyword round is one Groq call (10s timeout). We only start a round
 * when a whole round still fits inside the step budget, so generation can
 * never be the thing that blows past `maxDuration`.
 */
const ROUND_HEADROOM_MS = 15_000;

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
    knownSkipped: 0,
    queriesRun: 0,
    pagesFetched: 0,
    requests: 0,
    rateLimitHits: 0,
    candidates: 0,
    verifyRejected: 0,
    verifyTextRejected: 0,
    verifyCeilingRejected: 0,
    homeDiscovered: 0,
    homeQueued: 0,
    homePending: 0,
    verifyCeilingRating: 0,
    verifyCeilingInstalls: 0,
    verifyCeilingMissing: 0,
    lowestRatingSeen: null,
    verifyFromPending: 0,
    verifyFromCandidate: 0,
    leadFromPending: 0,
    leadFromCandidate: 0,
    leadHomeUnrated: 0,
    leadHomeOther: 0,
    leadForeign: 0,
    rejectHomeUnrated: 0,
    rejectHomeOther: 0,
    rejectForeign: 0,
    rejectTextCardBad: 0,
    rejectTextCardGood: 0,
    cycles: 0,
    collected: 0,
    filtered: 0,
    cardDropRating: 0,
    cardDropInstalls: 0,
    cardDropIrrelevant: 0,
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
    keywords: [keyword],
    keywordIndex: 0,
    tempCandidates: [],
    cycleSeen: [],
    cycleQueries: 0,
    stagnantQueries: 0,
    leadDrought: 0,
    wave: 0,
    waveDiscovered: 0,
    phase: "suggest",
    seen: [],
    emitted: [],
    similarQueue: [],
    expanded: [],
    enrichQueue: [],
    pendingQueue: [],
    candidateQueue: [],
    secondary: [],
    secondaryTried: false,
    extraTail: [],
    secondaryRounds: 0,
    dryRounds: 0,
    counters: emptyCounters(),
  };
}

export interface StepOptions {
  filters: LeadFilters;
  cursor: SessionCursor;
  budgetMs: number;
  emit: (event: GenerationEvent) => void;
  client?: PlayClient;
  /**
   * Patient client for detail pages (verify/enrich/expand). A slow detail
   * fetch gates a lead, while a slow search only costs one query among
   * thousands — so searches fail fast (a tarpitted connection must never
   * hold all 32 slots for half a minute) and details get their retries.
   * Defaults to `client` when the caller supplies one (tests), else a
   * patient default.
   */
  detailClient?: PlayClient;
  /** Return true when the caller went away; the step then wraps up early. */
  aborted?: () => boolean;
  /**
   * Keyword-generation round supplier (Groq). Fired once per cycle miss:
   * when a keyword's collect → filter cycle ends below target and no queued
   * keyword remains, the supplier is asked for fresh phrases related to the
   * MAIN keyword, and each phrase joins the keyword queue as its own future
   * cycle. `tried` carries the phrases already queued or searched so the
   * model opens fresh neighbourhoods instead of reshuffling the same head
   * terms (which just re-returns the same apps). When absent (unit tests, no
   * API key) the run falls back to the deterministic alternates and then
   * stops honestly.
   */
  generateSecondary?: (keyword: string, tried: string[]) => Promise<string[]>;
  /**
   * The active keyword cycle's harvest pool: the collected-but-unfiltered
   * apps. Supplied by the caller (runs.ts loads/saves it from its own store
   * file) so a step can hand the pool back at its end and a resumed step picks
   * up the same inbox. Defaults to an in-memory pool for unit tests.
   *
   * The pool is deliberately NOT part of the cursor any more: at a 1000-card
   * harvest floor it is hundreds of KB, far past what a per-checkpoint cursor
   * write can carry. See harvest.ts.
   */
  pool?: HarvestPool;
  /**
   * Override the per-keyword harvest floor (defaults to
   * {@link HARVEST_TARGET}). Tests use a small value to exercise the
   * collect-then-filter shape without fabricating a thousand cards; production
   * always uses the default.
   */
  harvestTarget?: number;
  /**
   * The keyword's memory of the apps it already produced, across every
   * earlier run. Supplied by the caller (the server loads and saves it), and
   * only read when the "new apps only" mode is on. Every package the filter
   * judges is written back into it, so the memory grows with the run and
   * survives it.
   */
  known?: KnownApps;
  /**
   * Safety backstop: stop with `query-cap` once `counters.queriesRun`
   * reaches this many queries. Granted per run by the state store and topped
   * up on every Resume, so an unproductive niche can never spin forever
   * while an explicit Resume still extends the search.
   */
  queryBudget?: number;
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
  poolSize = 0,
  harvestTarget = HARVEST_TARGET,
): GenerationStats {
  return {
    ...cursor.counters,
    keyword: filters.keyword,
    target: filters.limit,
    queriesTotal,
    currentQuery,
    phase: cursor.phase,
    wave: cursor.wave,
    poolSize,
    harvestTarget,
    newAppsOnly: filters.newAppsOnly === true,
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
    new PlayClient({
      concurrency: SEARCH_CONCURRENCY,
      intervalMs: CLIENT_INTERVAL_MS,
      timeoutMs: 8_000,
      retries: 1,
    });
  const detailClient =
    options.detailClient ??
    options.client ??
    new PlayClient({ concurrency: SEARCH_CONCURRENCY, intervalMs: CLIENT_INTERVAL_MS });
  const startedAt = Date.now();
  const deadline = startedAt + budgetMs;

  const seen = new Set(cursor.seen);
  const emitted = new Set(cursor.emitted);
  const expanded = new Set(cursor.expanded);
  const queuedSeeds = new Set(cursor.similarQueue.map((seed) => seed.p));
  const queuedEnrich = new Set(cursor.enrichQueue);
  const queuedPending = new Set(cursor.pendingQueue.map((entry) => entry.p));
  const queuedCandidates = new Set(cursor.candidateQueue.map((entry) => entry.p));
  const suggestions = [...cursor.suggestions];
  let expandRequests = 0;
  let enrichRequests = 0;
  let pendingRequests = 0;
  let candidateRequests = 0;
  /** Verification packages that failed this step; retried on the next one instead. */
  const pendingRetried = new Set<string>();
  let parseFailures = 0;
  let transportFailures = 0;
  let suggestFailed = false;
  let currentQuery: string | null = null;
  // The active cycle's harvest pool. Supplied by the caller (own store file,
  // so it survives a rate limit or an instance death mid-harvest); defaults
  // to an in-memory pool for unit tests. `cursor.tempCandidates` is no longer
  // the pool — see harvest.ts.
  const pool: HarvestPool =
    options.pool ?? emptyPool(cursor.keyword, cursor.keywordIndex ?? 0);

  /**
   * "New apps only" mode. The run stays on the one keyword it was given and
   * ignores every package that keyword has already produced, so the pool
   * fills with apps the operator has not seen before. The lead target is
   * ignored as well — the mode's promise is "as many as this keyword can
   * still give", not "stop at N".
   */
  const soloMode = filters.newAppsOnly === true;
  /**
   * The keyword's cross-run memory. Only meaningful in solo mode, but it is
   * written by every run: a keyword's memory must reflect everything it has
   * ever produced, or switching the mode on later would re-offer the apps
   * the earlier runs already judged.
   */
  const known = options.known;
  /**
   * Record a package in the keyword's memory — but only for the keyword that
   * memory belongs to. A run that cycles on to a related keyword must not
   * file that keyword's apps under the main one: the memory answers "has
   * THIS keyword produced this app", and only this keyword's own harvests
   * can answer that.
   */
  const remember = (packageName: string): void => {
    if (known && known.keyword === activeCycleKeyword()) known.add(packageName);
  };
  /** Has this keyword already produced the package? */
  const isKnown = (packageName: string): boolean =>
    known !== undefined &&
    known !== null &&
    known.keyword === activeCycleKeyword() &&
    known.has(packageName);
  /** True once the run has enough leads — never true in solo mode. */
  const targetReached = (): boolean =>
    !soloMode && cursor.counters.matched >= filters.limit;
  /**
   * "3 new leads" in solo mode, "3/100 leads" otherwise — the target is
   * ignored there, so quoting it would be a lie.
   */
  const leadsSoFar = (): string =>
    soloMode
      ? `${cursor.counters.matched} new lead${cursor.counters.matched === 1 ? "" : "s"}`
      : `${cursor.counters.matched}/${filters.limit} leads`;
  /**
   * How many searches one keyword cycle may spend. The "new apps only" mode
   * gets a much larger budget: it has a single keyword, so searching it
   * harder is the only way to keep finding apps it has not produced yet.
   */
  const cycleQueryLimit = (): number =>
    soloMode ? SOLO_MAX_CYCLE_QUERIES : MAX_CYCLE_QUERIES;

  // --- keyword-cycle state (migrates cursors minted before cycles existed) ---
  if (!Array.isArray(cursor.keywords) || cursor.keywords.length === 0) {
    cursor.keywords = [cursor.keyword];
  }
  if (
    typeof cursor.keywordIndex !== "number" ||
    !Number.isInteger(cursor.keywordIndex) ||
    cursor.keywordIndex < 0 ||
    cursor.keywordIndex >= cursor.keywords.length
  ) {
    cursor.keywordIndex = 0;
  }
  if (!Array.isArray(cursor.tempCandidates)) cursor.tempCandidates = [];
  if (!Array.isArray(cursor.cycleSeen)) cursor.cycleSeen = [];
  if (
    typeof cursor.cycleQueries !== "number" ||
    !Number.isFinite(cursor.cycleQueries) ||
    cursor.cycleQueries < 0
  ) {
    cursor.cycleQueries = 0;
  }
  // Counters added after launch: persisted states minted before them carry no
  // such fields — without this the first increment would produce NaN.
  for (
    const key of [
      "cycles",
      "collected",
      "filtered",
      "cardDropRating",
      "cardDropInstalls",
      "cardDropIrrelevant",
    ] as const
  ) {
    const current = cursor.counters[key];
    if (typeof current !== "number" || !Number.isFinite(current) || current < 0) {
      cursor.counters[key] = 0;
    }
  }
  if (
    typeof cursor.stagnantQueries !== "number" ||
    !Number.isFinite(cursor.stagnantQueries) ||
    cursor.stagnantQueries < 0
  ) {
    cursor.stagnantQueries = 0;
  }
  if (
    typeof cursor.leadDrought !== "number" ||
    !Number.isFinite(cursor.leadDrought) ||
    cursor.leadDrought < 0
  ) {
    cursor.leadDrought = 0;
  }
  // Stages renamed since: old "search" cursors resume collecting, old
  // "expand" ones resume filtering. Their saved planIndex is clamped to the
  // current cycle's plan below (the old run-global plan no longer exists —
  // unsearched tail queries are superseded by the new cycles).
  if ((cursor.phase as string) === "search") cursor.phase = "collect";
  else if ((cursor.phase as string) === "expand") cursor.phase = "filter";
  // One-time migration: cursors minted while the pool still lived in the
  // cursor carry their collected cards in `tempCandidates`. Adopt them into
  // the external pool (bound to the active cycle) and clear the field, so a
  // run that was mid-harvest when this shipped does not re-collect from
  // scratch. New cursors never write the field again.
  if (Array.isArray(cursor.tempCandidates) && cursor.tempCandidates.length > 0) {
    if (pool.cards.length === 0) {
      pool.cards = cursor.tempCandidates.slice(0, MAX_TEMP_CANDIDATES).map(toPoolCard);
      pool.collected = Math.max(pool.collected, pool.cards.length);
    }
    cursor.tempCandidates = [];
  }
  const cycleSeenSet = new Set(cursor.cycleSeen);
  // Package → pool index, rebuilt from the persisted pool: a home-storefront
  // card supersedes a foreign one already pooled (see stashTemp).
  const tempIndex = new Map<string, number>();
  pool.cards.forEach((entry, index) => {
    if (!tempIndex.has(entry.p)) tempIndex.set(entry.p, index);
  });

  // Round-one AI phrases (primed by the caller before the first step) join
  // the keyword queue instead of the query plan: every phrase gets its own
  // collect → filter cycle. Idempotent — re-merging an already-queued phrase
  // is a no-op, so repeated steps cannot duplicate the queue.
  //
  // "New apps only" mode skips this: the operator asked for one keyword, and
  // an AI phrase is a different keyword's neighbourhood.
  if (cursor.secondary.length > 0 && !soloMode) {
    const queued = new Set(cursor.keywords.map((entry) => entry.toLowerCase()));
    for (const phrase of cursor.secondary) {
      const trimmed = phrase.trim();
      if (trimmed.length < 2 || queued.has(trimmed.toLowerCase())) continue;
      if (cursor.keywords.length >= MAX_KEYWORDS) break;
      queued.add(trimmed.toLowerCase());
      cursor.keywords.push(trimmed);
    }
  }

  const activeCycleKeyword = (): string =>
    cursor.keywords[Math.min(cursor.keywordIndex, cursor.keywords.length - 1)] ?? cursor.keyword;

  // The keyword every verdict in this step is judged against. Cycle 0 is the
  // main keyword (identical to `filters`); later cycles judge against their
  // own phrase — a secondary harvest is relevant to that phrase, and judging
  // it against the main keyword would reject everything the cycle searched
  // for. Only the keyword differs; ceilings, country and target are shared.
  let activeFilters: LeadFilters = filters;
  let queries: PlanQuery[] = [];
  let totalPlan = 0;
  const rebuildCyclePlan = (): void => {
    activeFilters = { ...filters, keyword: activeCycleKeyword() };
    queries = buildCycleQueries(activeFilters.keyword, suggestions);
    totalPlan = planSize(queries);
    if (cursor.planIndex > totalPlan) cursor.planIndex = totalPlan;
  };
  rebuildCyclePlan();

  /** Opens a keyword cycle: empty pool, plan rewound, filter pending. */
  const startCycle = (index: number): void => {
    cursor.keywordIndex = index;
    cursor.planIndex = 0;
    cursor.cycleQueries = 0;
    cursor.stagnantQueries = 0;
    cursor.leadDrought = 0;
    cursor.cycleSeen = [];
    cycleSeenSet.clear();
    pool.keywordIndex = index;
    pool.keyword = activeCycleKeyword();
    pool.cards = [];
    pool.collected = 0;
    tempIndex.clear();
    cursor.phase = "collect";
    rebuildCyclePlan();
    emit({
      type: "progress",
      stats: stats(),
      message:
        `Collecting apps for “${activeCycleKeyword()}” (cycle ${index + 1}) — ` +
        `harvesting up to ${HARVEST_TARGET} before filtering…`,
    });
  };

  const stats = () =>
    buildStats(
      cursor,
      filters,
      startedAt,
      currentQuery,
      totalPlan,
      pool.cards.length,
      harvestLimit(),
    );
  /**
   * How many cards this cycle must harvest before the filter stage starts.
   * A run may aim lower than {@link HARVEST_TARGET} (tests, and the
   * harvest-size option), never higher.
   *
   * In "new apps only" mode the floor is much lower on purpose: the pool
   * only fills with apps the keyword has never produced, so a thousand is a
   * long time to wait — and there may never be a thousand. A lower floor
   * lets the filter stage open early and the cycle alternate
   * collect → filter → collect, so leads start arriving while the run is
   * still harvesting.
   */
  const harvestLimit = (): number => {
    const requested = options.harvestTarget ?? HARVEST_TARGET;
    const ceiling = soloMode ? SOLO_HARVEST_TARGET : HARVEST_TARGET;
    return Math.max(0, Math.min(ceiling, requested));
  };
  const hasTimeForRequest = (headroom = REQUEST_HEADROOM_MS) =>
    options.aborted?.() !== true && Date.now() + headroom < deadline;

  const finish = (reason: DoneReason, message: string, attachCursor: boolean): StepResult => {
    cursor.seen = Array.from(seen).slice(-MAX_SEEN_PACKAGES);
    cursor.emitted = Array.from(emitted);
    cursor.suggestions = suggestions.slice(0, MAX_SUGGESTION_QUERIES);
    cursor.counters.requests +=
      client.requests + (detailClient === client ? 0 : detailClient.requests);
    cursor.counters.rateLimitHits +=
      client.rateLimitHits + (detailClient === client ? 0 : detailClient.rateLimitHits);
    // `budget-exhausted` and `rate-limited` keep their phase so the next
    // tick resumes mid-flow; `query-cap` does too — a Resume grants the next
    // query tranche and the run must pick up exactly where it stopped.
    if (reason !== "budget-exhausted" && reason !== "rate-limited" && reason !== "query-cap") {
      cursor.phase = "done";
      // Terminal verdict: the temporary harvest and every working queue are
      // wiped so the persisted state stays light — the leads themselves live
      // in their own file and are never touched here.
      pool.cards = [];
      pool.collected = 0;
      tempIndex.clear();
      cursor.tempCandidates = [];
      cursor.cycleSeen = [];
      cursor.pendingQueue = [];
      cursor.candidateQueue = [];
      cursor.similarQueue = [];
      cursor.enrichQueue = [];
    }
    const finalStats = buildStats(
      cursor,
      filters,
      startedAt,
      currentQuery,
      totalPlan,
      pool.cards.length,
      harvestLimit(),
    );
    const result = attachCursor ? cursor : null;
    emit({ type: "done", reason, message, stats: finalStats, cursor: result });
    return { reason, message, cursor: result, stats: finalStats };
  };

  /** Query safety cap reached mid-step: keep the phase so Resume continues. */
  const finishQueryCap = (): StepResult =>
    finish(
      "query-cap",
      `Reached the ${cursor.counters.queriesRun}-query safety cap with ${leadsSoFar()} — press Resume to grant another tranche and continue.`,
      true,
    );

  // Safety backstop — checked before anything is scheduled so a resumed run
  // at its cap stops immediately instead of burning one more batch.
  if (
    options.queryBudget !== undefined &&
    cursor.counters.queriesRun >= options.queryBudget
  ) {
    return finish(
      "query-cap",
      `Reached the ${cursor.counters.queriesRun}-query safety cap with ${leadsSoFar()} — press Resume to grant another tranche and continue.`,
      true,
    );
  }

  /**
   * Card verdict with union relevance: judged against the cycle's keyword
   * first, falling back to the main keyword. A secondary phrase's harvest is
   * relevant to that phrase — but an app the earlier cycles missed that
   * answers the MAIN keyword must still convert instead of dying as
   * "not-relevant" in a cycle that was never about it. The returned lead (if
   * any) already carries the matching keyword, since the verdict was built
   * with that keyword's filters.
   */
  const evaluateCycled = (
    app: StoreApp,
    seenSet: ReadonlySet<string>,
  ): { evaluation: Evaluation; keyword: string } => {
    const primary = evaluateApp(app, activeFilters, seenSet);
    if (!primary.reasons.includes("not-relevant")) {
      return { evaluation: primary, keyword: activeCycleKeyword() };
    }
    if (activeFilters.keyword === filters.keyword) {
      return { evaluation: primary, keyword: activeCycleKeyword() };
    }
    const fallback = evaluateApp(app, { ...activeFilters, keyword: filters.keyword }, seenSet);
    if (!fallback.reasons.includes("not-relevant")) {
      return { evaluation: fallback, keyword: filters.keyword };
    }
    return { evaluation: primary, keyword: activeCycleKeyword() };
  };

  /**
   * Stashes fresh search/expansion cards into the active cycle's temporary
   * harvest pool — no verdict yet. The filter stage judges the whole pool at
   * once, after collection ends. Packages already settled (`seen`) or already
   * pooled this cycle are skipped as duplicates. Pool overflow still counts
   * as discovered (the pool refills from the same searches next cycle, once
   * the filter has drained it). Returns how many cards made progress (stashed
   * or upgraded) — the stagnation guard's input.
   */
  const stashTemp = (apps: StoreApp[], cardGl: string = filters.country): number => {
    const countryFinal = cardGl === filters.country;
    let progress = 0;
    for (const app of apps) {
      // A home-storefront card supersedes a foreign one already pooled: its
      // printed rating is final, and pooling the foreign card first must not
      // cost the home evaluation — that is exactly how leads were lost
      // before (a marked foreign card made the later home search hit the
      // duplicate path). Anything already settled stays skipped.
      const pooledAt = tempIndex.get(app.packageName);
      const pooled = pooledAt !== undefined ? pool.cards[pooledAt] : undefined;
      if (countryFinal && pooled !== undefined && pooled.gl !== filters.country) {
        pool.cards[pooledAt as number] = {
          p: app.packageName,
          t: app.title,
          d: app.developer,
          r: app.rating,
          rr: app.ratingRaw,
          i: app.installs,
          ir: app.installsRaw,
          c: app.category,
          s: clipSummary(app.summary),
          gl: cardGl,
        };
        progress += 1;
        continue;
      }
      if (seen.has(app.packageName) || cycleSeenSet.has(app.packageName)) {
        cursor.counters.duplicates += 1;
        continue;
      }
      // "New apps only": this keyword already produced this app in an earlier
      // run, so it is not news. Skipping it here — before the pool, before
      // the relevance check — is the whole point of the mode: the harvest
      // budget then buys apps the operator has never seen instead of
      // re-reading the same cards every run.
      if (soloMode && isKnown(app.packageName)) {
        cursor.counters.knownSkipped += 1;
        continue;
      }
      if (cursor.cycleSeen.length < MAX_SEEN_PACKAGES) {
        cycleSeenSet.add(app.packageName);
        cursor.cycleSeen.push(app.packageName);
      }
      cursor.counters.discovered += 1;
      if (countryFinal) cursor.counters.homeDiscovered += 1;
      if (app.rating !== null) {
        const lowest = cursor.counters.lowestRatingSeen;
        cursor.counters.lowestRatingSeen =
          lowest === null || app.rating < lowest ? app.rating : lowest;
      }
      // Relevance pre-check: a card whose complete text already fails BOTH
      // the cycle's keyword and the main keyword can never convert — skip it
      // so the pool holds only maybes instead of known rejects. Stub or
      // missing text still stashes (the detail page may complete the
      // keyword), and every skipped card stays collectible for later cycles
      // (never marked seen here).
      const precheck = evaluateCycled(app, seen);
      if (
        precheck.evaluation.reasons.includes("not-relevant") &&
        app.summary !== null &&
        app.summary.length >= CARD_TEXT_STUB_LENGTH &&
        app.summary.length < MAX_DESCRIPTION_LENGTH
      ) {
        cursor.counters.cardDropIrrelevant += 1;
        // In "new apps only" mode the run has a single keyword, so a card
        // whose complete text already fails it can never convert for this
        // keyword again. Recording that keeps every later run from
        // re-reading it. A normal run does not: another cycle's keyword
        // might still want it.
        if (soloMode) remember(app.packageName);
        continue;
      }
      // The pool stops growing once the harvest target is reached: anything
      // past it is left for a later cycle rather than pushed out of the inbox
      // (and, with it, dropped from the filter entirely).
      if (pool.cards.length >= Math.min(MAX_TEMP_CANDIDATES, harvestLimit())) continue;
      tempIndex.set(app.packageName, pool.cards.length);
      pool.cards.push(
        toPoolCard({
          p: app.packageName,
          t: app.title,
          d: app.developer,
          r: app.rating,
          rr: app.ratingRaw,
          i: app.installs,
          ir: app.installsRaw,
          c: app.category,
          s: clipSummary(app.summary),
          gl: cardGl,
        }),
      );
      pool.collected += 1;
      cursor.counters.collected += 1;
      progress += 1;
    }
    return progress;
  };

  /** Rebuilds the judgable card from a pooled entry (detail fills the rest). */
  function tempToApp(entry: TempCandidate): StoreApp {
    return {
      packageName: entry.p,
      title: entry.t,
      developer: entry.d,
      rating: entry.r,
      ratingRaw: entry.rr,
      ratingsCount: null,
      installs: entry.i,
      installsRaw: entry.ir,
      installsUpper: null,
      category: entry.c,
      summary: entry.s,
      description: null,
      icon: null,
      urlPath: null,
    };
  }

  /**
   * Settles one pooled card: the card-level verdict (match → verify queue,
   * partial text or missing installs → candidate queue, hopeless → dropped).
   * Returns true when the lead target has been reached. Judged with union
   * relevance (see {@link evaluateCycled}): the cycle's keyword first, the
   * main keyword as fallback. `cardGl` is the storefront that served the card
   * (see {@link cardCanStillQualify}).
   */
  const settleCard = (app: StoreApp, cardGl: string): boolean => {
    const countryFinal = cardGl === filters.country;
    const { evaluation } = evaluateCycled(app, seen);

    if (evaluation.reasons.includes("duplicate")) {
      cursor.counters.duplicates += 1;
      return false;
    }
    // Card-level kill funnel, by cause (reason hits, not cards): why a cycle
    // can collect plenty yet verify almost none.
    if (evaluation.reasons.includes("rating-too-high")) cursor.counters.cardDropRating += 1;
    if (evaluation.reasons.includes("installs-too-high")) cursor.counters.cardDropInstalls += 1;
    if (evaluation.reasons.includes("not-relevant")) cursor.counters.cardDropIrrelevant += 1;

      // A card seen abroad may still qualify at home: the BD detail page
      // never prints *lower* than the foreign card (probe: 10 of 10 agreed or
      // rose), so a foreign card at or under the ceiling but above the fetch
      // gate — or one that printed no rating at all — still owes a home
      // evaluation. Marking those as seen here made its later home search hit
      // the duplicate path, and the lead was lost forever. Foreign cards
      // printed above the ceiling can never pass at home and stay marked.
      const owedHomeCheck =
        !countryFinal &&
        (app.rating === null ||
          (roundRating(app.rating) <= activeFilters.maxRating &&
            !cardCanStillQualify(app, activeFilters, countryFinal)));
      if (!owedHomeCheck && seen.size < MAX_SEEN_PACKAGES) seen.add(app.packageName);
      // The keyword's cross-run memory follows the same rule: a judged app is
      // one this keyword has produced, so a later run in "new apps only" mode
      // must not offer it again. A card still owed a home check stays out —
      // it has not had its final verdict yet.
      if (!owedHomeCheck) remember(app.packageName);
      cursor.counters.evaluated += 1;

      if (evaluation.status === "match" && evaluation.lead) {
        const lead = evaluation.lead;
        if (emitted.has(lead.packageName)) return false;
        if (targetReached()) return true;

        // The search card's rating came from whichever storefront answered the
        // query, but the table must show this run's country. Queue the package
        // for its canonical detail page — the lead is emitted only after that
        // page confirms both ceilings, so rows that appear never have to be
        // retracted when the foreign storefront's rating turns out to differ.
        // The card must also leave room for cross-storefront drift: a foreign
        // card printed just under the ceiling is a near-certain miss at home
        // (research R9: 0 of 2 passed), and home cards jump the verify queue
        // via their `h` flag (research R6b: home cards verify 100%).
        const stillQualifies = cardCanStillQualify(app, activeFilters, countryFinal);
        if (stillQualifies && cursor.pendingQueue.length < MAX_PENDING_QUEUE) {
          if (!queuedPending.has(lead.packageName)) {
            queuedPending.add(lead.packageName);
            cursor.pendingQueue.push({
              p: lead.packageName,
              i: lead.installs,
              s: clipSummary(lead.summary),
              ...(countryFinal ? { h: true } : {}),
              o: countryFinal ? "hr" : "f",
              q: "m",
              v: true,
            });
            cursor.counters.candidates += 1;
            if (countryFinal) cursor.counters.homePending += 1;
          }
          return false;
        }
        // Safety valve: the verify queue is overflowing (hundreds of matches
        // inside one window). Show the card-verified lead instead of silently
        // discarding a candidate that already passed every card-side rule.
        if (stillQualifies) {
          if (
            emitLead(lead, {
              from: "card",
              origin: countryFinal ? "homeOther" : "foreign",
            })
          )
            return true;
          return false;
        }
        // Foreign card inside the drift dead band: the card already predicted
        // the rejection. Falls through so the rated card can still seed an
        // expansion walk without ever spending a verify fetch on itself.
      }

      const relevant = !evaluation.reasons.includes("not-relevant");
      // Unrated cards never seed expansions: live measurement showed they
      // pour into expansion neighborhoods (watch faces, 5-install trackers)
      // that can never carry a rating, flooding the verify queue with pages
      // that answer `rating=null` — 521 of 521 unrated verifies in one step.
      if (relevant && app.rating !== null) {
        pushSeed({ p: app.packageName, i: app.installs }, queuedSeeds);
      }

      // The card could not settle the verdict on its own: a partial keyword
      // hit, a decisive install count that is missing, or card text that
      // carries no keyword term at all while the numbers pass. (A missing
      // rating is undecided too, but the queue guard below never spends a
      // fetch on it — see the unrated note.)
      //
      // How much a detail fetch can still change depends on the text the card
      // already showed. Measured live on the BD storefront, a search card
      // carries the listing's own description (169 of 170 cards ≥300 chars)
      // — the card text and the detail description are the same text, so a
      // text verdict cannot change… unless the summary is missing, is a stub
      // under one screen's worth (which may be a layout clip), or was clipped
      // at MAX_DESCRIPTION_LENGTH, in each of which wording past what the
      // card showed may still complete the keyword. A baseline step confirmed
      // the cost of ignoring this: 255 of 260 text rejections were cards
      // whose text had already failed at queue time. Cards the card already
      // proves hopeless on the numbers (rating over the ceiling on any
      // storefront, install bucket over the cap) never queue at all.
      const undecidedNumbers = evaluation.reasons.some(
        (reason) =>
          reason === "missing-rating" ||
          reason === "missing-installs" ||
          reason === "unparseable-installs",
      );
      // A partial hit is only worth a detail fetch when the missing term may
      // still appear past the card's clip — the hit that *did* land came from
      // the title or description (developer/category-only hits can never
      // complete that way either).
      const primaryPartial = evaluation.primaryTerms.length > 0;
      // A card that prints no rating never earns a fetch, home or foreign.
      // Measured live: one run spent 785 unrated home verifies and got 0
      // leads back — 548 detail pages also answered "no rating" and 245
      // printed over the ceiling — while every one of those fetches was a
      // window second not spent on a rated card or a fresh search, the two
      // places leads actually arrive. Rated cards missing only the install
      // count still fetch: that gap really does close on the detail page.
      const unrated = app.rating === null;
      const descriptionRescue =
        evaluation.primaryTerms.length === 0 &&
        app.rating !== null &&
        roundRating(app.rating) <= activeFilters.maxRating &&
        (app.installs === null || app.installs <= activeFilters.maxInstalls);
      const textMayChange =
        app.summary === null ||
        app.summary.length < CARD_TEXT_STUB_LENGTH ||
        app.summary.length >= MAX_DESCRIPTION_LENGTH;
      const queueReason: "n" | "p" | "r" | null = undecidedNumbers
        ? relevant || textMayChange
          ? "n"
          : null
        : !relevant && primaryPartial && textMayChange
          ? "p"
          : descriptionRescue && textMayChange
            ? "r"
            : null;
      if (
        !unrated &&
        queueReason !== null &&
        cardCanStillQualify(app, activeFilters, countryFinal)
      ) {
        queueCandidate(app, countryFinal, queueReason, relevant);
      }
    return false;
  };

  /**
   * Counts a verified lead, streams it to the client and returns true when
   * this lead reached the target. The only place a lead ever becomes visible.
   */
  const emitLead = (
    lead: Lead,
    attribution?: {
      from: "pending" | "candidate" | "card";
      origin: "homeUnrated" | "homeOther" | "foreign";
    },
  ): boolean => {
    if (emitted.has(lead.packageName)) return targetReached();
    if (targetReached()) return true;

    emitted.add(lead.packageName);
    cursor.counters.matched += 1;
    cursor.leadDrought = 0;
    if (attribution) {
      // The card-verified overflow path produces what the pending queue would
      // have held, so it counts as a pending lead without a fetch.
      if (attribution.from !== "candidate") cursor.counters.leadFromPending += 1;
      else cursor.counters.leadFromCandidate += 1;
      if (attribution.origin === "homeUnrated") cursor.counters.leadHomeUnrated += 1;
      else if (attribution.origin === "homeOther") cursor.counters.leadHomeOther += 1;
      else cursor.counters.leadForeign += 1;
    }
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
    return targetReached();
  };

  /** Removes a package from the pending-verify queue (verified or gone). */
  function dropFromPending(pkg: string): void {
    queuedPending.delete(pkg);
    cursor.pendingQueue = cursor.pendingQueue.filter((entry) => entry.p !== pkg);
  }

  /**
   * Queues a card whose own evidence cannot settle it — partial keyword hit,
   * a missing number, or a description-only rescue — for one authoritative
   * detail-page fetch. The fetch re-runs every rule on the full text and this
   * run's country data, so nothing is ever shown that has not passed the same
   * gates as a match. Rated cards read from the run's own storefront jump the
   * queue: their printed rating *is* the verified number (100% pass measured,
   * R6b), and a home description-rescue is nearly as good — Play matched the
   * listing on a description the card never showed, which only happens when
   * the full text really carries the term. Foreign entries go to the back:
   * they still carry cross-storefront drift to survive. Cards that print no
   * rating never reach this function at all (see the queue guard in ingest).
   */
  function queueCandidate(
    app: StoreApp,
    homeFirst = false,
    reason: "n" | "p" | "r" = "n",
    textValid = false,
  ): void {
    const front = homeFirst && app.rating !== null;
    if (cursor.candidateQueue.length >= MAX_CANDIDATE_QUEUE) {
      // A full queue must never drop a card from the run's own storefront
      // whose printed number is already final: those are the entries that
      // actually convert. Evict from the back (a foreign or rescue entry) so
      // the home card takes its place instead of being lost at the cap.
      if (!front) return;
      const evicted = cursor.candidateQueue.pop();
      if (evicted) queuedCandidates.delete(evicted.p);
      else return;
    }
    if (queuedCandidates.has(app.packageName)) return;
    if (queuedPending.has(app.packageName)) return;
    if (emitted.has(app.packageName)) return;
    queuedCandidates.add(app.packageName);
    const entry: PendingVerify = {
      p: app.packageName,
      i: app.installs,
      s: clipSummary(app.summary),
      o: homeFirst ? (app.rating !== null ? "hr" : "hu") : "f",
      q: reason,
      ...(textValid ? { v: true as const } : {}),
    };
    // Rated home cards jump the queue: their printed number is final and the
    // detail page answers the same storefront, so both ceilings and the text
    // are known-good (research R6b: home cards verify 100%). Home
    // description-rescues go to the front too — Play matched them on a
    // description the card never showed, which is the strongest signal a
    // rescue has. Foreign entries go to the back: they carry cross-storefront
    // drift. Unrated cards never queue (ingest blocks them), so the `hu`
    // origin below only ever exists on cursors written before that change.
    if (front) {
      cursor.candidateQueue.unshift(entry);
    } else {
      cursor.candidateQueue.push(entry);
    }
    if (homeFirst) cursor.counters.homeQueued += 1;
    cursor.counters.candidates += 1;
  }

  /** Removes a package from the candidate queue (settled or gone). */
  function dropFromCandidate(pkg: string): void {
    queuedCandidates.delete(pkg);
    cursor.candidateQueue = cursor.candidateQueue.filter((entry) => entry.p !== pkg);
  }

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
    dropFromPending(pkg);
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
    // Play serves page variants: a fetch can come back with no readable app
    // at all, or with the listing but no rating block. The verification fetch
    // already confirmed this lead against the same storefront, so an
    // unreadable follow-up is *no information* — dropping the row made leads
    // blink out of the table minutes after arriving (live report: "one lead
    // comes, then turns off"). Only a page that explicitly contradicts the
    // filters removes the lead.
    if (!app || app.packageName !== pkg) return;

    const qualifies = detailAppQualifies(app, filters);
    if (qualifies) {
      // The store prints one decimal; hand the client the same number Play
      // shows so the table and the CSV never differ from the store listing.
      if (emitted.has(pkg)) emit({ type: "lead-update", app: { ...app, rating: roundRating(app.rating) } });
      return;
    }

    // No rating to judge by: the original verification stands. A rating or
    // install bucket that now breaches the ceiling removes the row — but a
    // rating only counts when its source is package-scoped (JSON-LD or this
    // package's data blob). The visible "Rated … stars" markup is
    // positional: a live layout variant put a similar app's 4.5 label first
    // while this listing prints 2.9, and dropping on that number made a lead
    // disappear seconds after it arrived. Install buckets are label-anchored
    // ("… Downloads"), so they always count.
    if (app.rating === null) return;
    const ratingBreach = roundRating(app.rating) > filters.maxRating;
    const packageScoped = app.ratingSource === "jsonld" || app.ratingSource === "af";
    const installsBreach = app.installs !== null && app.installs > filters.maxInstalls;
    if (installsBreach || (ratingBreach && packageScoped)) dropLead(pkg);
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

      if (stashTemp(result.apps, entry.gl) > 0) cursor.stagnantQueries = 0;
      else cursor.stagnantQueries += 1;
      cursor.leadDrought += 1;
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
      const detail = await fetchAppDetail(detailClient, seed.p, "en", filters.country);
      cursor.counters.pagesFetched += 1;
      parseFailures = 0;
      transportFailures = 0;

      if (cursor.enrichQueue.includes(seed.p)) {
        cursor.enrichQueue = cursor.enrichQueue.filter((pkg) => pkg !== seed.p);
        queuedEnrich.delete(seed.p);
      }
      applyDetail(seed.p, detail.app);

      // Expansion discoveries join the active cycle's harvest pool — the
      // filter stage settles them in order instead of verifying mid-search.
      stashTemp(detail.similarApps, filters.country);
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
      const detail = await fetchAppDetail(detailClient, pkg, "en", filters.country);
      cursor.counters.pagesFetched += 1;
      enrichRequests += 1;
      parseFailures = 0;
      transportFailures = 0;

      // Enrichment is pure metadata backfill now: expansion walks happen in
      // the filter stage, where discoveries join the active harvest pool.
      applyDetail(pkg, detail.app);
      if (!expanded.has(pkg)) {
        expanded.add(pkg);
        cursor.expanded.push(pkg);
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

  /**
   * Verifies one queued card against its canonical detail page from this run's
   * country — the single gate a lead must pass before it may appear.
   *
   * Serves both queues: a search-card match (`"pending"` — confirm the
   * country's numbers) and an undecided card (`"candidate"` — the full
   * description decides the keyword, the country's page decides the
   * ceilings). Either way the table only ever shows leads this page
   * confirmed, so rows never have to be retracted when the foreign
   * storefront's data disagreed with them.
   */
  async function runVerifyTask(
    entry: PendingVerify,
    queue: "pending" | "candidate",
  ): Promise<TaskOutcome> {
    if (options.aborted?.()) return "ok";
    if (queue === "pending") {
      pendingRequests += 1;
      cursor.counters.verifyFromPending += 1;
    } else {
      candidateRequests += 1;
      cursor.counters.verifyFromCandidate += 1;
    }
    const origin: "homeUnrated" | "homeOther" | "foreign" =
      queue === "pending"
        ? entry.h === true
          ? "homeOther"
          : "foreign"
        : entry.o === "hu"
          ? "homeUnrated"
          : entry.o === "hr"
            ? "homeOther"
            : "foreign";
    currentQuery = entry.p;
    emit({
      type: "progress",
      stats: stats(),
      message: `Fetching details for ${entry.p}…`,
    });

    const drop = (): void => {
      if (queue === "pending") dropFromPending(entry.p);
      else dropFromCandidate(entry.p);
    };

    try {
      const detail = await fetchAppDetail(detailClient, entry.p, "en", filters.country);
      cursor.counters.pagesFetched += 1;
      parseFailures = 0;
      transportFailures = 0;
      drop();

      // Settle this entry first — the page we just paid for decides whether
      // it becomes a lead — then keep walking from the same fetch.
      let target = false;
      let settled = false;
      let textRejected = false;
      if (detail.app && detail.app.packageName === entry.p) {
        // The detail page is authoritative for numbers: a missing install
        // bucket falls back to the card's value (same storefront answer, just
        // less precise). Text does NOT fall back to the search card: when a
        // page variant arrives with no description at all, the card snippet
        // can carry query context that the listing itself never says — a live
        // run emitted an "Alice's Hotel" lead for the keyword "wallet" that
        // way while the real page contained the word zero times. No detail
        // text means the keyword cannot be confirmed, so the entry rejects.
        const app: StoreApp = {
          ...detail.app,
          installs: detail.app.installs ?? entry.i,
        };
        if (detailAppQualifies(app, filters)) {
          // Numbers passed: every remaining way to lose here is a relevance
          // loss (the full text still misses a required term, or carries none
          // at all), so it belongs in the text bucket — the ceiling bucket is
          // reserved for verifications whose numbers never confirmed.
          const evalSeen = new Set(seen);
          evalSeen.delete(entry.p);
          // Union relevance, same as the settle verdict: an app queued from
          // a secondary harvest that answers the main keyword must still be
          // allowed to convert here, or settling would queue fetches the
          // verification then rejects.
          const evaluation = evaluateCycled(app, evalSeen).evaluation;
          if (evaluation.status === "match" && evaluation.lead) {
            settled = true;
            target = emitLead(evaluation.lead, { from: queue, origin });
          } else if (!evaluation.reasons.includes("not-relevant")) {
            // Kept the keyword but broke a ceiling: the closest misses make
            // the best expansion seeds (their neighborhood tends to match).
            pushSeed({ p: entry.p, i: app.installs }, queuedSeeds);
            textRejected = true;
          } else {
            textRejected = true;
          }
        } else {
          cursor.counters.verifyCeilingRejected += 1;
          if (app.rating === null) cursor.counters.verifyCeilingMissing += 1;
          else if (roundRating(app.rating) > filters.maxRating)
            cursor.counters.verifyCeilingRating += 1;
          else cursor.counters.verifyCeilingInstalls += 1;
        }
      } else {
        // Unreadable page or package mismatch: the numeric gate could not be
        // confirmed, so this is a ceiling-bucket rejection, not a text one.
        cursor.counters.verifyCeilingRejected += 1;
        cursor.counters.verifyCeilingMissing += 1;
      }
      if (!settled) {
        cursor.counters.verifyRejected += 1;
        if (textRejected) {
          cursor.counters.verifyTextRejected += 1;
          if (entry.v === true) cursor.counters.rejectTextCardGood += 1;
          else cursor.counters.rejectTextCardBad += 1;
        }
        if (origin === "homeUnrated") cursor.counters.rejectHomeUnrated += 1;
        else if (origin === "homeOther") cursor.counters.rejectHomeOther += 1;
        else cursor.counters.rejectForeign += 1;
      }
      if (target) return "target";

      if (detail.app && detail.app.packageName === entry.p && !expanded.has(entry.p)) {
        expanded.add(entry.p);
        cursor.expanded.push(entry.p);
        // Similar apps join the active cycle's harvest pool — settled by the
        // filter stage in order. Seeding already happened above for relevant
        // near-misses, so nothing here can reach the target directly.
        stashTemp(detail.similarApps, filters.country);
      }
      return "ok";
    } catch (error) {
      if (error instanceof PlayRateLimitError) return "rate-limited";

      if (error instanceof PlayHttpError && error.status === 404) {
        // Gone before it was ever shown: drop the entry silently — there is
        // no row to retract and no lead to count.
        drop();
        return "ok";
      }

      // The candidate stays queued and is retried on the next step rather
      // than inside this window (a permanent per-URL failure must not spin).
      pendingRetried.add(entry.p);

      if (error instanceof PlayParseError) {
        parseFailures += 1;
        return "parse-failure";
      }

      transportFailures += 1;
      emit({
        type: "warning",
        message: `Could not fetch details for ${entry.p}.`,
      });
      return "transport-failure";
    }
  }

  const verifyFlight = new Set<string>();
  /**
   * Pulls the next unverified match, skipping ones already retried. Cards read
   * from the run's own storefront go first: their printed rating is already
   * the number the detail page will confirm (research R6b: 2 of 2 passed),
   * while a foreign match still has cross-storefront drift to survive (R9:
   * 0 of 2 in the top band) — verifying home first keeps a scarce verify
   * slot from being spent on the likelier miss.
   */
  const pullPendingTask = (): Promise<TaskOutcome> | null => {
    if (pendingRequests >= MAX_PENDING_PER_STEP) return null;
    for (const pass of [true, false]) {
      for (const entry of cursor.pendingQueue) {
        if ((entry.h === true) !== pass) continue;
        if (verifyFlight.has(entry.p) || pendingRetried.has(entry.p)) continue;
        verifyFlight.add(entry.p);
        return runVerifyTask(entry, "pending").then((outcome) => {
          verifyFlight.delete(entry.p);
          return outcome;
        });
      }
    }
    return null;
  };

  /**
   * Pulls the next undecided card. Matches always get their fetches first:
   * a match is one confirm away from becoming a lead, while an undecided
   * card still has to prove itself.
   */
  const pullCandidateTask = (): Promise<TaskOutcome> | null => {
    if (candidateRequests >= MAX_CANDIDATE_PER_STEP) return null;
    for (const entry of cursor.candidateQueue) {
      if (verifyFlight.has(entry.p) || pendingRetried.has(entry.p)) continue;
      // A cursor written before unrated cards stopped queueing may still
      // hold one: drop it without a fetch — 785 such verifications measured
      // 0 leads, so the window belongs to rated cards. (dropFromCandidate
      // reassigns the array; this loop keeps walking its original snapshot.)
      if (entry.o === "hu") {
        dropFromCandidate(entry.p);
        continue;
      }
      verifyFlight.add(entry.p);
      return runVerifyTask(entry, "candidate").then((outcome) => {
        verifyFlight.delete(entry.p);
        return outcome;
      });
    }
    return null;
  };

  /** Next verification fetch for this window: confirmed match first, then undecided card. */
  const pullVerifyTask = (): Promise<TaskOutcome> | null =>
    pullPendingTask() ?? pullCandidateTask();

  // --------------------------------------------------------------- suggest --
  while (cursor.phase === "suggest") {
    const prefixes = suggestPrefixes(cursor.keyword);
    if (cursor.suggestIndex >= prefixes.length) {
      startCycle(0);
      break;
    }
    if (suggestions.length >= MAX_SUGGESTION_QUERIES) {
      startCycle(0);
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
    let suggestThrottled = false;
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
          // Pushback on suggestions means the session is throttled: stop
          // asking and let the search stage (which reports rate-limited
          // properly) decide. Without this the loop burns the whole window
          // re-asking an endpoint that already said no — each pushback
          // doubles the request spacing, so a throttled suggest round alone
          // can eat minutes.
          if (error instanceof PlayRateLimitError) suggestThrottled = true;
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

    if (suggestThrottled) {
      startCycle(0);
      break;
    }
  }

  /**
   * Opens the next keyword cycle after a miss, or reports the run terminal.
   * Priority: queued keywords first, then one AI round (asked against the
   * MAIN keyword so every phrase stays in its neighbourhood), then built-in
   * alternate phrases — but only once AI was attempted at least once this run
   * (the run-level prime), so runs without a generator stop honestly instead
   * of wandering deterministically. Declared at step scope (not inside the
   * cycle loop below) so both the filter stage and the terminal pass share it.
   */
  async function advanceCycle(): Promise<"continue" | StepResult> {
    const next = cursor.keywordIndex + 1;
    if (next < cursor.keywords.length) {
      startCycle(next);
      return "continue";
    }

    // "New apps only" mode: the operator asked for this one keyword, so the
    // run ends here instead of wandering into AI phrases or the built-in
    // alternates. The keyword's supply of new apps is spent — that is the
    // answer the mode was asked for.
    if (soloMode) {
      if (cursor.enrichQueue.length > 0) {
        cursor.phase = "enrich";
        return "continue";
      }
      return finish(
        cursor.counters.discovered === 0 ? "no-results" : "plan-exhausted",
        `Finished “${filters.keyword}” — ${cursor.counters.matched} new lead${
          cursor.counters.matched === 1 ? "" : "s"
        } from ${cursor.counters.collected} new apps (${cursor.counters.knownSkipped} already known).`,
        false,
      );
    }

    const generate = options.generateSecondary;
    if (
      generate !== undefined &&
      cursor.secondaryRounds < MAX_SECONDARY_ROUNDS &&
      cursor.dryRounds < MAX_CONSECUTIVE_DRY_ROUNDS
    ) {
      // A round is one Groq call (10s). Only start it when a whole round
      // still fits: generation must never be the thing that blows the budget.
      if (!hasTimeForRequest(ROUND_HEADROOM_MS)) {
        return finish(
          "budget-exhausted",
          "Time budget reached for this step — resume to continue.",
          true,
        );
      }
      const round = cursor.secondaryRounds + 1;
      emit({
        type: "progress",
        stats: stats(),
        message: `Main keyword swept without hitting the target — generating related keywords (round ${round} of ${MAX_SECONDARY_ROUNDS})…`,
      });
      let fresh: string[] = [];
      try {
        fresh = await generate(cursor.keyword, cursor.keywords);
      } catch {
        fresh = [];
      }
      cursor.secondaryRounds = round;
      const queued = new Set(cursor.keywords.map((entry) => entry.toLowerCase()));
      const room = Math.max(0, MAX_KEYWORDS - cursor.keywords.length);
      const added = fresh
        .map((phrase) => phrase.trim())
        .filter((phrase) => phrase.length >= 2 && !queued.has(phrase.toLowerCase()))
        .slice(0, room);
      if (added.length > 0) {
        cursor.dryRounds = 0;
        for (const phrase of added) cursor.keywords.push(phrase);
        startCycle(next);
        emit({
          type: "progress",
          stats: stats(),
          message: `Queued ${added.length} related keywords (round ${round}) — collecting them one by one…`,
        });
        return "continue";
      }
      cursor.dryRounds += 1;
      emit({
        type: "progress",
        stats: stats(),
        message: `Round ${round} produced no new keywords — falling back to built-in alternates.`,
      });
    }

    if (cursor.secondaryTried) {
      const queued = new Set(cursor.keywords.map((entry) => entry.toLowerCase()));
      const alternates = keywordVariants(cursor.keyword)
        .filter((phrase) => !queued.has(phrase.toLowerCase()))
        .slice(0, MAX_VARIANT_BACKSTOP);
      const room = Math.max(0, MAX_KEYWORDS - cursor.keywords.length);
      if (alternates.length > 0 && room > 0) {
        for (const phrase of alternates.slice(0, room)) cursor.keywords.push(phrase);
        startCycle(next);
        emit({
          type: "progress",
          stats: stats(),
          message: `Trying built-in alternate keywords for “${cursor.keyword}”…`,
        });
        return "continue";
      }
    }

    // Leads waiting on metadata backfill get it before any terminal verdict:
    // without this handoff the enrich phase would never run on a run whose
    // cycles all completed.
    if (cursor.enrichQueue.length > 0) {
      cursor.phase = "enrich";
      return "continue";
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

  // --------------------------------------- cycles: collect → filter → enrich, repeat --
  // Each keyword gets one harvest (collect: searches only) and one verdict
  // (filter: settle the pool, verify, expand), then metadata backfill
  // (enrich), then the run advances to the next keyword until the target
  // hits. Every stage resumes mid-flow across steps via the cursor.
  for (;;) {
  while (cursor.phase === "collect" || cursor.phase === "filter") {
    if (targetReached()) {
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

    // --------------------------------------------------------------- collect --
    // One keyword's harvest: searches ONLY — no verify, enrich or expand pulls
    // compete for slots, so the pool fills at full search concurrency. Cards
    // land in the harvest pool (`stashTemp`); the filter stage judges them
    // only once the pool reaches HARVEST_TARGET (or the keyword runs out of
    // supply), so the widest possible candidate set is what gets filtered.
    if (cursor.phase === "collect") {
      if (
        options.queryBudget !== undefined &&
        cursor.counters.queriesRun >= options.queryBudget
      ) {
        return finishQueryCap();
      }

    const pullCollectTask = (): Promise<TaskOutcome> | null => {
      const entry = entryAt(queries, cursor.planIndex, filters.country);
      if (!entry) return null;
      cursor.planIndex += 1;
      cursor.cycleQueries += 1;
      currentQuery = entry.query;
      emit({
        type: "progress",
        stats: stats(),
        message: `Searching Play Store for “${entry.query}” (${entry.gl})…`,
      });
      return runSearchTask(entry);
    };

    const outcomes = await runWindow(
      SEARCH_CONCURRENCY,
      pullCollectTask,
      () =>
        !targetReached() &&
        pool.cards.length < harvestLimit() &&
        cursor.cycleQueries < cycleQueryLimit() &&
        cursor.stagnantQueries < MAX_STAGNANT_QUERIES &&
        cursor.leadDrought < MAX_LEAD_DROUGHT_QUERIES &&
        (options.queryBudget === undefined ||
          cursor.counters.queriesRun < options.queryBudget) &&
        hasTimeForRequest(BATCH_HEADROOM_MS) &&
        parseFailures < MAX_PARSE_FAILURES &&
        transportFailures < MAX_TRANSPORT_FAILURES,
    );

    const failure = batchFailure(outcomes);
    if (failure) return failure;
    if (
      options.queryBudget !== undefined &&
      cursor.counters.queriesRun >= options.queryBudget
    ) {
      return finishQueryCap();
    }

    // The window closed for one of these reasons: the harvest target was hit,
    // the lead target was hit, the keyword's plan ran out, its neighbourhood
    // went stale, or the step ran out of time. All but the last mean "this
    // keyword is done, judge what it collected" — on a pause the pool is
    // handed back to the store and the next step resumes harvesting, so a
    // rate limit never costs the collected apps.
    const supplyLeft = entryAt(queries, cursor.planIndex, filters.country) !== null;
    const harvestComplete =
      pool.cards.length >= harvestLimit() ||
      targetReached() ||
      !supplyLeft ||
      cursor.cycleQueries >= cycleQueryLimit() ||
      cursor.stagnantQueries >= MAX_STAGNANT_QUERIES ||
      cursor.leadDrought >= MAX_LEAD_DROUGHT_QUERIES;

    if (!harvestComplete) {
      // Time or query budget ran out mid-harvest: keep the phase so the next
      // step continues collecting this same keyword's pool.
      return finish(
        "budget-exhausted",
        `Collected ${pool.cards.length}/${harvestLimit()} apps for “${activeCycleKeyword()}” — resume to keep harvesting this keyword.`,
        true,
      );
    }

    emit({
      type: "progress",
      stats: stats(),
      message:
        `Collected ${pool.cards.length} apps for “${activeCycleKeyword()}” — ` +
        `filtering by rating ≤ ${activeFilters.maxRating} and installs ≤ ${activeFilters.maxInstalls} now…`,
    });
    cursor.phase = "filter";
    }

  // ---------------------------------------------------------------- filter --
  // One keyword's verdict: settle the harvested pool in order (match → verify
  // queue, partial text or missing installs → candidate queue, hopeless →
  // dropped), then drain the verify queues while walking similar-app seeds.
  // Expansion discoveries rejoin the same pool. When pool and queues are all
  // empty the cycle completes: target check, then the next keyword cycle.
  if (cursor.phase === "filter") {
    // Settle pass: pure CPU, no requests — every pooled card gets its
    // card-level verdict and leaves the pool (queued or dropped). Settling
    // consumes the pool, so a finished cycle carries nothing over.
    let hitTarget = false;
    while (pool.cards.length > 0 && hasTimeForRequest(REQUEST_HEADROOM_MS)) {
      const pooled = pool.cards.shift();
      if (!pooled) break;
      tempIndex.delete(pooled.p);
      cursor.counters.filtered += 1;
      if (settleCard(tempToApp(pooled), pooled.gl)) {
        hitTarget = true;
        break;
      }
    }
    // `shift()` renumbered every surviving entry, so the package → index map
    // is stale now. Expansion below pushes into the same pool via `stashTemp`,
    // and a stale index there would let a home-storefront card overwrite a
    // DIFFERENT app's pooled data — a silently corrupted lead. Rebuilding a
    // 1000-entry map is free next to the network work around it.
    if (tempIndex.size > 0) {
      tempIndex.clear();
      pool.cards.forEach((entry, index) => {
        if (!tempIndex.has(entry.p)) tempIndex.set(entry.p, index);
      });
    }
    if (hitTarget) {
      cursor.phase = "enrich";
      break;
    }

    const verifyOutcomes = await runWindow(
      SEARCH_CONCURRENCY,
      () => {
        const verify = pullVerifyTask();
        if (verify) return verify;
        if (expandRequests >= MAX_EXPAND_REQUESTS) return null;
        const [seed] = takeSeeds(1);
        return seed ? runExpandTask(seed) : null;
      },
      () =>
        cursor.counters.matched < filters.limit &&
        hasTimeForRequest(BATCH_HEADROOM_MS) &&
        parseFailures < MAX_PARSE_FAILURES &&
        transportFailures < MAX_TRANSPORT_FAILURES,
    );

    const verifyFailure = batchFailure(verifyOutcomes);
    if (verifyFailure) return verifyFailure;
    if (verifyOutcomes.includes("target")) {
      cursor.phase = "enrich";
      break;
    }

    if (
      pool.cards.length === 0 &&
      cursor.pendingQueue.length === 0 &&
      cursor.candidateQueue.length === 0
    ) {
      // Expansion walk finished the cycle's inbox. If the keyword has queries
      // left and has not yet harvested its target, go back and collect more
      // before the run moves on — the harvest floor is what makes this
      // keyword's pool worth filtering.
      if (
        pool.cards.length < harvestLimit() &&
        entryAt(queries, cursor.planIndex, filters.country) !== null &&
        cursor.cycleQueries < cycleQueryLimit() &&
        cursor.stagnantQueries < MAX_STAGNANT_QUERIES &&
        cursor.leadDrought < MAX_LEAD_DROUGHT_QUERIES
      ) {
        cursor.phase = "collect";
        continue;
      }
      // Cycle complete: pool bookkeeping discarded (already empty), the
      // cycle counted, then either stop on target or open the next keyword.
      // The harvest size is read BEFORE the pool is wiped — the summary line
      // below has to report what this cycle actually collected.
      const harvested = pool.collected;
      pool.cards = [];
      pool.collected = 0;
      tempIndex.clear();
      cursor.tempCandidates = [];
      cursor.cycleSeen = [];
      cycleSeenSet.clear();
      cursor.counters.cycles += 1;
      const droughtNote =
        cursor.leadDrought >= MAX_LEAD_DROUGHT_QUERIES
          ? ` — no leads after ${cursor.leadDrought} searches, trying a related keyword`
          : "";
      emit({
        type: "progress",
        stats: stats(),
        message: `Finished “${activeCycleKeyword()}”${droughtNote} — harvested ${harvested} apps — ${leadsSoFar()} so far.`,
      });
      if (targetReached()) {
        cursor.phase = "enrich";
        break;
      }
      const advanced = await advanceCycle();
      if (advanced === "continue") continue;
      return advanced;
    }

    if (verifyOutcomes.length === 0 && pool.cards.length === 0) {
      // The queues hold only entries already retried this step (transport
      // kept failing them): nothing more can settle before the next step.
      return finish(
        "budget-exhausted",
        "Verifying the queued candidates — resume to continue.",
        true,
      );
    }
    }
  }

  // ---------------------------------------------------------------- enrich --
  while (cursor.phase === "enrich") {
    if (targetReached()) break;

    // Drain verifications before anything else: every entry here already
    // earned its place from a search or a detail fetch, and a terminal
    // decision with either queue non-empty would discard leads the run has
    // already spent requests on.
    if (cursor.pendingQueue.length > 0 || cursor.candidateQueue.length > 0) {
      if (!hasTimeForRequest(BATCH_HEADROOM_MS)) {
        return finish(
          "budget-exhausted",
          "Time budget reached for this step — resume to continue.",
          true,
        );
      }
      const verifyOutcomes = await runWindow(ENRICH_CONCURRENCY, pullVerifyTask, () =>
        cursor.counters.matched < filters.limit &&
        hasTimeForRequest(BATCH_HEADROOM_MS) &&
        parseFailures < MAX_PARSE_FAILURES &&
        transportFailures < MAX_TRANSPORT_FAILURES,
      );
      const verifyFailure = batchFailure(verifyOutcomes);
      if (verifyFailure) return verifyFailure;
      // Nothing pulled (everything left was already retried this step) or the
      // target just closed the queues — stop looping over unchanged queues.
      if (verifyOutcomes.length === 0 || verifyOutcomes.includes("target")) break;
      continue;
    }

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
  // Terminal pass after the stages: target check, then leftover queues (never
  // discard work the run already spent requests on), then the next cycle.
  if (targetReached()) {
    return finish(
      "target-reached",
      `Found ${cursor.counters.matched} matching leads for “${filters.keyword}”.`,
      false,
    );
  }

  if (cursor.pendingQueue.length > 0) {
    return finish(
      "budget-exhausted",
      `Verifying ${cursor.pendingQueue.length} candidate${cursor.pendingQueue.length === 1 ? "" : "s"} against the ${filters.country} Play Store — resume to continue.`,
      true,
    );
  }

  if (cursor.candidateQueue.length > 0) {
    return finish(
      "budget-exhausted",
      `Reading detail pages for ${cursor.candidateQueue.length} undecided app${cursor.candidateQueue.length === 1 ? "" : "s"} — resume to continue.`,
      true,
    );
  }

  if (cursor.enrichQueue.length > 0) {
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

  const advanced = await advanceCycle();
  if (advanced === "continue") continue;
  return advanced;
  }
}
