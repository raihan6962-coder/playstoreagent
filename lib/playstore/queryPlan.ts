import { tokenizeKeyword } from "@/lib/filters/relevance";
import { keywordVariants } from "@/lib/playstore/keywords";
import type { PlanQuery, PriceFilter, QueryKind, QueryPlanEntry } from "@/types/lead";

export type { PlanQuery };

/** Cap on the legacy single-locale plan helpers. */
export const MAX_PLAN_SIZE = 48;
/** Cap on Play-sourced suggestion queries carried in the cursor. */
export const MAX_SUGGESTION_QUERIES = 400;
/**
 * Extra query waves appended when the base plan runs out of targets. Each wave
 * adds this many long-tail queries (× the core storefronts in requests); the
 * session stops early if a wave finds nothing new, otherwise it keeps going up
 * to {@link MAX_WAVES} so the run continues until the lead limit or real
 * supply exhaustion.
 */
export const WAVE_QUERIES_PER_WAVE = 120;
export const MAX_WAVES = 16;
/**
 * Cap on the append-only plan tail (AI related-keyword rounds + wave slices,
 * in the order they were generated). The tail is the only part of the plan
 * that grows after a session starts searching — everything before it is fixed
 * while `planIndex > 0`, which is what keeps that index valid: growth at the
 * end only ever extends the plan, never shifts already-searched entries.
 * Sized for 16 waves × 120 + 5 keyword rounds × 100 phrases with headroom.
 */
export const MAX_EXTRA_TAIL = 3_000;

const VARIANT_SUFFIXES = [
  "app",
  "for android",
  "free",
  "offline",
  "best",
  "new",
  "tracker",
  "software",
];

/**
 * Domain-agnostic modifiers. Long-tail queries surface the smaller, newer and
 * lower rated apps that head-term searches never rank, which is exactly what a
 * "max rating / max installs" lead search needs.
 */
const TAIL_MODIFIERS = [
  "old",
  "lite",
  "mini",
  "beta",
  "test",
  "demo",
  "simple",
  "basic",
  "open source",
  "no ads",
  "small",
  "local",
];

const LOCALES: Array<{ hl: string; gl: string }> = [
  { hl: "en", gl: "GB" },
  { hl: "es", gl: "MX" },
  { hl: "pt", gl: "BR" },
  { hl: "id", gl: "ID" },
  { hl: "de", gl: "DE" },
  { hl: "hi", gl: "IN" },
];

/**
 * Storefronts the cross-product plan sweeps. Every entry is one Play search
 * request when combined with a query. Measured (see research.test.ts): the
 * same query returns largely *different* app sets per storefront, so countries
 * multiply unique discovery instead of repeating it.
 */
export interface PlanLocale {
  hl: string;
  gl: string;
  price?: PriceFilter;
}

const SWEEP_COUNTRIES = [
  "US",
  "GB",
  "CA",
  "AU",
  "IN",
  "PK",
  "BD",
  "ID",
  "PH",
  "VN",
  "TH",
  "BR",
  "MX",
  "CO",
  "NG",
  "KE",
  "ZA",
  "TR",
  "DE",
  "FR",
  "ES",
  "IT",
  "PL",
  "JP",
  "KR",
  "AR",
];

const LANGUAGE_STOREFRONTS: Array<{ hl: string; gl: string }> = [
  { hl: "es", gl: "MX" },
  { hl: "pt", gl: "BR" },
  { hl: "de", gl: "DE" },
  { hl: "hi", gl: "IN" },
  // Measured (research R7): the Bengali home storefront returns a largely
  // different card set than the English one for the same query (22 of 91
  // cards unique), including apps the English sweep never surfaces — and
  // home cards verify at 100% (R6b), so the extra slot pays for itself.
  { hl: "bn", gl: "BD" },
  { hl: "id", gl: "ID" },
  { hl: "fr", gl: "FR" },
  { hl: "ja", gl: "JP" },
  { hl: "ru", gl: "RU" },
  { hl: "ar", gl: "EG" },
  { hl: "th", gl: "TH" },
  { hl: "vi", gl: "VN" },
  { hl: "tr", gl: "TR" },
  { hl: "it", gl: "IT" },
  { hl: "nl", gl: "NL" },
  { hl: "pl", gl: "PL" },
  { hl: "ko", gl: "KR" },
  { hl: "zh-TW", gl: "TW" },
  { hl: "sv", gl: "SE" },
];

