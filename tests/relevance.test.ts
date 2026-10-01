import { describe, expect, it } from "vitest";
import {
  RELEVANCE_THRESHOLD,
  scoreRelevance,
  tokenizeKeyword,
  wordsMatch,
} from "@/lib/filters/relevance";

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
    expect(wordsMatch("tracker", "tracking")).toBe(true);
    expect(wordsMatch("crypto", "cryptocurrency")).toBe(true);
    expect(wordsMatch("wallet", "wallets")).toBe(true);
    expect(wordsMatch("budget", "billets")).toBe(false);
  });

  it("does not match unrelated words that merely share four letters", () => {
    // Production case: "wallet" matched "wallpapers", so wallpaper apps
    // qualified as leads for the keyword "wallet".
    expect(wordsMatch("wallet", "wallpapers")).toBe(false);
    expect(wordsMatch("wallet", "wallreels")).toBe(false);
    expect(wordsMatch("money", "monkey")).toBe(false);
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

  it("rejects apps that only match part of the keyword", () => {
    const tokens = tokenizeKeyword("crypto wallet");

    const onlyCrypto = scoreRelevance(
      { title: "Watch Crypto Complication", developer: null, category: "Personalization", text: null },
      tokens,
    );
    expect(onlyCrypto.matchedTerms).toEqual(["crypto"]);
    expect(onlyCrypto.score).toBeGreaterThanOrEqual(RELEVANCE_THRESHOLD);
    expect(onlyCrypto.relevant).toBe(false);

    const onlyWallet = scoreRelevance(
      { title: "CKBull - Nervos Network Wallet", developer: null, category: "Finance", text: null },
      tokens,
    );
    expect(onlyWallet.matchedTerms).toEqual(["wallet"]);
    expect(onlyWallet.relevant).toBe(false);
  });

  it("accepts apps that mention every keyword word in any field", () => {
    const tokens = tokenizeKeyword("crypto wallet");
    const inDescriptionOnly = scoreRelevance(
      {
        title: "Ledger Companion",
        developer: null,
        category: null,
        text: "A secure place for your cryptocurrency and hardware wallet seeds.",
      },
      tokens,
    );

    expect(inDescriptionOnly.matchedTerms).toEqual(["crypto", "wallet"]);
    expect(inDescriptionOnly.relevant).toBe(true);
  });

  it("still accepts single-word keywords from any field", () => {
    const tokens = tokenizeKeyword("wallpaper");
    const result = scoreRelevance(
      { title: "Nature Scenes", developer: null, category: "Personalization", text: "4k wallpaper packs" },
      tokens,
    );
    expect(result.relevant).toBe(true);
  });
});
