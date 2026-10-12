import { MAX_CONSECUTIVE_DRY_ROUNDS, MAX_SECONDARY_ROUNDS } from "@/lib/keywords/secondary";
import {
  buildPlanQueries,
  legacyWaveTail,
  MAX_CYCLE_QUERIES,
  MAX_EXTRA_TAIL,
  MAX_KEYWORDS,
  MAX_STAGNANT_QUERIES,
  MAX_SUGGESTION_QUERIES,
  MAX_WAVES,
  planSize,
  suggestPrefixes,
} from "@/lib/playstore/queryPlan";
import type {
  PendingVerify,
  PlanQuery,
  SessionCursor,
  SimilarSeed,
  TempCandidate,
} from "@/types/lead";

const PHASES = new Set(["suggest", "collect", "filter", "enrich", "done"]);
/**
 * Stages renamed since: cursors minted by the old code resume in the matching
 * new stage. Their saved planIndex is validated against the old plan shape
 * below (unchanged); the crawler clamps it to the current cycle's plan at
 * step start, since unsearched tail queries are superseded by the new cycles.
 */
const LEGACY_PHASES: Record<string, SessionCursor["phase"]> = {
  search: "collect",
  expand: "filter",
};
const QUERY_KINDS = new Set([
  "primary",
  "suggestion",
  "variant",
  "token",
  "modifier",
  "locale",
  "price",
]);

const MAX_SUGGESTION_LENGTH = 80;
/** Tail entries may combine a keyword with two modifiers — longer than a bare suggestion. */
const MAX_TAIL_QUERY_LENGTH = 160;
const MAX_SEEN = 40_000;
const MAX_TEMP_POOL = 400;
const MAX_TEMP_SUMMARY = 1_000;
const MAX_CYCLE_SEEN = 10_000;
const MAX_EMITTED = 1_000;
const MAX_SIMILAR_QUEUE = 2_000;
const MAX_EXPANDED = 8_000;
const MAX_ENRICH_QUEUE = 1_000;
const MAX_PENDING = 1_000;
const MAX_CANDIDATES = 2_500;
const MAX_PENDING_SUMMARY = 1_000;
const MAX_SECONDARY = 100;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asStringArray(value: unknown, cap: number, itemCap = 0): string[] | null {
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const item of value.slice(0, cap)) {
    if (typeof item !== "string") return null;
    if (itemCap > 0 && item.length > itemCap) return null;
    out.push(item);
  }
  return out;
}

function asIndex(value: unknown, max: number): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) return null;
  return value <= max ? value : null;
}

function parseSeeds(value: unknown): SimilarSeed[] | null {
  if (!Array.isArray(value) || value.length > MAX_SIMILAR_QUEUE) return null;
  const out: SimilarSeed[] = [];
  for (const item of value) {
    if (!isRecord(item)) return null;
    if (typeof item.p !== "string" || item.p.length === 0) return null;
    const installs = item.i;
    if (installs !== null && typeof installs !== "number") return null;
    out.push({ p: item.p, i: typeof installs === "number" ? installs : null });
  }
  return out;
}

/**
 * Candidates waiting for their country's detail page. Optional so cursors
 * minted before this field existed still resume (they simply have nothing
 * pending). An over-long summary is clipped rather than rejected: the text is
 * only a fallback for unreadable detail pages, and throwing the whole cursor
 * away over it would silently restart the session from scratch.
 */
function parsePending(value: unknown, cap: number): PendingVerify[] | null {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return null;
  // An oversized queue trims its tail instead of rejecting the cursor: a cap
  // mismatch between the crawler that wrote it and the parser that reads it
  // must never silently restart the session (dropping the oldest overflow
  // entries only costs a few later verifies).
  const items = value.length > cap ? value.slice(0, cap) : value;
  const out: PendingVerify[] = [];
  for (const item of items) {
    if (!isRecord(item)) return null;
    if (typeof item.p !== "string" || item.p.length === 0) return null;
    const installs = item.i;
    if (installs !== undefined && installs !== null && typeof installs !== "number") return null;
    const summary = item.s;
    if (summary !== undefined && summary !== null && typeof summary !== "string") return null;
    const origin = item.o;
    const reason = item.q;
    out.push({
      p: item.p,
      i: typeof installs === "number" ? installs : null,
      s:
        typeof summary === "string"
          ? summary.length > MAX_PENDING_SUMMARY
            ? summary.slice(0, MAX_PENDING_SUMMARY)
            : summary
          : null,
      ...(item.h === true ? { h: true } : {}),
      ...(origin === "hr" || origin === "hu" || origin === "f" ? { o: origin } : {}),
      ...(reason === "m" || reason === "n" || reason === "p" || reason === "r" ? { q: reason } : {}),
      ...(item.v === true ? { v: true } : {}),
    });
  }
  return out;
}

