import { tokenizeKeyword } from "@/lib/filters/relevance";

/**
 * Deterministic, topic-consistent query variants built from ONE keyword.
 *
 * Play's suggest endpoint only answers ~10 labels per prefix and is best
 * effort, so a run that leans on it keeps re-issuing near-identical queries
 * and surfaces the same apps over and over. These variants are generated
 * locally from the keyword itself — every variant embeds the full keyword
 * verbatim ("budget tracker" → "best budget tracker", "budget tracker lite
 * apk") or, in the reversed form, keeps every significant keyword word
 * ("tracker budget") — so each query stays on the same topic and every app it
 * can rank still has to pass the strict qualification rules (all significant
 * keyword words + rating ceiling + install ceiling) before it becomes a lead.
 */

/** Query prefixes tried in front of the keyword. */
const PREFIXES = [
  "best",
  "free",
  "top",
  "new",
  "offline",
  "online",
  "simple",
  "easy",
  "smart",
  "lightweight",
  "secure",
  "private",
  "fast",
  "open source",
  "no ads",
];

/** Query tails tried after the keyword. */
const SUFFIXES = [
  "app",
  "apk",
  "application",
  "for android",
  "app for android",
  "free",
  "offline",
  "online",
  "tracker",
  "manager",
  "tool",
  "software",
  "guide",
  "tips",
  "no ads",
  "premium",
  "pro",
  "old version",
  "lite version",
  "download",
];

/** Long-tail modifiers combined with the keyword (single and paired). */
const MODIFIERS = [
  "old",
  "lite",
  "mini",
  "beta",
  "test",
  "demo",
  "simple",
  "basic",
  "small",
  "local",
  "light",
  "tiny",
  "fast",
  "private",
  "secure",
  "offline",
  "free",
  "open source",
];

/** Cap so the plan stays dominated by Play-sourced suggestions and sweeps. */
export const MAX_KEYWORD_VARIANTS = 160;
/** How many leading modifiers take part in the paired long tails. */
const PAIR_HEAD = 8;

/**
 * Returns the deterministic variants for `keyword`, in generation order,
 * deduplicated case-insensitively and capped at {@link MAX_KEYWORD_VARIANTS}.
 * Every entry keeps all of the keyword's significant words, so no query can
 * drift off topic.
 */
export function keywordVariants(keyword: string): string[] {
  const base = keyword.trim().replace(/\s+/g, " ");
  if (base.length === 0) return [];

  const out: string[] = [];
  const seen = new Set<string>([base.toLowerCase()]);
  const push = (query: string): void => {
    if (out.length >= MAX_KEYWORD_VARIANTS) return;
    const trimmed = query.trim().replace(/\s+/g, " ");
    const key = trimmed.toLowerCase();
    if (trimmed.length === 0 || seen.has(key)) return;
    seen.add(key);
    out.push(trimmed);
  };

  for (const prefix of PREFIXES) push(`${prefix} ${base}`);
  for (const suffix of SUFFIXES) push(`${base} ${suffix}`);
  for (const modifier of MODIFIERS) push(`${base} ${modifier}`);

  // Quoted forms narrow Play to the exact phrase — they surface the apps that
  // rank for the keyword itself under a different result order.
  push(`"${base}"`);
  for (const suffix of SUFFIXES.slice(0, 6)) push(`"${base}" ${suffix}`);

  // Token-order and plural variants keep every significant keyword word, so
  // they stay on topic while matching how users actually type the term.
  const tokens = tokenizeKeyword(base).significant;
  if (tokens.length > 1) {
    push([...tokens].reverse().join(" "));
    const last = tokens[tokens.length - 1];
    push([...tokens.slice(0, -1), last.endsWith("s") ? `${last}es` : `${last}s`].join(" "));
  }

  // Paired modifiers make the long tails Play actually has room to rank for.
  for (const first of MODIFIERS.slice(0, PAIR_HEAD)) {
    for (const second of MODIFIERS) {
      if (first === second) continue;
      push(`${base} ${first} ${second}`);
    }
  }

  return out;
}
