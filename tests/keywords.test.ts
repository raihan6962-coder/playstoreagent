import { describe, expect, it } from "vitest";
import { keywordVariants, MAX_KEYWORD_VARIANTS } from "@/lib/playstore/keywords";
import { keepsKeyword } from "@/lib/playstore/queryPlan";
import { tokenizeKeyword } from "@/lib/filters/relevance";

const KEYWORD = "budget tracker";

describe("keywordVariants", () => {
  it("builds every variant from the full keyword so the topic never drifts", () => {
    const variants = keywordVariants(KEYWORD);
    expect(variants.length).toBeGreaterThan(80);
    for (const variant of variants) {
      // The topic guarantee: every significant keyword word stays in the query,
      // so the results can never drift off-keyword.
      expect(keepsKeyword(KEYWORD, variant)).toBe(true);
      const lower = variant.toLowerCase();
      expect(
        lower.includes(KEYWORD) ||
          // The reversed form ("tracker budget") keeps both words too.
          [...tokenizeKeyword(KEYWORD).significant].every((token) => lower.includes(token)),
      ).toBe(true);
    }
    expect(variants).toContain(`best ${KEYWORD}`);
  });

  it("stays unique, deterministic and inside the cap", () => {
    const first = keywordVariants(KEYWORD);
    const second = keywordVariants(KEYWORD);
    expect(second).toEqual(first);

    const lowered = first.map((variant) => variant.toLowerCase());
    expect(new Set(lowered).size).toBe(lowered.length);
    expect(first.length).toBeLessThanOrEqual(MAX_KEYWORD_VARIANTS);
  });

  it("covers prefixes, suffixes, quoted forms and paired long tails", () => {
    const variants = keywordVariants(KEYWORD);
    expect(variants).toContain(`best ${KEYWORD}`);
    expect(variants).toContain(`${KEYWORD} apk`);
    expect(variants).toContain(`${KEYWORD} old lite`);
    expect(variants).toContain(`"${KEYWORD}"`);
    expect(variants).toContain("tracker budget");
  });

  it("handles single-word and multi-word keywords safely", () => {
    const single = keywordVariants("sudoku");
    expect(single.length).toBeGreaterThan(40);
    expect(single.every((variant) => variant.toLowerCase().includes("sudoku"))).toBe(true);

    expect(keywordVariants("  budget   tracker ")).toEqual(keywordVariants(KEYWORD));
    expect(keywordVariants("")).toEqual([]);
    const tokens = tokenizeKeyword(KEYWORD).significant;
    expect(tokens).toEqual(["budget", "tracker"]);
  });
});
