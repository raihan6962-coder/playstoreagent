import {
  buildPlanQueries,
  MAX_SUGGESTION_QUERIES,
  MAX_WAVES,
  planSize,
  suggestPrefixes,
} from "@/lib/playstore/queryPlan";
import type { PendingVerify, SessionCursor, SimilarSeed } from "@/types/lead";

const PHASES = new Set(["suggest", "search", "expand", "enrich", "done"]);

const MAX_SUGGESTION_LENGTH = 80;
const MAX_SEEN = 40_000;
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
    });
  }
  return out;
}

function parseCounters(value: unknown): SessionCursor["counters"] | null {
  if (!isRecord(value)) return null;
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
  if (typeof input.phase !== "string" || !PHASES.has(input.phase)) return null;
  if (input.phase === "done") return null;

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

  const queries = buildPlanQueries(keyword, suggestions, wave, secondary);
  const total = planSize(queries);

  const suggestIndex = asIndex(input.suggestIndex, suggestPrefixes(keyword).length);
  const planIndex = asIndex(input.planIndex, total);
  if (suggestIndex === null || planIndex === null) return null;

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
    wave,
    waveDiscovered,
    phase: input.phase as SessionCursor["phase"],
    seen,
    emitted,
    similarQueue,
    expanded,
    enrichQueue,
    pendingQueue,
    candidateQueue,
    secondary,
    secondaryTried,
    counters,
  };
}
