import { describe, expect, it } from "vitest";
import { scoreRelevance, tokenizeKeyword, wordsMatch } from "@/lib/filters/relevance";

describe("tokenizeKeyword", () => {
  it("drops stopwords but keeps meaningful words", () => {
    const tokens = tokenizeKeyword("the best budget tracker for android");
    expect(tokens.significant).toEqual(["budget", "tracker"]);
    expect(tokens.stopwords).toContain("android");
  });

  it("falls back to every word when the keyword is only stopwords", () => {
    expect(tokenizeKeyword("app").significant).toEqual(["app"]);
  });
});

describe("wordsMatch", () => {
  it("matches lightly inflected forms", () => {
    expect(wordsMatch("tracker", "trackers")).toBe(true);
    expect(wordsMatch("crypto", "cryptocurrency")).toBe(true);
    expect(wordsMatch("budget", "billets")).toBe(false);
  });
});

describe("scoreRelevance", () => {
  it("scores title matches higher than description matches", () => {
    const tokens = tokenizeKeyword("budget tracker");
    const titleHit = scoreRelevance(
      { title: "Budget Tracker Pro", developer: null, category: null, text: null },
      tokens,
    );
    const descriptionOnly = scoreRelevance(
      { title: "Something Else", developer: null, category: null, text: "helps you track your budget" },
      tokens,
    );

    expect(titleHit.relevant).toBe(true);
    expect(titleHit.score).toBe(100);
    expect(descriptionOnly.score).toBeLessThan(titleHit.score);
  });

  it("rejects unrelated apps", () => {
    const tokens = tokenizeKeyword("budget tracker");
    const result = scoreRelevance(
      { title: "Zombie Run Adventure", developer: "Games Inc", category: "Games", text: "run for your life" },
      tokens,
    );
    expect(result.relevant).toBe(false);
    expect(result.matchedTerms).toEqual([]);
  });
});
