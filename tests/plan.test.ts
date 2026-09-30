import { describe, expect, it } from "vitest";
import {
  buildPlanQueries,
  CORE_LOCALES,
  entryAt,
  keepsKeyword,
  MAX_SUGGESTION_QUERIES,
  PLAN_LOCALES,
  planSize,
  suggestPrefixes,
} from "@/lib/playstore/queryPlan";
import { sanitizeCursor } from "@/lib/validation/cursor";
import { createInitialCursor } from "@/lib/playstore/crawler";

const KEYWORD = "crypto wallet";

describe("storefront sweep plan", () => {
  it("walks every query across every storefront", () => {
    const queries = buildPlanQueries(KEYWORD, ["crypto wallet app"]);
    const total = planSize(queries);
    const expected = 2 * PLAN_LOCALES.length + (queries.length - 2) * CORE_LOCALES.length;
    expect(total).toBe(expected);

    const seenPairs = new Set<string>();
    for (let index = 0; index < total; index += 1) {
      const entry = entryAt(queries, index);
      expect(entry).not.toBeNull();
      seenPairs.add(`${entry!.query}|${entry!.hl}|${entry!.gl}|${entry!.price ?? "all"}`);
    }
    expect(seenPairs.size).toBe(total);
    expect(entryAt(queries, total)).toBeNull();
    expect(entryAt(queries, -1)).toBeNull();
  });

  it("gives the head queries the full sweep and the rest the core sweep", () => {
    const queries = buildPlanQueries(KEYWORD, ["crypto wallet app", "old crypto wallet"]);
    expect(queries.length).toBe(26);

    const headBlock = 2 * PLAN_LOCALES.length;
    expect(planSize(queries)).toBe(headBlock + (queries.length - 2) * CORE_LOCALES.length);

    expect(entryAt(queries, 0)?.query).toBe(KEYWORD);
    expect(entryAt(queries, headBlock - 1)?.query).toBe(`"${KEYWORD}"`);

    const firstCore = entryAt(queries, headBlock);
    expect(firstCore?.query).toBe(queries[2].query);
    expect(firstCore?.gl).toBe("US");

    expect(entryAt(queries, planSize(queries))).toBeNull();
  });

  it("marks price and language storefronts with the right kind", () => {
    const queries = buildPlanQueries(KEYWORD);
    const first = queries[0].query;
    const priceIndex = PLAN_LOCALES.findIndex((locale) => locale.price === "paid");
    const languageIndex = PLAN_LOCALES.findIndex((locale) => locale.hl !== "en");
    expect(priceIndex).toBeGreaterThan(-1);
    expect(languageIndex).toBeGreaterThan(-1);

    expect(entryAt(queries, priceIndex)).toMatchObject({ query: first, kind: "price", price: "paid" });
    expect(entryAt(queries, languageIndex)?.kind).toBe("locale");
    expect(entryAt(queries, 0)?.kind).toBe("primary");
  });

  it("keeps earlier indexes stable when suggestions are appended later", () => {
    const base = buildPlanQueries(KEYWORD);
    const extended = buildPlanQueries(KEYWORD, [
      "crypto wallet beta",
      "old crypto wallet",
      "crypto wallet that is not about the keyword",
    ]);
    expect(extended.length).toBeGreaterThan(base.length);

    for (let index = 0; index < planSize(base); index += 1) {
      expect(entryAt(extended, index)).toEqual(entryAt(base, index));
    }
  });

  it("appends only keyword-preserving suggestions, deduplicated and capped", () => {
    const queries = buildPlanQueries(KEYWORD, [
      "crypto wallet app",
      "CRYPTO WALLET APP",
      "wallet",
      "crypto",
      "totally unrelated game",
      "cold crypto wallet",
    ]);
    const suggestionQueries = queries.filter((item) => item.kind === "suggestion");
    expect(suggestionQueries.map((item) => item.query)).toEqual(["cold crypto wallet"]);

    const many = buildPlanQueries(
      KEYWORD,
      Array.from({ length: 600 }, (_, index) => `crypto wallet variant ${index}`),
    );
    expect(many.filter((item) => item.kind === "suggestion")).toHaveLength(
      MAX_SUGGESTION_QUERIES,
    );
  });

  it("generates suggest prefixes that all keep the keyword", () => {
    const prefixes = suggestPrefixes(KEYWORD);
    expect(prefixes[0]).toBe(KEYWORD);
    expect(prefixes).toHaveLength(37);
    expect(prefixes.every((prefix) => prefix.startsWith(KEYWORD))).toBe(true);
    expect(keepsKeyword(KEYWORD, "crypto wallet beta")).toBe(true);
    expect(keepsKeyword(KEYWORD, "bitcoin price tracker")).toBe(false);
  });
});

describe("resume cursor", () => {
  it("round-trips through JSON", () => {
    const cursor = createInitialCursor(KEYWORD);
    cursor.suggestions = ["crypto wallet app", "crypto wallet beta"];
    cursor.suggestIndex = 12;
    cursor.planIndex = 300;
    cursor.seen = ["com.a", "com.b"];
    cursor.emitted = ["com.a"];
    cursor.phase = "search";

    const restored = sanitizeCursor(JSON.parse(JSON.stringify(cursor)), KEYWORD);
    expect(restored).not.toBeNull();
    expect(restored?.suggestions).toEqual(cursor.suggestions);
    expect(restored?.suggestIndex).toBe(12);
    expect(restored?.planIndex).toBe(300);
    expect(restored?.emitted).toEqual(["com.a"]);
  });

  it("rejects a plan index past the end of the sweep", () => {
    const cursor = createInitialCursor(KEYWORD);
    const total = planSize(buildPlanQueries(KEYWORD, cursor.suggestions));
    expect(sanitizeCursor({ ...cursor, planIndex: total }, KEYWORD)).not.toBeNull();
    expect(sanitizeCursor({ ...cursor, planIndex: total + 1 }, KEYWORD)).toBeNull();
    expect(sanitizeCursor({ ...cursor, planIndex: -1 }, KEYWORD)).toBeNull();
  });

  it("trims oversized suggestion payloads instead of trusting them", () => {
    const cursor = createInitialCursor(KEYWORD);
    const oversized = Array.from(
      { length: MAX_SUGGESTION_QUERIES + 10 },
      (_, index) => `crypto wallet q${index}`,
    );
    const restored = sanitizeCursor({ ...cursor, suggestions: oversized }, KEYWORD);
    expect(restored?.suggestions).toHaveLength(MAX_SUGGESTION_QUERIES);
    expect(planSize(buildPlanQueries(KEYWORD, restored!.suggestions))).toBeGreaterThan(0);
  });
});
