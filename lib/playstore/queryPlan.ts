import { tokenizeKeyword } from "@/lib/filters/relevance";
import type { PriceFilter, QueryKind, QueryPlanEntry } from "@/types/lead";

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
export const WAVE_QUERIES_PER_WAVE = 60;
export const MAX_WAVES = 8;

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
 * Storefronts swept for every query after the head ones. Measured on 175
 * requests (research2.test.ts R6): a dozen en-country storefronts plus the paid
 * storefront and the non-English storefronts cover ~97% of the unique apps a
 * full sweep finds, at a fraction of the request cost — the paid and
 * non-English storefronts are the ones that keep returning apps the en-US/GB
 * results never surface.
 */
export const CORE_LOCALES: PlanLocale[] = [
  ...["US", "GB", "CA", "AU", "IN", "PK", "ID", "BR", "NG", "DE", "JP", "FR"].map(
    (gl) => ({ hl: "en", gl }),
  ),
  { hl: "en", gl: "US", price: "paid" },
  ...LANGUAGE_STOREFRONTS,
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

export interface PlanQuery {
  query: string;
  kind: QueryKind;
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
 * Ordered query list: deterministic base queries first, then Play suggestions
 * appended in discovery order, then (when `wave > 0`) the deterministic
 * long-tail wave batch. Appending is what makes `planIndex` stable across
 * resumes and across waves — earlier entries never move, so wave K's queries
 * are always the first K × {@link WAVE_QUERIES_PER_WAVE} candidates.
 */
export function buildPlanQueries(
  keyword: string,
  suggestions: string[] = [],
  wave = 0,
): PlanQuery[] {
  const base = baseQuerySpecs(keyword);
  const out = [...base];
  const seen = new Set(out.map((item) => item.query.toLowerCase()));
  const budget = base.length + MAX_SUGGESTION_QUERIES;

  for (const suggestion of suggestions) {
    if (out.length >= budget) break;
    const key = suggestion.trim().toLowerCase();
    if (key.length === 0 || seen.has(key)) continue;
    if (!keepsKeyword(keyword, key)) continue;
    seen.add(key);
    out.push({ query: suggestion.trim(), kind: "suggestion" });
  }

  const targetWave = Math.min(wave, MAX_WAVES);
  if (targetWave > 0) {
    const limit = targetWave * WAVE_QUERIES_PER_WAVE;
    let added = 0;
    for (const spec of waveCandidates(keyword, suggestions)) {
      if (added >= limit) break;
      const key = spec.query.trim().toLowerCase();
      if (key.length === 0 || seen.has(key)) continue;
      seen.add(key);
      out.push(spec);
      added += 1;
    }
  }

  return out;
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

/** Total number of search requests the plan can issue. */
export function planSize(queries: PlanQuery[]): number {
  return storefrontCount(queries.length);
}

/** Resolves one index of the query × storefront cross product. */
export function entryAt(queries: PlanQuery[], index: number): QueryPlanEntry | null {
  if (index < 0 || queries.length === 0) return null;

  const headBlock = Math.min(queries.length, FULL_SWEEP_QUERIES) * PLAN_LOCALES.length;
  let queryIndex: number;
  let locale: PlanLocale;

  if (index < headBlock) {
    queryIndex = Math.floor(index / PLAN_LOCALES.length);
    locale = PLAN_LOCALES[index % PLAN_LOCALES.length];
  } else {
    const offset = index - headBlock;
    queryIndex = FULL_SWEEP_QUERIES + Math.floor(offset / CORE_LOCALES.length);
    locale = CORE_LOCALES[offset % CORE_LOCALES.length];
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
