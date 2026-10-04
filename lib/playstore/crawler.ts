import { cardCanStillQualify, detailAppQualifies, evaluateApp } from "@/lib/filters/leadFilter";
import { roundRating } from "@/lib/parser/rating";
import type {
  DoneReason,
  GenerationEvent,
  GenerationStats,
  Lead,
  LeadFilters,
  PendingVerify,
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
 * the search window pulls these first (see `pullSearchTask`) so the rating the
 * table shows is refreshed from the run's own country within seconds instead
 * of waiting for a phase that may never run within the time budget.
 */
const MAX_ENRICH_QUEUE = 1_000;
/** Enriched detail pages per step before the step reports back to the caller. */
const MAX_ENRICH_PER_STEP = 200;
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
const MAX_PENDING_PER_STEP = 700;
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
const MAX_CANDIDATE_PER_STEP = 1000;
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
const EXPAND_SLOTS_FULL = 16;
const EXPAND_SLOTS_SPARSE = 6;
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
    pendingQueue: [],
    candidateQueue: [],
    secondary: [],
    secondaryTried: false,
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

  // `let` because the search loop appends a new query wave when the plan runs
  // out before the lead limit is reached (see below).
  let queries = buildPlanQueries(cursor.keyword, suggestions, cursor.wave, cursor.secondary);
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

  /**
   * Returns true when the lead target has been reached. `cardGl` is the
   * storefront the cards were read from: when it matches the run's country
   * the printed rating is final, foreign cards still have cross-storefront
   * drift to give them a chance (see {@link cardCanStillQualify}).
   */
  const ingest = (apps: StoreApp[], cardGl: string = filters.country): boolean => {
    const countryFinal = cardGl === filters.country;
    for (const app of apps) {
      const evaluation = evaluateApp(app, filters, seen);

      if (evaluation.reasons.includes("duplicate")) {
        cursor.counters.duplicates += 1;
        continue;
      }

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
          (roundRating(app.rating) <= filters.maxRating &&
            !cardCanStillQualify(app, filters, countryFinal)));
      if (!owedHomeCheck && seen.size < MAX_SEEN_PACKAGES) seen.add(app.packageName);
      cursor.counters.discovered += 1;
      cursor.counters.evaluated += 1;
      if (countryFinal) cursor.counters.homeDiscovered += 1;

      if (app.rating !== null) {
        const lowest = cursor.counters.lowestRatingSeen;
        cursor.counters.lowestRatingSeen =
          lowest === null || app.rating < lowest ? app.rating : lowest;
      }

      if (evaluation.status === "match" && evaluation.lead) {
        const lead = evaluation.lead;
        if (emitted.has(lead.packageName)) continue;
        if (cursor.counters.matched >= filters.limit) return true;

        // The search card's rating came from whichever storefront answered the
        // query, but the table must show this run's country. Queue the package
        // for its canonical detail page — the lead is emitted only after that
        // page confirms both ceilings, so rows that appear never have to be
        // retracted when the foreign storefront's rating turns out to differ.
        // The card must also leave room for cross-storefront drift: a foreign
        // card printed just under the ceiling is a near-certain miss at home
        // (research R9: 0 of 2 passed), and home cards jump the verify queue
        // via their `h` flag (research R6b: home cards verify 100%).
        const stillQualifies = cardCanStillQualify(app, filters, countryFinal);
        if (stillQualifies && cursor.pendingQueue.length < MAX_PENDING_QUEUE) {
          if (!queuedPending.has(lead.packageName)) {
            queuedPending.add(lead.packageName);
            cursor.pendingQueue.push({
              p: lead.packageName,
              i: lead.installs,
              s: clipSummary(lead.summary),
              ...(countryFinal ? { h: true } : {}),
            });
            cursor.counters.candidates += 1;
            if (countryFinal) cursor.counters.homePending += 1;
          }
          continue;
        }
        // Safety valve: the verify queue is overflowing (hundreds of matches
        // inside one window). Show the card-verified lead instead of silently
        // discarding a candidate that already passed every card-side rule.
        if (stillQualifies) {
          if (emitLead(lead)) return true;
          continue;
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

      // The card could not settle the verdict on its own: either its text
      // carries only part of the keyword (the listing's description may
      // complete it), a decisive number is missing (the detail page reports
      // it for this run's country), or the card's own text carries no keyword
      // term at all while both printed numbers already pass (Play returned it
      // for this query, so the full description may hold the terms the
      // truncated card text lacks — the detail page is the first place that
      // text can even be read). Cards the card already proves hopeless (rating
      // over the ceiling on any storefront, install bucket over the cap) never
      // queue: measured live, foreign cards printed above the ceiling passed
      // 0 of 10 checks at home (research R6), so fetching them only burned the
      // verify budget on rejections that were visible before the request went
      // out.
      const undecidedNumbers = evaluation.reasons.some(
        (reason) =>
          reason === "missing-rating" ||
          reason === "missing-installs" ||
          reason === "unparseable-installs",
      );
      // A partial hit is only worth a detail fetch when the missing term may
      // still appear in the description the card could not show — i.e. the
      // hit that *did* land came from the title or description. A hit found
      // only in the developer or category can never complete that way (the
      // verify re-reads title + description), so it falls through to the
      // rescue below instead of burning a fetch on a predicted text reject.
      const primaryPartial = evaluation.primaryTerms.length > 0;
      // A foreign card that prints no rating never earns a fetch: the BD
      // detail page answers "no rating" for these far more often than it
      // rescues one, and every such fetch is a verify slot not spent on a
      // rated home card that passes for certain.
      const foreignUnrated = !countryFinal && app.rating === null;
      const descriptionRescue =
        evaluation.primaryTerms.length === 0 &&
        app.rating !== null &&
        roundRating(app.rating) <= filters.maxRating &&
        (app.installs === null || app.installs <= filters.maxInstalls);
      if (
        !foreignUnrated &&
        ((!relevant && primaryPartial) ||
          undecidedNumbers ||
          descriptionRescue) &&
        cardCanStillQualify(app, filters, countryFinal)
      ) {
        queueCandidate(app, countryFinal);
      }
    }
    return false;
  };

  /**
   * Counts a verified lead, streams it to the client and returns true when
   * this lead reached the target. The only place a lead ever becomes visible.
   */
  const emitLead = (lead: Lead): boolean => {
    if (emitted.has(lead.packageName)) return cursor.counters.matched >= filters.limit;
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
    return cursor.counters.matched >= filters.limit;
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
   * the full text really carries the term. Unrated cards and foreign entries
   * go to the back: unrated fetches measured 521 of 521 wasted verifies, and
   * foreign cards still carry cross-storefront drift to survive.
   */
  function queueCandidate(app: StoreApp, homeFirst = false): void {
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
    const entry = { p: app.packageName, i: app.installs, s: clipSummary(app.summary) };
    // Rated home cards jump the queue: their printed number is final and the
    // detail page answers the same storefront, so both ceilings and the text
    // are known-good (research R6b: home cards verify 100%). Home
    // description-rescues go to the front too — Play matched them on a
    // description the card never showed, which is the strongest signal a
    // rescue has. Unrated cards (home or foreign) and every foreign entry go
    // to the back: unrated fetches measured 521 of 521 wasted verifies, and
    // foreign cards carry cross-storefront drift.
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
    // install bucket that now breaches the ceiling is real and drops the row.
    if (app.rating === null) return;
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

      if (ingest(result.apps, entry.gl)) return "target";
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
    if (queue === "pending") pendingRequests += 1;
    else candidateRequests += 1;
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
      const detail = await fetchAppDetail(client, entry.p, "en", filters.country);
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
          const evaluation = evaluateApp(app, filters, evalSeen);
          if (evaluation.status === "match" && evaluation.lead) {
            settled = true;
            target = emitLead(evaluation.lead);
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
        if (textRejected) cursor.counters.verifyTextRejected += 1;
      }
      if (target) return "target";

      if (detail.app && detail.app.packageName === entry.p && !expanded.has(entry.p)) {
        expanded.add(entry.p);
        cursor.expanded.push(entry.p);
        if (ingest(detail.similarApps)) return "target";
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
    let pullsWithoutSearch = 0;
    const enrichFlight = new Set<string>();
    const pullSearchTask = (): Promise<TaskOutcome> | null => {
      // Queued verifications come first: that detail page is the only gate
      // before a lead may appear, so a match found this very window reaches
      // the table as soon as it is confirmed — and never before. On transient
      // failures the package stays queued for the next step, so a null return
      // here just falls through to the queues below.
      //
      // Exception: once three pulls in a row went to verify/enrich/expand,
      // the plan gets the next slot while it still has queries left.
      // Measured in production: without that reserve a fresh run spent its
      // whole first minute on detail fetches — the query counter sat at 37
      // while 866 pages were fetched — which delays the niche queries that
      // produce most matches, and with them the first lead.
      const planRemains = entryAt(queries, cursor.planIndex, filters.country) !== null;
      if (pullsWithoutSearch < 3 || !planRemains) {
        const verify = pullVerifyTask();
        if (verify) {
          pullsWithoutSearch += 1;
          return verify;
        }

        // Then backfill metadata for leads already on screen (their ratings
        // count, if the detail page carried none at verification time).
        if (enrichRequests + enrichFlight.size < MAX_ENRICH_PER_STEP) {
          for (const pkg of cursor.enrichQueue) {
            if (enrichFlight.has(pkg)) continue;
            enrichFlight.add(pkg);
            pullsWithoutSearch += 1;
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
            pullsWithoutSearch += 1;
            return runExpandTask(seed);
          }
          expandCredit = 0;
        }
      }

      const seedsAvailable =
        cursor.similarQueue.length > 0 && expandRequests < MAX_EXPAND_REQUESTS;
      const entry = planRemains ? entryAt(queries, cursor.planIndex, filters.country) : null;
      if (!entry) {
        if (!seedsAvailable) return null;
        const [seed] = takeSeeds(1);
        if (!seed) return null;
        pullsWithoutSearch += 1;
        return runExpandTask(seed);
      }
      cursor.planIndex += 1;
      pullsWithoutSearch = 0;
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
    if (cursor.planIndex >= totalPlan || entryAt(queries, cursor.planIndex, filters.country) === null) {
      // The plan ran out before the lead limit: keep generating. Each wave
      // appends a fresh deterministic batch of long-tail queries (appended
      // only, so `planIndex` stays valid). A wave that finds no new app means
      // the reachable supply under these ceilings is genuinely exhausted —
      // then (and only then) the search phase ends honestly.
      if (cursor.wave < MAX_WAVES && cursor.counters.discovered > cursor.waveDiscovered) {
        cursor.wave += 1;
        cursor.waveDiscovered = cursor.counters.discovered;
        queries = buildPlanQueries(cursor.keyword, suggestions, cursor.wave, cursor.secondary);
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
        const verify = pullVerifyTask();
        if (verify) return verify;
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
    if (cursor.counters.matched >= filters.limit) break;

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
  if (cursor.counters.matched >= filters.limit) {
    return finish(
      "target-reached",
      `Found ${cursor.counters.matched} matching leads for “${filters.keyword}”.`,
      false,
    );
  }

  // A terminal decision with candidates still pending would silently discard
  // leads the run already spent searches on, so report back and let the next
  // step (or the dashboard's auto-resume) drain the queues first.
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
