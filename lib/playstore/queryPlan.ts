import { tokenizeKeyword } from "@/lib/filters/relevance";
import type { PriceFilter, QueryPlanEntry } from "@/types/lead";

export const MAX_PLAN_SIZE = 48;

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

function entry(
  query: string,
  kind: QueryPlanEntry["kind"],
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

/** Deterministic plan used when the suggest endpoint is unavailable. */
export function buildBasePlan(keyword: string): QueryPlanEntry[] {
  const tokens = tokenizeKeyword(keyword);
  const plan: QueryPlanEntry[] = [];

  plan.push(entry(keyword, "primary"));
  plan.push(entry(`"${keyword}"`, "primary"));

  for (const token of tokens.significant.slice(0, 4)) {
    plan.push(entry(token, "token"));
  }

  if (tokens.significant.length > 1) {
    plan.push(entry([...tokens.significant].reverse().join(" "), "variant"));
  }

  for (const suffix of VARIANT_SUFFIXES) {
    plan.push(entry(`${keyword} ${suffix}`, "variant"));
  }

  for (const modifier of TAIL_MODIFIERS) {
    plan.push(entry(`${keyword} ${modifier}`, "modifier"));
  }

  for (const locale of LOCALES) {
    plan.push(entry(keyword, "locale", locale));
  }

  plan.push(entry(keyword, "price", { hl: "en", gl: "US" }, "free"));
  plan.push(entry(keyword, "price", { hl: "en", gl: "US" }, "paid"));

  return dedupePlan(plan);
}

export function buildPlan(keyword: string, suggestions: string[] = []): QueryPlanEntry[] {
  const tokens = tokenizeKeyword(keyword);
  const plan: QueryPlanEntry[] = [];

  plan.push(entry(keyword, "primary"));

  for (const suggestion of suggestions) {
    plan.push(entry(suggestion, "suggestion"));
  }

  plan.push(entry(`"${keyword}"`, "primary"));

  for (const suffix of VARIANT_SUFFIXES) {
    plan.push(entry(`${keyword} ${suffix}`, "variant"));
  }

  for (const token of tokens.significant.slice(0, 4)) {
    plan.push(entry(token, "token"));
  }

  for (const modifier of TAIL_MODIFIERS) {
    plan.push(entry(`${keyword} ${modifier}`, "modifier"));
  }

  for (const locale of LOCALES) {
    plan.push(entry(keyword, "locale", locale));
  }

  plan.push(entry(keyword, "price", { hl: "en", gl: "US" }, "free"));
  plan.push(entry(keyword, "price", { hl: "en", gl: "US" }, "paid"));

  return dedupePlan(plan);
}