/**
 * Storefronts swept for the two head queries (the keyword itself and its
 * quoted form): the widest coverage we buy. Measured (research2.test.ts R6):
 * the en-countries mostly overlap, so later queries use {@link CORE_LOCALES}.
 */
export const PLAN_LOCALES: PlanLocale[] = [
  ...SWEEP_COUNTRIES.map((gl) => ({ hl: "en", gl })),
  { hl: "en", gl: "US", price: "free" },
  { hl: "en", gl: "US", price: "paid" },
  ...LANGUAGE_STOREFRONTS,
];

/**
 * Storefronts swept for every query after the head ones. Trimmed from the
 * original dozen en-country list: measured (research2.test.ts R6) the
 * en-countries mostly return the same apps, so every extra one delays the
 * *next* query — and at a strict rating ceiling the head-page results carry
 * almost no qualifying cards, so covering more distinct queries beats
 * re-covering the same apps in one more country (a live probe found zero
 * cards at or below 3.5 stars in the first 25 results of a head query on both
 * the BD and KR storefronts). The non-English storefronts stay: measured
 * (research R7) they surface genuinely unique card sets.
 */
export const CORE_LOCALES: PlanLocale[] = [
  ...["US", "GB", "IN", "PK", "ID", "NG"].map((gl) => ({ hl: "en", gl })),
  { hl: "en", gl: "US", price: "paid" },
  { hl: "es", gl: "MX" },
  { hl: "pt", gl: "BR" },
  { hl: "de", gl: "DE" },
  { hl: "hi", gl: "IN" },
  { hl: "bn", gl: "BD" },
  { hl: "id", gl: "ID" },
  { hl: "fr", gl: "FR" },
  { hl: "ja", gl: "JP" },
  { hl: "ar", gl: "EG" },
  { hl: "tr", gl: "TR" },
];

/** Head queries that receive the full storefront sweep. */
const FULL_SWEEP_QUERIES = 2;

function storefrontCount(queryCount: number): number {
  const head = Math.min(queryCount, FULL_SWEEP_QUERIES);
  return head * PLAN_LOCALES.length + Math.max(0, queryCount - head) * CORE_LOCALES.length;
}

function entry(
  query: string,
  kind: QueryKind,
  locale: { hl: string; gl: string } = { hl: "en", gl: "US" },
  price?: PriceFilter,
): QueryPlanEntry {
  return { query, hl: locale.hl, gl: locale.gl, kind, ...(price ? { price } : {}) };
}

export function planKey(item: QueryPlanEntry): string {
  return `${item.query.toLowerCase()}|${item.hl}|${item.gl}|${item.price ?? "all"}`;
}

export function dedupePlan(plan: QueryPlanEntry[], limit = MAX_PLAN_SIZE): QueryPlanEntry[] {
  const seen = new Set<string>();
  const output: QueryPlanEntry[] = [];
  for (const item of plan) {
    const key = planKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(item);
    if (output.length >= limit) break;
  }
  return output;
}

/** Deterministic queries used when the suggest endpoint is unavailable. */
function baseQuerySpecs(keyword: string): PlanQuery[] {
  const tokens = tokenizeKeyword(keyword);
  const specs: PlanQuery[] = [];

  specs.push({ query: keyword, kind: "primary" });
  specs.push({ query: `"${keyword}"`, kind: "primary" });

  for (const token of tokens.significant.slice(0, 4)) {
    specs.push({ query: token, kind: "token" });
  }

  if (tokens.significant.length > 1) {
    specs.push({ query: [...tokens.significant].reverse().join(" "), kind: "variant" });
  }

  for (const suffix of VARIANT_SUFFIXES) {
    specs.push({ query: `${keyword} ${suffix}`, kind: "variant" });
  }

  for (const modifier of TAIL_MODIFIERS) {
    specs.push({ query: `${keyword} ${modifier}`, kind: "modifier" });
  }

  // Long tails built from a single keyword word: they surface the small,
  // low rated apps that head-term searches never rank, and they keep the plan
  // productive even when Play's suggest endpoint is unreachable.
  for (const token of tokens.significant.slice(0, 4)) {
    for (const suffix of VARIANT_SUFFIXES) {
      specs.push({ query: `${token} ${suffix}`, kind: "variant" });
    }
    for (const modifier of TAIL_MODIFIERS) {
      specs.push({ query: `${token} ${modifier}`, kind: "modifier" });
    }
  }

  return specs;
}