/**
 * The active cycle's temporary harvest pool. Self-healing instead of strict:
 * the pool is recomputable working state (its searches simply re-run), so a
 * malformed entry is dropped while the rest of the cursor survives — the
 * opposite of the verify queues, where a dropped entry would lose a lead the
 * run already spent requests on.
 */
function parseTempCandidates(value: unknown): TempCandidate[] {
  if (!Array.isArray(value)) return [];
  const out: TempCandidate[] = [];
  for (const item of value.slice(0, MAX_TEMP_POOL)) {
    if (!isRecord(item)) continue;
    if (typeof item.p !== "string" || item.p.length === 0) continue;
    if (typeof item.t !== "string") continue;
    const opt = (field: unknown): string | null =>
      typeof field === "string" ? field : null;
    const num = (field: unknown): number | null =>
      typeof field === "number" && Number.isFinite(field) ? field : null;
    if (
      (item.d !== undefined && item.d !== null && typeof item.d !== "string") ||
      (item.rr !== undefined && item.rr !== null && typeof item.rr !== "string") ||
      (item.ir !== undefined && item.ir !== null && typeof item.ir !== "string") ||
      (item.c !== undefined && item.c !== null && typeof item.c !== "string")
    ) {
      continue;
    }
    if (
      (item.r !== undefined && item.r !== null && num(item.r) === null) ||
      (item.i !== undefined && item.i !== null && num(item.i) === null)
    ) {
      continue;
    }
    const summary = opt(item.s);
    out.push({
      p: item.p,
      t: item.t,
      d: opt(item.d),
      r: num(item.r),
      rr: opt(item.rr),
      i: num(item.i),
      ir: opt(item.ir),
      c: opt(item.c),
      s:
        summary !== null && summary.length > MAX_TEMP_SUMMARY
          ? summary.slice(0, MAX_TEMP_SUMMARY)
          : summary,
      gl: typeof item.gl === "string" && item.gl.length === 2 ? item.gl.toUpperCase() : "US",
    });
  }
  return out;
}

function parseCounters(value: unknown): SessionCursor["counters"] | null {  if (!isRecord(value)) return null;
  const numeric = [
    "discovered",
    "evaluated",
    "matched",
    "duplicates",
    "queriesRun",
    "pagesFetched",
    "requests",
  ] as const;
  const counters = { ...value } as unknown as SessionCursor["counters"];
  for (const key of numeric) {
    const current = counters[key];
    if (typeof current !== "number" || !Number.isFinite(current) || current < 0) return null;
    counters[key] = Math.floor(current);
  }
  const lowest = counters.lowestRatingSeen;
  if (lowest !== null && (typeof lowest !== "number" || !Number.isFinite(lowest))) return null;
  // Optional so cursors minted before this counter existed still resume.
  const hits = (value as Record<string, unknown>).rateLimitHits;
  if (hits === undefined || hits === null) counters.rateLimitHits = 0;
  else if (typeof hits !== "number" || !Number.isFinite(hits) || hits < 0) return null;
  else counters.rateLimitHits = Math.floor(hits);
  // Same for the verification diagnostics.
  const optional = [
    "candidates",
    "verifyRejected",
    "verifyTextRejected",
    "verifyCeilingRejected",
    "homeDiscovered",
    "homeQueued",
    "homePending",
    "verifyCeilingRating",
    "verifyCeilingInstalls",
    "verifyCeilingMissing",
    "verifyFromPending",
    "verifyFromCandidate",
    "leadFromPending",
    "leadFromCandidate",
    "leadHomeUnrated",
    "leadHomeOther",
    "leadForeign",
    "rejectHomeUnrated",
    "rejectHomeOther",
    "rejectForeign",
    "rejectTextCardBad",
    "rejectTextCardGood",
    "cycles",
    "collected",
    "filtered",
    "cardDropRating",
    "cardDropInstalls",
    "cardDropIrrelevant",
  ] as const;
  for (const key of optional) {
    const current = (value as Record<string, unknown>)[key];
    if (current === undefined || current === null) counters[key] = 0;
    else if (typeof current !== "number" || !Number.isFinite(current) || current < 0) return null;
    else counters[key] = Math.floor(current);
  }
  return counters;
}

