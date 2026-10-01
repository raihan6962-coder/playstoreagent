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
 * The shared prefix must reach deep into the shorter word (five characters,
 * or all of it when it is shorter). A looser four-letter rule made
 * "wallet" match "wallpapers" — unrelated words that merely start alike are
 * not inflections of each other, and the false positives it let through were
 * real rows in the user's table.
 */
export function wordsMatch(keywordWord: string, textWord: string): boolean {
  if (keywordWord === textWord) return true;
  const shorter = Math.min(keywordWord.length, textWord.length);
  if (shorter < 4) return keywordWord.startsWith(textWord) || textWord.startsWith(keywordWord);
  return commonPrefixLength(keywordWord, textWord) >= Math.min(shorter, 5);
}

export interface RelevanceResult {
  score: number;
  matchedTerms: string[];
  relevant: boolean;
}

export const RELEVANCE_THRESHOLD = 50;

/**
 * Scores how strongly an app matches the requested keyword. Title matches are
 * worth the most, followed by developer, category and finally the description.
 *
 * An app only qualifies when it mentions *every* significant keyword word
 * somewhere in its listing — a partial hit (only "crypto" for "crypto wallet")
 * scores high enough to clear the numeric threshold but is not a match for the
 * keyword the user asked for, so it is rejected.
 */
export function scoreRelevance(
  fields: { title: string | null; developer: string | null; category: string | null; text: string | null },
  tokens: KeywordTokens,
): RelevanceResult {
  const haystacks = [
    { text: fields.title, weight: 1 },
    { text: fields.developer, weight: 0.9 },
    { text: fields.category, weight: 0.85 },
    { text: fields.text, weight: 0.7 },
  ]
    .filter((entry) => (entry.text ?? "").trim().length > 0)
    .map((entry) => ({
      weight: entry.weight,
      words: (entry.text as string)
        .split(/[^\p{L}\p{N}]+/u)
        .map(normalizeWord)
        .filter(Boolean),
    }))
    .filter((entry) => entry.words.length > 0);

  const matchedTerms: string[] = [];
  let total = 0;

  for (const term of tokens.significant) {
    let best = 0;
    for (const haystack of haystacks) {
      const matched = haystack.words.some((word) => wordsMatch(term, word));
      if (matched && haystack.weight > best) best = haystack.weight;
      if (best === 1) break;
    }
    if (best > 0) matchedTerms.push(term);
    total += best;
  }

  const score =
    tokens.significant.length === 0
      ? 0
      : Math.round((total / tokens.significant.length) * 100);

  const allTermsMatched =
    tokens.significant.length > 0 &&
    tokens.significant.every((term) => matchedTerms.includes(term));

  return {
    score,
    matchedTerms,
    relevant: score >= RELEVANCE_THRESHOLD && allTermsMatched,
  };
}