/**
 * A suggestion only earns a slot when it still mentions every significant
 * keyword token: long-tail queries that drop the keyword waste requests
 * against results the relevance filter would reject anyway.
 */
export function keepsKeyword(keyword: string, suggestion: string): boolean {
  const tokens = tokenizeKeyword(keyword);
  const haystack = suggestion.toLowerCase();
  if (tokens.significant.length === 0) return false;
  return tokens.significant.every((token) => haystack.includes(token));
}

/**
 * Ordered query list: deterministic base queries first, then the locally
 * generated topic-consistent variants (every one embeds the full keyword),
 * then the AI-generated secondary phrases of the first round, then Play
 * suggestions appended in discovery order, and finally the session's append
 * tail — AI related-keyword rounds and deterministic wave slices, in the order
 * they were generated (see {@link MAX_EXTRA_TAIL}).
 *
 * Appending is what makes `planIndex` stable: entries before the tail never
 * move, and the tail only grows at its end, so a cursor that has consumed N
 * requests keeps pointing at the right query no matter how many rounds or
 * waves arrive later.
 */
export function buildPlanQueries(
  keyword: string,
  suggestions: string[] = [],
  secondary: string[] = [],
  extraTail: PlanQuery[] = [],
): PlanQuery[] {
  const { out, seen } = buildHead(keyword, suggestions, secondary);

  // The append-only tail: AI phrases and wave slices pushed chronologically.
  // Deduped against everything earlier (and within the tail itself) but
  // otherwise taken as-is — no keyword-contains filter, because a secondary
  // phrase deliberately is a different way into the same neighbourhood.
  for (const spec of extraTail) {
    const key = spec.query.trim().toLowerCase();
    if (key.length === 0 || seen.has(key)) continue;
    seen.add(key);
    out.push({ query: spec.query.trim(), kind: spec.kind });
  }

  return out;
}

/**
 * Base + variants + round-one secondary + Play suggestions, with the dedupe
 * set they were built against. Shared by {@link buildPlanQueries} and the
 * legacy wave migration so both replay the exact historic order.
 */
function buildHead(
  keyword: string,
  suggestions: string[],
  secondary: string[],
): { out: PlanQuery[]; seen: Set<string> } {
  const base = baseQuerySpecs(keyword);
  const out: PlanQuery[] = [...base];
  const seen = new Set(out.map((item) => item.query.toLowerCase()));

  for (const variant of keywordVariants(keyword)) {
    const key = variant.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ query: variant, kind: "variant" });
  }

  const budget = out.length + MAX_SUGGESTION_QUERIES;

  // Secondary phrases run right after the deterministic main-keyword block
  // and before the Play suggestions: both are main-keyword-derived, but the
  // AI phrases are the ones that surface a different neighbourhood, and at a
  // strict rating ceiling they must be searched in the first steps instead of
  // waiting behind up to 400 suggestions. Deduped against every earlier query
  // but deliberately not filtered by keepsKeyword — that is the point of a
  // secondary keyword.
  for (const phrase of secondary) {
    const key = phrase.trim().toLowerCase();
    if (key.length === 0 || seen.has(key)) continue;
    seen.add(key);
    out.push({ query: phrase.trim(), kind: "suggestion" });
  }

  for (const suggestion of suggestions) {
    if (out.length >= budget) break;
    const key = suggestion.trim().toLowerCase();
    if (key.length === 0 || seen.has(key)) continue;
    if (!keepsKeyword(keyword, key)) continue;
    seen.add(key);
    out.push({ query: suggestion.trim(), kind: "suggestion" });
  }

  return { out, seen };
}

/**
 * Deterministic long-tail candidates for the wave batches. Distinct from the
 * base plan (suggestion × modifier, keyword × two modifiers, quoted
 * suggestions…) and ordered so every wave covers a fresh slice of the space.
 */