/**
 * Validates a client-supplied resume cursor. Anything malformed is discarded
 * so the session restarts from scratch instead of producing corrupt results.
 */
export function sanitizeCursor(input: unknown, keyword: string): SessionCursor | null {
  if (!isRecord(input)) return null;
  if (input.keyword !== keyword) return null;
  if (typeof input.phase !== "string") return null;
  const phase = PHASES.has(input.phase)
    ? (input.phase as SessionCursor["phase"])
    : LEGACY_PHASES[input.phase] ?? null;
  if (phase === null || phase === "done") return null;

  const suggestions = asStringArray(input.suggestions, MAX_SUGGESTION_QUERIES, MAX_SUGGESTION_LENGTH);
  if (!suggestions) return null;

  // Waves appended so far. Optional so cursors minted before this field
  // existed still resume (they resume at wave 0 = the base plan).
  const wave = input.wave === undefined || input.wave === null
    ? 0
    : asIndex(input.wave, MAX_WAVES);
  if (wave === null) return null;
  const waveDiscoveredRaw = input.waveDiscovered;
  const waveDiscovered = waveDiscoveredRaw === undefined || waveDiscoveredRaw === null
    ? 0
    : asIndex(waveDiscoveredRaw, Number.MAX_SAFE_INTEGER);
  if (waveDiscovered === null) return null;

  // AI-generated secondary phrases. Optional so cursors minted before this
  // field existed still resume (they generate them on the next step).
  // Strict when present, like suggestions: a malformed list would corrupt the
  // rebuilt plan, so the cursor restarts instead.
  const secondaryRaw = input.secondary;
  const secondary = secondaryRaw === undefined || secondaryRaw === null
    ? []
    : asStringArray(secondaryRaw, MAX_SECONDARY, MAX_SUGGESTION_LENGTH);
  if (!secondary) return null;
  const secondaryTried = input.secondaryTried === true;

  // Generation rounds attempted so far. Optional so older cursors resume
  // (they start counting from zero on the next plan-dry extension).
  const secondaryRoundsRaw = input.secondaryRounds;
  const secondaryRounds =
    secondaryRoundsRaw === undefined || secondaryRoundsRaw === null
      ? 0
      : asIndex(secondaryRoundsRaw, MAX_SECONDARY_ROUNDS);
  if (secondaryRounds === null) return null;

  // Consecutive dry generation rounds: optional for older cursors, clamped
  // to the policy cap — a value above the cap already means "stop asking the
  // model", so clamping preserves that intent instead of restarting the run.
  const dryRoundsRaw = input.dryRounds;
  let dryRounds = 0;
  if (dryRoundsRaw !== undefined && dryRoundsRaw !== null) {
    if (typeof dryRoundsRaw !== "number" || !Number.isFinite(dryRoundsRaw)) return null;
    dryRounds = Math.min(Math.max(0, Math.floor(dryRoundsRaw)), MAX_CONSECUTIVE_DRY_ROUNDS);
  }

  // Append-only plan tail (post-search AI rounds + wave slices). Older
  // cursors stored waves only as a count and derived them at rebuild time —
  // replay that derivation once so their plan (and planIndex) stays identical.
  const extraTailRaw = input.extraTail;
  let extraTail: PlanQuery[];
  if (extraTailRaw === undefined || extraTailRaw === null) {
    extraTail = legacyWaveTail(keyword, suggestions, secondary, wave);
  } else {
    if (!Array.isArray(extraTailRaw)) return null;
    extraTail = [];
    for (const item of extraTailRaw.slice(0, MAX_EXTRA_TAIL)) {
      if (!isRecord(item)) return null;
      if (typeof item.query !== "string") return null;
      const query = item.query;
      if (query.length === 0 || query.length > MAX_TAIL_QUERY_LENGTH) return null;
      if (typeof item.kind !== "string" || !QUERY_KINDS.has(item.kind)) return null;
      extraTail.push({ query, kind: item.kind as PlanQuery["kind"] });
    }
  }

  const queries = buildPlanQueries(keyword, suggestions, secondary, extraTail);
  const total = planSize(queries);

  const suggestIndex = asIndex(input.suggestIndex, suggestPrefixes(keyword).length);
  // Strict: the tail is capped at push time, so a saved planIndex past the
  // rebuilt plan can only mean a tampered or corrupted cursor — restart it.
  // (Validated against the run-global plan shape, which the crawler narrows
  // to the active cycle's plan at step start.)
  const planIndex = asIndex(input.planIndex, total);
  if (suggestIndex === null || planIndex === null) return null;

  // Keyword queue: optional so cursors minted before cycles existed resume on
  // the main keyword. Strict when present — the queue drives every query, so
  // a malformed one restarts the run instead of searching garbage.
  const keywordsRaw = input.keywords;
  const keywords =
    keywordsRaw === undefined || keywordsRaw === null
      ? [keyword]
      : asStringArray(keywordsRaw, MAX_KEYWORDS, MAX_SUGGESTION_LENGTH);
  if (!keywords || keywords.length === 0) return null;
  const keywordIndexRaw = input.keywordIndex;
  const keywordIndex =
    keywordIndexRaw === undefined || keywordIndexRaw === null
      ? 0
      : asIndex(keywordIndexRaw, keywords.length - 1);
  if (keywordIndex === null) return null;

  // Temporary harvest pool + per-cycle dedupe set: self-healing (see
  // parseTempCandidates) — worst case the active cycle re-collects.
  const tempCandidates = parseTempCandidates(input.tempCandidates);
  const cycleSeen = asStringArray(input.cycleSeen, MAX_CYCLE_SEEN) ?? [];
  const cycleQueriesRaw = input.cycleQueries;
  const cycleQueries =
    cycleQueriesRaw === undefined || cycleQueriesRaw === null
      ? 0
      : asIndex(cycleQueriesRaw, MAX_CYCLE_QUERIES);
  if (cycleQueries === null) return null;
  const stagnantRaw = input.stagnantQueries;
  const stagnantQueries =
    stagnantRaw === undefined || stagnantRaw === null
      ? 0
      : asIndex(stagnantRaw, MAX_STAGNANT_QUERIES);
  if (stagnantQueries === null) return null;

  const seen = asStringArray(input.seen, MAX_SEEN);
  const emitted = asStringArray(input.emitted, MAX_EMITTED);
  const expanded = asStringArray(input.expanded, MAX_EXPANDED);
  const enrichQueue = asStringArray(input.enrichQueue, MAX_ENRICH_QUEUE);
  const pendingQueue = parsePending(input.pendingQueue, MAX_PENDING);
  const candidateQueue = parsePending(input.candidateQueue, MAX_CANDIDATES);
  const similarQueue = parseSeeds(input.similarQueue);
  const counters = parseCounters(input.counters);
  if (!seen || !emitted || !expanded || !enrichQueue || !pendingQueue || !candidateQueue || !similarQueue || !counters) {
    return null;
  }
  if (counters.matched < 0) return null;

  return {
    keyword,
    suggestions,
    suggestIndex,
    planIndex,
    keywords,
    keywordIndex,
    tempCandidates,
    cycleSeen,
    cycleQueries,
    stagnantQueries,
    wave,
    waveDiscovered,
    phase,
    seen,
    emitted,
    similarQueue,
    expanded,
    enrichQueue,
    pendingQueue,
    candidateQueue,
    secondary,
    secondaryTried,
    extraTail,
    secondaryRounds,
    dryRounds,
    counters,
  };
}
