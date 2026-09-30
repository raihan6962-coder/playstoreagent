import { describe, expect, it } from "vitest";
import { evaluateApp } from "@/lib/filters/leadFilter";
import { RELEVANCE_THRESHOLD, scoreRelevance, tokenizeKeyword } from "@/lib/filters/relevance";
import type { LeadFilters, StoreApp } from "@/types/lead";

const KEYWORD = "crypto wallet";

const RATINGS: Array<number | null> = [null, 1, 2.4, 3, 3.1, 4.2, 5];
const INSTALLS: Array<number | null> = [null, 500, 10_000, 100_000, 100_001, 900_000, 10_000_000];
const TITLES = [
  "Crypto Wallet Tracker",
  "Bitcoin Crypto Wallet",
  "Budget Planner",
  "cryptocurrency wallet manager",
  "wallet",
];

function makeApp(overrides: Partial<StoreApp>): StoreApp {
  return {
    packageName: "com.example.app",
    title: "App",
    developer: "Dev",
    rating: 4,
    ratingRaw: "4.0",
    ratingsCount: 10,
    installsRaw: "10,000+",
    installs: 10_000,
    installsUpper: 50_000,
    category: "Finance",
    summary: null,
    description: null,
    icon: null,
    urlPath: null,
    ...overrides,
  };
}

function isRelevant(app: StoreApp): boolean {
  return scoreRelevance(
    {
      title: app.title,
      developer: app.developer,
      category: app.category,
      text: [app.summary, app.description].filter(Boolean).join(" "),
    },
    tokenizeKeyword(KEYWORD),
  ).relevant;
}

describe("strict qualification rules", () => {
  const filters = (overrides: Partial<LeadFilters> = {}): LeadFilters => ({
    keyword: KEYWORD,
    maxRating: 3,
    maxInstalls: 100_000,
    limit: 1_000,
    ...overrides,
  });

  it("only matches when rating, installs and relevance all pass", () => {
    const cases: Array<[number | null, number | null, string]> = [];
    for (const rating of RATINGS) {
      for (const installs of INSTALLS) {
        for (const title of TITLES) cases.push([rating, installs, title]);
      }
    }

    let checked = 0;
    for (const [rating, installs, title] of cases) {
      const app = makeApp({ packageName: `pkg.${checked}`, title, rating, installs });
      const evaluation = evaluateApp(app, filters(), new Set());
      const relevant = isRelevant(app);
      const expected =
        rating !== null &&
        rating <= 3 &&
        installs !== null &&
        installs <= 100_000 &&
        relevant;

      expect(evaluation.status === "match").toBe(expected);
      if (evaluation.status === "match") {
        expect(evaluation.lead?.relevanceScore).toBeGreaterThanOrEqual(RELEVANCE_THRESHOLD);
        expect(evaluation.lead?.rating).toBeLessThanOrEqual(3);
        expect(evaluation.lead?.installs).toBeLessThanOrEqual(100_000);
      }
      checked += 1;
    }
    expect(checked).toBe(RATINGS.length * INSTALLS.length * TITLES.length);
  });

  it("never lets a rating above the ceiling through, whatever the rest looks like", () => {
    for (const rating of [3.1, 3.5, 4, 4.9, 5]) {
      const app = makeApp({ title: "Crypto Wallet", rating, installs: 100 });
      const evaluation = evaluateApp(app, filters({ maxRating: 3 }), new Set());
      expect(evaluation.status).not.toBe("match");
      expect(evaluation.reasons).toContain("rating-too-high");
    }
  });

  it("never lets an install count above the ceiling through", () => {
    for (const installs of [100_001, 250_000, 1_000_000, 100_000_000]) {
      const app = makeApp({ title: "Crypto Wallet", rating: 1.5, installs });
      const evaluation = evaluateApp(app, filters({ maxInstalls: 100_000 }), new Set());
      expect(evaluation.status).not.toBe("match");
      expect(evaluation.reasons).toContain("installs-too-high");
    }
  });

  it("keeps the ceiling exactly at the boundary value", () => {
    const atBoundary = makeApp({ title: "Crypto Wallet", rating: 3, installs: 100_000 });
    expect(evaluateApp(atBoundary, filters(), new Set()).status).toBe("match");
  });

  it("rejects apps that only mention the keyword in an irrelevant field", () => {
    const app = makeApp({ title: "Puzzle Game", summary: null, description: null, rating: 1, installs: 500 });
    const evaluation = evaluateApp(app, filters(), new Set());
    expect(evaluation.status).not.toBe("match");
    expect(evaluation.reasons).toContain("not-relevant");
  });

  it("rejects missing rating and missing installs instead of guessing", () => {
    const noRating = makeApp({ title: "Crypto Wallet", rating: null, installs: 1_000 });
    expect(evaluateApp(noRating, filters(), new Set()).reasons).toContain("missing-rating");

    const noInstalls = makeApp({ title: "Crypto Wallet", rating: 1, installs: null, installsRaw: null });
    expect(evaluateApp(noInstalls, filters(), new Set()).reasons).toContain("missing-installs");

    const brokenInstalls = makeApp({ title: "Crypto Wallet", rating: 1, installs: null, installsRaw: "lots" });
    expect(evaluateApp(brokenInstalls, filters(), new Set()).reasons).toContain("unparseable-installs");
  });

  it("treats an already-seen package as a duplicate", () => {
    const app = makeApp({ title: "Crypto Wallet", rating: 1, installs: 1_000 });
    const evaluation = evaluateApp(app, filters(), new Set([app.packageName]));
    expect(evaluation.status).toBe("reject");
    expect(evaluation.reasons).toEqual(["duplicate"]);
  });
});