function waveCandidates(keyword: string, suggestions: string[]): PlanQuery[] {
  const tokens = tokenizeKeyword(keyword).significant;
  const specs: PlanQuery[] = [];
  const seen = new Set<string>();
  const push = (query: string, kind: QueryKind): void => {
    const trimmed = query.trim();
    const key = trimmed.toLowerCase();
    if (key.length === 0 || seen.has(key)) return;
    seen.add(key);
    specs.push({ query: trimmed, kind });
  };

  suggestions.forEach((label, index) => {
    push(`${label} ${TAIL_MODIFIERS[index % TAIL_MODIFIERS.length]}`, "modifier");
  });
  for (const label of suggestions) {
    for (const suffix of ["apk", "premium", "pro", "old version", "review"]) {
      push(`${label} ${suffix}`, "modifier");
    }
  }
  for (const first of TAIL_MODIFIERS) {
    for (const second of TAIL_MODIFIERS) {
      push(`${keyword} ${first} ${second}`, "modifier");
    }
  }
  for (const token of tokens.slice(0, 4)) {
    for (const label of suggestions) {
      push(`${token} ${label}`, "variant");
    }
  }
  for (const label of suggestions) {
    push(`"${label}"`, "suggestion");
  }
  return specs;
}

/**
 * The full ordered wave-candidate list. Appendable to a session's plan tail
 * in {@link WAVE_QUERIES_PER_WAVE}-sized slices; duplicates against earlier
 * plan entries are dropped later by {@link buildPlanQueries}.
 */
export function waveCandidatesFor(keyword: string, suggestions: string[]): PlanQuery[] {
  return waveCandidates(keyword, suggestions);
}

/**
 * Fresh wave entries `[from, from + count)` of the same head-skipped kept
 * scan the pre-tail waves used: walk the candidate pool in order, drop
 * anything already in the plan head, count the survivors, keep the requested
 * window. Counting kept entries (not raw pool positions) means every wave
 * delivers `WAVE_QUERIES_PER_WAVE` genuinely new queries, and the window is
 * a pure function of `from` — so a cursor only has to remember its wave
 * number for the next slice to line up with the previous one.
 *
 * `secondary` is part of the head because round-one phrases sit in front of
 * the waves in the plan; slicing against that same head keeps slices
 * disjoint from the head and from each other, which is what lets
 * {@link buildPlanQueries} append them without renumbering anything.
 */
export function waveTailSlice(
  keyword: string,
  suggestions: string[],
  secondary: string[],
  from: number,
  count: number,
): PlanQuery[] {
  if (from < 0 || count <= 0) return [];
  const { seen } = buildHead(keyword, suggestions, secondary);
  const out: PlanQuery[] = [];
  let kept = 0;
  for (const spec of waveCandidates(keyword, suggestions)) {
    const key = spec.query.trim().toLowerCase();
    if (key.length === 0 || seen.has(key)) continue;
    seen.add(key);
    if (kept >= from && kept < from + count) out.push(spec);
    kept += 1;
    if (kept >= from + count) break;
  }
  return out;
}

/**
 * Reproduces the wave block older cursors carried inside their plans (waves
 * used to be derived from `cursor.wave` on every rebuild instead of stored in
 * the tail). It is the kept-scan window `[0, wave × WAVE_QUERIES_PER_WAVE)`,
 * so replaying it yields byte-identical query order and a saved `planIndex`
 * still points at the same request.
 */
export function legacyWaveTail(
  keyword: string,
  suggestions: string[],
  secondary: string[],
  wave: number,
): PlanQuery[] {
  const targetWave = Math.min(wave, MAX_WAVES);
  if (targetWave <= 0) return [];
  return waveTailSlice(
    keyword,
    suggestions,
    secondary,
    0,
    targetWave * WAVE_QUERIES_PER_WAVE,
  );
}

/** Total number of search requests the plan can issue. */
export function planSize(queries: PlanQuery[]): number {
  return storefrontCount(queries.length);
}

/**
 * Rewrites a storefront list so the run's own country is searched **first**
 * while the list keeps exactly the same length (the plan size — and with it
 * every saved cursor's `planIndex` bounds — must not depend on the country).
 *
 * Why this matters: a search card shows the rating of the storefront that
 * answered it. Qualification, however, is verified against the run's own
 * country's detail page (see crawler.ts `runVerifyTask`). Sweeping only
 * foreign storefronts therefore matches cards on ratings the user's Play Store
 * never shows and rejects them at verification — under a strict ceiling the
 * table stays empty while the plan burns queries. Home cards are also worth
 * far more than a foreign one (research R9: home 2 of 2 verified vs foreign
 * 0 of 2 in the top band), and since the cross product walks this list once
 * per query, the front position gives *every* query one home search first.
 *
 * If the country already appears in the list it is moved to the front; if it
 * never appears, it swaps into the last plain-English slot (the language
 * storefronts still cover every language, so no locale is lost wholesale).
 */
