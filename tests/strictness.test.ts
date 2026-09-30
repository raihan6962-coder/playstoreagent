import { describe, expect, it } from "vitest";
import {
  detailAppQualifies,
  evaluateApp,
  filterLeads,
  leadPassesFilters,
} from "@/lib/filters/leadFilter";
import { RELEVANCE_THRESHOLD, scoreRelevance, tokenizeKeyword } from "@/lib/filters/relevance";
import type { Lead, LeadFilters, StoreApp } from "@/types/lead";

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
    country: "US",
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

describe("guards for leads that are already on screen", () => {
  const filters: LeadFilters = {
    keyword: KEYWORD,
    maxRating: 3.5,
    maxInstalls: 100_000,
    limit: 1_000,
    country: "US",
  };

  function qualifiedLead(overrides: Partial<Lead> = {}): Lead {
    const evaluation = evaluateApp(
      makeApp({ title: "Crypto Wallet", rating: 3.4, installs: 90_000 }),
      filters,
      new Set(),
    );
    expect(evaluation.status).toBe("match");
    return { ...evaluation.lead!, ...overrides };
  }

  it("keeps a lead that still satisfies the filters", () => {
    expect(leadPassesFilters(qualifiedLead(), filters)).toBe(true);
  });

  it("keeps a lead whose rating only differs below the printed precision", () => {
    // Play prints one decimal: a detail page reporting 3.54 is the same "3.5"
    // the store card showed, so it stays within a 3.5 ceiling.
    expect(leadPassesFilters(qualifiedLead({ rating: 3.54 }), filters)).toBe(true);
    expect(leadPassesFilters(qualifiedLead({ rating: 3 }), filters)).toBe(true);
  });

  it("drops a lead whose printed rating is above the ceiling", () => {
    expect(leadPassesFilters(qualifiedLead({ rating: 3.56 }), filters)).toBe(false);
    expect(leadPassesFilters(qualifiedLead({ rating: 4.2 }), filters)).toBe(false);
  });

  it("drops a lead whose installs climbed above the ceiling", () => {
    expect(leadPassesFilters(qualifiedLead({ installs: 250_000 }), filters)).toBe(false);
  });

  it("drops a lead that no longer carries the keyword", () => {
    const lead = qualifiedLead();
    const withoutKeyword: Lead = {
      ...lead,
      title: "Wallet Companion",
      summary: null,
      description: null,
    };
    expect(leadPassesFilters(withoutKeyword, filters)).toBe(false);

    const stillMatched: Lead = {
      ...lead,
      title: "Ledger Companion",
      summary: null,
      description: "Keep your cryptocurrency wallet safe.",
    };
    expect(leadPassesFilters(stillMatched, filters)).toBe(true);
  });

  it("re-qualifies against the keyword in use, not the one it was found with", () => {
    const lead = qualifiedLead();
    expect(leadPassesFilters(lead, { ...filters, keyword: "budget tracker" })).toBe(false);
  });

  it("filterLeads removes exactly the rows that break the rules", () => {
    const good = qualifiedLead({ packageName: "com.example.a" });
    const highRating = { ...qualifiedLead({ packageName: "com.example.b" }), rating: 3.6 };
    const highInstalls = { ...qualifiedLead({ packageName: "com.example.c" }), installs: 999_999 };
    const irrelevant: Lead = {
      ...qualifiedLead({ packageName: "com.example.d" }),
      title: "Puzzle Game",
      summary: null,
      description: null,
    };

    const kept = filterLeads([good, highRating, highInstalls, irrelevant], filters);
    expect(kept.map((lead) => lead.packageName)).toEqual(["com.example.a"]);
  });

  it("detailAppQualifies rejects a printed rating above the ceiling", () => {
    expect(
      detailAppQualifies(makeApp({ title: "Crypto Wallet", rating: 3.56, installs: 10_000 }), filters),
    ).toBe(false);
    expect(
      detailAppQualifies(makeApp({ title: "Crypto Wallet", rating: 4.6, installs: 10_000 }), filters),
    ).toBe(false);
    // 3.54 is the store's "3.5": same number the user sees on Play.
    expect(
      detailAppQualifies(makeApp({ title: "Crypto Wallet", rating: 3.54, installs: 10_000 }), filters),
    ).toBe(true);
    expect(
      detailAppQualifies(makeApp({ title: "Crypto Wallet", rating: 3.5, installs: 10_000 }), filters),
    ).toBe(true);
  });

  it("detailAppQualifies drops a row whose detail page has no rating to compare", () => {
    // The search card's rating came from whichever storefront first surfaced
    // the app; without a rating from the run's own country there is nothing to
    // prove the row matches what the user sees on Play, so the lead is removed
    // instead of keeping a number we cannot stand behind.
    const noRating = makeApp({
      title: "Crypto Wallet",
      rating: null,
      installs: null,
      installsRaw: null,
      summary: "Store your cryptocurrency wallet.",
      description: null,
    });
    expect(detailAppQualifies(noRating, filters)).toBe(false);
  });

  it("detailAppQualifies keeps search installs when the detail page lacks them", () => {
    const noInstalls = makeApp({
      title: "Crypto Wallet",
      rating: 2.5,
      installs: null,
      installsRaw: null,
      summary: "Store your cryptocurrency wallet.",
      description: null,
    });
    expect(detailAppQualifies(noInstalls, filters)).toBe(true);
  });

  it("detailAppQualifies only judges the numeric ceilings", () => {
    // Keyword matching for a merge is decided on the merged record (search
    // snippet + detail description) by leadPassesFilters, not on the detail
    // page's short JSON-LD blurb alone.
    expect(
      detailAppQualifies(makeApp({ title: "Puzzle Game", rating: 1, installs: 100 }), filters),
    ).toBe(true);
    expect(
      detailAppQualifies(makeApp({ title: "Puzzle Game", rating: 4.9, installs: 100 }), filters),
    ).toBe(false);
    expect(
      detailAppQualifies(
        makeApp({ title: "Puzzle Game", rating: 1, installs: 1_000_000 }),
        filters,
      ),
    ).toBe(false);
  });
});
