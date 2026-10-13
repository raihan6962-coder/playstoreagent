/**
 * Harvest pool: the collected-but-unfiltered apps of ONE keyword cycle.
 *
 * The pool used to live inside the persisted cursor (`tempCandidates`). That
 * was fine at a 100-card cap and untenable at the real harvest floor: a
 * keyword now collects {@link HARVEST_TARGET} (1000) cards before any of them
 * is filtered, so the pool is hundreds of KB of JSON — it would be rewritten
 * on every checkpoint (every 10s) and, on the legacy GitHub backend, written
 * as one blob per commit. It now lives in its own store file so:
 *
 *  - the cursor stays small enough to round-trip through the browser on every
 *    resume (it only carries the pool's *progress*, not its contents),
 *  - the collected apps survive a rate limit, a cold start, or an instance
 *    death mid-harvest instead of being lost with the tick,
 *  - the "collect 1000 → filter" shape is visible in storage: the file is the
 *    cycle's inbox, the leads file is the outbox.
 *
 * Single-writer, exactly like the state file: the tick that holds the lease
 * owns the pool for the duration of its step. There is no in-memory copy
 * shared across steps — a resumed step reads the file back.
 */

import { MAX_TEMP_CANDIDATES } from "./queryPlan";
import type { TempCandidate } from "@/types/lead";

/**
 * Longest card summary kept per pooled app. The filter stage needs the card's
 * own text for the keyword verdict, and a Play search card carries the
 * listing's full description — but clipping keeps 1000 pooled cards to a
 * predictable file size. 600 chars is comfortably past the ~300-char mark
 * where a card text stops being a stub (see CARD_TEXT_STUB_LENGTH in
 * crawler.ts), so the relevance verdict is unchanged.
 */
const POOL_SUMMARY_CAP = 600;

/** One pool entry as persisted — the card fields plus nothing else. */
export type PoolCard = TempCandidate;

/**
 * The persisted shape. `keywordIndex`/`keyword` bind the pool to the cycle
 * that filled it: a pool left over from a previous cycle (or a run whose
 * cursor moved on) is discarded rather than filtered into the wrong keyword's
 * leads, because its relevance verdicts would be judged against the wrong
 * keyword.
 */
export interface HarvestPool {
  /** Index of the keyword cycle whose cards this pool holds. */
  keywordIndex: number;
  /** The keyword that cycle is harvesting (guard against a mismatched resume). */
  keyword: string;
  /** Total cards ever stashed into this cycle's pool (monotonic). */
  collected: number;
  cards: PoolCard[];
}

export function emptyPool(keyword: string, keywordIndex: number): HarvestPool {
  return { keywordIndex, keyword, collected: 0, cards: [] };
}

function clipCard(card: PoolCard): PoolCard {
  const summary =
    card.s !== null && card.s.length > POOL_SUMMARY_CAP
      ? card.s.slice(0, POOL_SUMMARY_CAP)
      : card.s;
  return { ...card, s: summary };
}

/**
 * Reads a stored pool defensively: anything malformed becomes an empty pool
 * rather than a crash, because the pool is recomputable working state (its
 * searches simply re-run). A pool bound to a different keyword cycle is
 * dropped for the same reason it would be wasteful to keep: its cards were
 * harvested for a different relevance verdict.
 */
export function parsePool(value: unknown, keyword: string, keywordIndex: number): HarvestPool {
  const base = emptyPool(keyword, keywordIndex);
  if (typeof value !== "object" || value === null || Array.isArray(value)) return base;
  const record = value as Record<string, unknown>;
  if (record.keyword !== keyword) return base;
  if (record.keywordIndex !== keywordIndex) return base;

  const collected =
    typeof record.collected === "number" && Number.isFinite(record.collected)
      ? Math.floor(record.collected)
      : 0;
  if (!Array.isArray(record.cards)) return { ...base, collected };

  const cards: PoolCard[] = [];
  for (const item of record.cards.slice(0, MAX_TEMP_CANDIDATES)) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
    const card = item as Record<string, unknown>;
    if (typeof card.p !== "string" || card.p.length === 0) continue;
    if (typeof card.t !== "string") continue;
    const str = (field: unknown): string | null => (typeof field === "string" ? field : null);
    const num = (field: unknown): number | null =>
      typeof field === "number" && Number.isFinite(field) ? field : null;
    cards.push(
      clipCard({
        p: card.p,
        t: card.t,
        d: str(card.d),
        r: num(card.r),
        rr: str(card.rr),
        i: num(card.i),
        ir: str(card.ir),
        c: str(card.c),
        s: str(card.s),
        gl: typeof card.gl === "string" && card.gl.length === 2 ? card.gl.toUpperCase() : "US",
      }),
    );
  }
  return { keywordIndex, keyword, collected: Math.max(collected, cards.length), cards };
}

/** Clips and bounds a card before it enters the pool. */
export function toPoolCard(card: PoolCard): PoolCard {
  return clipCard(card);
}