function withCountry(locales: PlanLocale[], country: string): PlanLocale[] {
  const target = country.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(target)) return locales;

  const existing = locales.findIndex((item) => item.gl === target && item.hl === "en" && !item.price);
  if (existing === 0) return locales;
  const copy = [...locales];
  if (existing > 0) {
    const [found] = copy.splice(existing, 1);
    copy.unshift(found);
    return copy;
  }

  let slot = -1;
  for (let index = copy.length - 1; index >= 0; index -= 1) {
    const item = copy[index];
    if (item.hl === "en" && !item.price) {
      slot = index;
      break;
    }
  }
  if (slot < 0) return locales;
  copy[slot] = { hl: "en", gl: target };
  const [moved] = copy.splice(slot, 1);
  copy.unshift(moved);
  return copy;
}

const storefrontCache = new Map<string, { head: PlanLocale[]; core: PlanLocale[] }>();

/** Head and core sweeps for a run's country (cached; lengths are stable). */
export function storefrontsFor(country: string): { head: PlanLocale[]; core: PlanLocale[] } {
  const key = (country || "US").trim().toUpperCase();
  const cached = storefrontCache.get(key);
  if (cached) return cached;
  const resolved = { head: withCountry(PLAN_LOCALES, key), core: withCountry(CORE_LOCALES, key) };
  storefrontCache.set(key, resolved);
  return resolved;
}

/** Resolves one index of the query × storefront cross product. */
export function entryAt(
  queries: PlanQuery[],
  index: number,
  country = "US",
): QueryPlanEntry | null {
  if (index < 0 || queries.length === 0) return null;

  const { head, core } = storefrontsFor(country);
  const headBlock = Math.min(queries.length, FULL_SWEEP_QUERIES) * head.length;
  let queryIndex: number;
  let locale: PlanLocale;

  if (index < headBlock) {
    queryIndex = Math.floor(index / head.length);
    locale = head[index % head.length];
  } else {
    const offset = index - headBlock;
    queryIndex = FULL_SWEEP_QUERIES + Math.floor(offset / core.length);
    locale = core[offset % core.length];
  }

  const query = queries[queryIndex];
  if (!query) return null;

  const kind: QueryKind = locale.price
    ? "price"
    : locale.hl !== "en"
      ? "locale"
      : query.kind;
  return entry(query.query, kind, { hl: locale.hl, gl: locale.gl }, locale.price);
}

/**
 * Prefixes fed to Play's suggest endpoint. Each prefix returns ~10 queries, so
 * the 37 prefixes below are what turns a 25-query plan into a ~400-query plan
 * of keyword-preserving long tails.
 */
export function suggestPrefixes(keyword: string): string[] {
  const base = keyword.trim().replace(/\s+/g, " ");
  const out = [base];
  for (const letter of "abcdefghijklmnopqrstuvwxyz") out.push(`${base} ${letter}`);
  for (const digit of "0123456789") out.push(`${base} ${digit}`);
  return out;
}

/** Deterministic plan used when the suggest endpoint is unavailable. */
export function buildBasePlan(keyword: string, cap = MAX_PLAN_SIZE): QueryPlanEntry[] {
  const specs = baseQuerySpecs(keyword);
  // Keep room for the storefront and price entries inside the legacy cap.
  const headroom = Math.max(1, cap - LOCALES.length - 2);
  const plan: QueryPlanEntry[] = specs
    .slice(0, headroom)
    .map((spec) => entry(spec.query, spec.kind));
  for (const locale of LOCALES) {
    plan.push(entry(keyword, "locale", locale));
  }
  plan.push(entry(keyword, "price", { hl: "en", gl: "US" }, "free"));
  plan.push(entry(keyword, "price", { hl: "en", gl: "US" }, "paid"));
  return dedupePlan(plan, cap);
}

export function buildPlan(keyword: string, suggestions: string[] = []): QueryPlanEntry[] {
  const kept = suggestions.filter((suggestion) => keepsKeyword(keyword, suggestion));
  const base = buildBasePlan(keyword, Math.max(1, MAX_PLAN_SIZE - kept.length));
  const plan: QueryPlanEntry[] = [base[0], ...kept.map((label) => entry(label, "suggestion"))];
  plan.push(...base.slice(1));
  return dedupePlan(plan, MAX_PLAN_SIZE);
}
