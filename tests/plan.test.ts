import { describe, expect, it } from "vitest";
import {
  buildPlanQueries,
  CORE_LOCALES,
  entryAt,
  keepsKeyword,
  MAX_SUGGESTION_QUERIES,
  MAX_WAVES,
  PLAN_LOCALES,
  planSize,
  storefrontsFor,
  suggestPrefixes,
  WAVE_QUERIES_PER_WAVE,
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
    const queries = buildPlanQueries(KEYWORD, ["cold crypto wallet", "green crypto wallet"]);
    const withoutSuggestions = buildPlanQueries(KEYWORD);
    // Both suggestions are novel and keyword-preserving, so they append one each.
    expect(queries.length).toBe(withoutSuggestions.length + 2);

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

  it("appends AI secondary phrases after the primary plan, unfiltered and deduplicated", () => {
    const base = buildPlanQueries(KEYWORD);
    const secondary = ["expense manager", "CRYPTO WALLET APP", "  money tracker  ", "crypto wallet"];
    const queries = buildPlanQueries(KEYWORD, [], 0, secondary);

    // The whole primary plan keeps its exact positions.
    for (let index = 0; index < planSize(base); index += 1) {
      expect(entryAt(queries, index)).toEqual(entryAt(base, index));
    }

    // Deduplicated against the primary plan and against itself, trimmed, the
    // main keyword itself excluded, and deliberately NOT filtered by
    // keepsKeyword — "expense manager" is the point of a secondary keyword.
    expect(keepsKeyword(KEYWORD, "expense manager")).toBe(false);
    expect(queries.slice(base.length).map((item) => item.query)).toEqual([
      "expense manager",
      "money tracker",
    ]);
    expect(planSize(queries)).toBeGreaterThan(planSize(base));
  });

  it("generates suggest prefixes that all keep the keyword", () => {
    const prefixes = suggestPrefixes(KEYWORD);
    expect(prefixes[0]).toBe(KEYWORD);
    expect(prefixes).toHaveLength(37);
    expect(prefixes.every((prefix) => prefix.startsWith(KEYWORD))).toBe(true);
    expect(keepsKeyword(KEYWORD, "crypto wallet beta")).toBe(true);
    expect(keepsKeyword(KEYWORD, "bitcoin price tracker")).toBe(false);
  });

  it("appends each wave without moving earlier plan entries", () => {
    const suggestions = ["crypto wallet app", "old crypto wallet"];
    const wave0 = buildPlanQueries(KEYWORD, suggestions);
    const wave1 = buildPlanQueries(KEYWORD, suggestions, 1);
    const wave2 = buildPlanQueries(KEYWORD, suggestions, 2);

    expect(wave1.length).toBe(wave0.length + WAVE_QUERIES_PER_WAVE);
    // Later waves keep growing while unique candidates last (the pool is
    // finite when there are no Play suggestions to draw from).
    expect(wave2.length).toBeGreaterThan(wave1.length);
    expect(wave1.slice(0, wave0.length)).toEqual(wave0);
    expect(wave2.slice(0, wave1.length)).toEqual(wave1);

    // A planIndex minted in wave 0 must still resolve to the same storefront
    // request after later waves are appended — that is what keeps resumes safe.
    for (let index = 0; index < planSize(wave0); index += 1) {
      expect(entryAt(wave2, index)).toEqual(entryAt(wave0, index));
    }
    expect(entryAt(wave2, planSize(wave2) - 1)).not.toBeNull();
    expect(entryAt(wave2, planSize(wave2))).toBeNull();
  });

  it("stops growing waves at the wave cap", () => {
    const capped = buildPlanQueries(KEYWORD, [], MAX_WAVES);
    const beyond = buildPlanQueries(KEYWORD, [], MAX_WAVES + 5);
    expect(beyond.length).toBe(capped.length);
    expect(beyond.length).toBeGreaterThan(buildPlanQueries(KEYWORD).length);
  });
});

describe("run's own storefront in the sweep", () => {
  const queries = buildPlanQueries(KEYWORD);
  const headBlock = 2 * PLAN_LOCALES.length;

  it("searches the run's country first in the head and the core sweep", () => {
    // A country the sweep does not know yet…
    expect(entryAt(queries, 0, "BD")?.gl).toBe("BD");
    expect(entryAt(queries, headBlock, "BD")?.gl).toBe("BD");
    // …and one that is already part of both lists moves to the front.
    expect(entryAt(queries, 0, "IN")?.gl).toBe("IN");
    expect(entryAt(queries, headBlock, "IN")?.gl).toBe("IN");
    expect(entryAt(queries, 1, "IN")?.gl).toBe("US");
  });

  it("keeps the plan size and every entry resolvable regardless of country", () => {
    const total = planSize(queries);
    for (const country of ["US", "BD", "AE", "FR"]) {
      const seenPairs = new Set<string>();
      for (let index = 0; index < total; index += 1) {
        const resolved = entryAt(queries, index, country);
        expect(resolved).not.toBeNull();
        seenPairs.add(
          `${resolved!.query}|${resolved!.hl}|${resolved!.gl}|${resolved!.price ?? "all"}`,
        );
      }
      expect(seenPairs.size).toBe(total);
      expect(entryAt(queries, total, country)).toBeNull();
    }
    // The shared plan must not depend on the country: saved cursors validate
    // their planIndex against planSize alone.
    expect(PLAN_LOCALES[0]).toMatchObject({ hl: "en", gl: "US" });
    expect(CORE_LOCALES[0]).toMatchObject({ hl: "en", gl: "US" });
  });

  it("swaps without dropping a storefront wholesale", () => {
    const { head, core } = storefrontsFor("AE");
    expect(head).toHaveLength(PLAN_LOCALES.length);
    expect(core).toHaveLength(CORE_LOCALES.length);
    expect(head[0]).toMatchObject({ gl: "AE" });
    expect(core[0]).toMatchObject({ gl: "AE" });
    // The English slot the country swapped into is still swept by its
    // language storefront (for AE that slot was English FR).
    expect(core.some((locale) => locale.gl === "FR" && locale.hl === "fr")).toBe(true);
    expect(core.some((locale) => locale.gl === "US")).toBe(true);
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

  it("rebuilds the plan for the cursor's wave and rejects impossible waves", () => {
    const cursor = createInitialCursor(KEYWORD);
    cursor.phase = "search";
    cursor.wave = 2;
    cursor.planIndex = planSize(buildPlanQueries(KEYWORD, [], 2));

    const restored = sanitizeCursor(JSON.parse(JSON.stringify(cursor)), KEYWORD);
    expect(restored?.wave).toBe(2);
    expect(restored?.planIndex).toBe(cursor.planIndex);

    expect(sanitizeCursor({ ...cursor, wave: MAX_WAVES + 1 }, KEYWORD)).toBeNull();
    expect(sanitizeCursor({ ...cursor, wave: -1 }, KEYWORD)).toBeNull();
    expect(sanitizeCursor({ ...cursor, wave: 1.5 }, KEYWORD)).toBeNull();
  });

  it("defaults wave fields for cursors saved before waves existed", () => {
    const legacy = createInitialCursor(KEYWORD) as unknown as Record<string, unknown>;
    delete legacy.wave;
    delete legacy.waveDiscovered;

    const restored = sanitizeCursor(legacy, KEYWORD);
    expect(restored).toMatchObject({ wave: 0, waveDiscovered: 0 });
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
