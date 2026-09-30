import type { QueryPlanEntry, SessionCursor, SimilarSeed } from "@/types/lead";

const PHASES = new Set(["search", "expand", "enrich", "done"]);
const KINDS = new Set(["primary", "suggestion", "variant", "token", "modifier", "locale", "price"]);
const PRICES = new Set(["free", "paid"]);

const MAX_PLAN = 64;
const MAX_SEEN = 5_000;
const MAX_QUEUE = 400;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asStringArray(value: unknown, cap: number): string[] | null {
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const item of value.slice(0, cap)) {
    if (typeof item !== "string") return null;
    out.push(item);
  }
  return out;
}

function parsePlan(value: unknown): QueryPlanEntry[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_PLAN) return null;
  const plan: QueryPlanEntry[] = [];
  for (const item of value) {
    if (!isRecord(item)) return null;
    if (typeof item.query !== "string" || item.query.length === 0) return null;
    if (typeof item.hl !== "string" || typeof item.gl !== "string") return null;
    if (typeof item.kind !== "string" || !KINDS.has(item.kind)) return null;
    const price = item.price;
    if (price !== undefined && (typeof price !== "string" || !PRICES.has(price))) return null;
    plan.push({
      query: item.query,
      hl: item.hl,
      gl: item.gl,
      kind: item.kind as QueryPlanEntry["kind"],
      ...(price ? { price: price as QueryPlanEntry["price"] } : {}),
    });
  }
  return plan;
}

function parseSeeds(value: unknown): SimilarSeed[] | null {
  if (!Array.isArray(value) || value.length > MAX_QUEUE) return null;
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

  const plan = parsePlan(input.plan);
  if (!plan) return null;

  const planIndex =
    typeof input.planIndex === "number" && Number.isInteger(input.planIndex)
      ? input.planIndex
      : -1;
  if (planIndex < 0 || planIndex > plan.length) return null;

  const seen = asStringArray(input.seen, MAX_SEEN);
  const expanded = asStringArray(input.expanded, MAX_QUEUE);
  const enrichQueue = asStringArray(input.enrichQueue, MAX_QUEUE);
  const similarQueue = parseSeeds(input.similarQueue);
  const counters = parseCounters(input.counters);
  if (!seen || !expanded || !enrichQueue || !similarQueue || !counters) return null;
  if (counters.matched < 0) return null;

  return {
    keyword,
    plan,
    planIndex,
    phase: input.phase as SessionCursor["phase"],
    seen,
    similarQueue,
    expanded,
    enrichQueue,
    counters,
  };
}
