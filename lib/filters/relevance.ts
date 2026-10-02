export interface KeywordTokens {
  raw: string;
  /** Every word found in the keyword. */
  tokens: string[];
  /** Words that carry meaning for matching (stopwords removed). */
  significant: string[];
  stopwords: string[];
}

const STOPWORDS = new Set([
  "a",
  "an",
  "the",
  "of",
  "for",
  "and",
  "or",
  "to",
  "in",
  "on",
  "at",
  "with",
  "app",
  "apps",
  "application",
  "applications",
  "android",
  "google",
  "play",
  "store",
  "best",
  "top",
]);

export function normalizeWord(word: string): string {
  return word
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\u00c0-\u024f]/g, "");
}

export function tokenizeKeyword(keyword: string): KeywordTokens {
  const raw = keyword.trim();
  const words = raw
    .split(/[^\p{L}\p{N}]+/u)
    .map(normalizeWord)
    .filter(Boolean);

  const significant = words.filter((word) => !STOPWORDS.has(word));

  return {
    raw,
    tokens: words,
    significant: significant.length > 0 ? significant : words,
    stopwords: words.filter((word) => STOPWORDS.has(word)),
  };
}

function commonPrefixLength(a: string, b: string): number {
  const limit = Math.min(a.length, b.length);
  let index = 0;
  while (index < limit && a[index] === b[index]) index += 1;
  return index;
}

/**
 * Matches lightly inflected forms of the same word: "wallet"/"wallets",
 * "tracker"/"tracking", "crypto"/"cryptocurrency".
 *
 * From six characters up the shared prefix must reach five characters.
 * Below that the shorter word must be fully consumed *and* the leftover on
 * the longer one must be a plain inflection ending (-s, -ed, -ing, ...):
 * an earlier rule that accepted any fully shared prefix let "wall" match
 * "wallet" — a developer named "RED BRIX WALL" produced "Alice's Hotel" rows
 * for the keyword "wallet". Genuinely short keyword stems still extend into
 * longer words ("sol" -> "solana").
 */
export function wordsMatch(keywordWord: string, textWord: string): boolean {
  if (keywordWord === textWord) return true;
  const shorter = Math.min(keywordWord.length, textWord.length);
  if (shorter >= 6) return commonPrefixLength(keywordWord, textWord) >= 5;
  const prefix = commonPrefixLength(keywordWord, textWord);
  if (prefix < shorter) return false;
  const longer = keywordWord.length >= textWord.length ? keywordWord : textWord;
  const rest = longer.slice(shorter);
  if (/^(?:d|s|es|ed|ing|er|ers|ly|ies)$/.test(rest)) return true;
  if (keywordWord.length < 4 && rest.length <= 8) return true;
  return false;
}

export interface RelevanceResult {
  score: number;
  /** Terms found in *any* field — developer and category hits included. */
  matchedTerms: string[];
  /**
   * Terms found in the title or description — the fields that describe the
   * app itself. A partial hit qualifies for a detail-page fetch only when it
   * comes from here; a developer-domain hit can never complete into a match,
   * so queueing it would only burn a request on a known text rejection.
   */
  primaryTerms: string[];
  relevant: boolean;
}

export const RELEVANCE_THRESHOLD = 50;

/**
 * Scores how strongly an app matches the requested keyword. Title matches are
 * worth the most, followed by developer, category and finally the description.
 *
 * An app only qualifies when it mentions *every* significant keyword word in
 * its **title or description** — the two fields that describe what the app is.
 * A hit confined to the developer or category (six live leads qualified
 * because their publisher's domain was "walletpasses.me") still counts as a
 * partial hit for seeding and queueing, but can never satisfy the keyword on
 * its own. A partial hit (only "crypto" for "crypto wallet") scores high
 * enough to clear the numeric threshold but is not a match for the keyword
 * the user asked for, so it is rejected.
 */
export function scoreRelevance(
  fields: { title: string | null; developer: string | null; category: string | null; text: string | null },
  tokens: KeywordTokens,
): RelevanceResult {
  const haystacks = [
    { text: fields.title, weight: 1, primary: true },
    { text: fields.developer, weight: 0.9, primary: false },
    { text: fields.category, weight: 0.85, primary: false },
    { text: fields.text, weight: 0.7, primary: true },
  ]
    .filter((entry) => (entry.text ?? "").trim().length > 0)
    .map((entry) => ({
      weight: entry.weight,
      primary: entry.primary,
      words: (entry.text as string)
        .split(/[^\p{L}\p{N}]+/u)
        .map(normalizeWord)
        .filter(Boolean),
    }))
    .filter((entry) => entry.words.length > 0);

  const matchedTerms: string[] = [];
  const primaryTerms: string[] = [];
  let total = 0;

  for (const term of tokens.significant) {
    let best = 0;
    let primary = false;
    for (const haystack of haystacks) {
      const matched = haystack.words.some((word) => wordsMatch(term, word));
      if (matched) {
        if (haystack.primary) primary = true;
        if (haystack.weight > best) best = haystack.weight;
      }
      if (best === 1) break;
    }
    if (best > 0) matchedTerms.push(term);
    if (primary) primaryTerms.push(term);
    total += best;
  }

  const score =
    tokens.significant.length === 0
      ? 0
      : Math.round((total / tokens.significant.length) * 100);

  const allTermsMatched =
    tokens.significant.length > 0 &&
    tokens.significant.every((term) => primaryTerms.includes(term));

  return {
    score,
    matchedTerms,
    primaryTerms,
    relevant: score >= RELEVANCE_THRESHOLD && allTermsMatched,
  };
}
