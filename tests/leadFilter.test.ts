import { describe, expect, it } from "vitest";
import {
  cardCanStillQualify,
  detailAppQualifies,
  evaluateApp,
  FOREIGN_RATING_WINDOW,
  leadPassesFilters,
  toLead,
} from "@/lib/filters/leadFilter";
import type { LeadFilters, StoreApp } from "@/types/lead";

const filters: LeadFilters = {
  keyword: "budget tracker",
  maxRating: 3,
  maxInstalls: 100_000,
  limit: 10,
  country: "US",
};

function app(overrides: Partial<StoreApp> = {}): StoreApp {
  return {
    packageName: "com.example.budget",
    title: "Budget Tracker",
    developer: "Example Developer",
    rating: 2.1,
    ratingRaw: "2.1",
    ratingsCount: null,
    installsRaw: "10,000+",
    installs: 10_000,
    installsUpper: 50_000,
    category: "Finance",
    summary: "Track your budget",
    description: null,
    icon: null,
    urlPath: "/store/apps/details?id=com.example.budget",
    ...overrides,
  };
}

describe("evaluateApp", () => {
  it("qualifies an app that satisfies every rule", () => {
    const result = evaluateApp(app(), filters, new Set());
    expect(result.status).toBe("match");
    expect(result.lead?.packageName).toBe("com.example.budget");
    expect(result.lead?.relevanceScore).toBeGreaterThanOrEqual(50);
  });

  it("rejects apps rated above the ceiling", () => {
    const result = evaluateApp(app({ rating: 4.2 }), filters, new Set());
    expect(result.status).toBe("reject");
    expect(result.reasons).toContain("rating-too-high");
  });

  it("rejects apps above the install ceiling", () => {
    const result = evaluateApp(app({ installs: 1_000_000, installsRaw: "1,000,000+" }), filters, new Set());
    expect(result.reasons).toContain("installs-too-high");
  });

  it("never qualifies an app without a rating", () => {
    const result = evaluateApp(app({ rating: null, ratingRaw: null }), filters, new Set());
    expect(result.status).toBe("reject");
    expect(result.reasons).toContain("missing-rating");
  });

  it("never qualifies an app without parseable installs", () => {
    const result = evaluateApp(app({ installs: null, installsRaw: null }), filters, new Set());
    expect(result.status).toBe("reject");
    expect(result.reasons).toContain("missing-installs");
  });

  it("rejects apps that are not relevant to the keyword", () => {
    const result = evaluateApp(app({ title: "Zombie Run", summary: "run away" }), filters, new Set());
    expect(result.reasons).toContain("not-relevant");
  });

  it("rejects duplicates", () => {
    const result = evaluateApp(app(), filters, new Set(["com.example.budget"]));
    expect(result.reasons).toEqual(["duplicate"]);
  });

  it("accepts a bucket install count exactly at the ceiling", () => {
    const result = evaluateApp(app({ installs: 100_000, installsRaw: "100,000+" }), filters, new Set());
    expect(result.status).toBe("match");
  });

  it("reports which keyword terms the card text matched", () => {
    expect(evaluateApp(app(), filters, new Set()).matchedTerms).toEqual(["budget", "tracker"]);
    // One of two terms — the card is partial, not irrelevant: worth a detail
    // fetch because the listing's description may carry the other term.
    const partial = evaluateApp(app({ title: "Budget Only", summary: null }), filters, new Set());
    expect(partial.status).toBe("reject");
    expect(partial.matchedTerms).toEqual(["budget"]);
    expect(
      evaluateApp(app({ title: "Zombie Run", summary: "run away" }), filters, new Set()).matchedTerms,
    ).toEqual([]);
    expect(
      evaluateApp(app(), filters, new Set(["com.example.budget"])).matchedTerms,
    ).toEqual([]);
  });
});

describe("toLead", () => {
  it("flags bucketed install counts as lower bounds", () => {
    const lead = toLead(app(), filters);
    expect(lead.installCertainty).toBe("bucket");
    expect(lead.playStoreUrl).toContain("com.example.budget");
    expect(lead.keyword).toBe("budget tracker");
  });

  it("reports exact counts when Play prints a precise number", () => {
    expect(toLead(app({ installsRaw: "10000", installs: 10_000 }), filters).installCertainty).toBe(
      "exact",
    );
  });

  it("links to the storefront the run filtered on", () => {
    const lead = toLead(app(), { ...filters, country: "BD" });
    expect(lead.playStoreUrl).toContain("gl=BD");
    expect(toLead(app(), filters).playStoreUrl).toContain("gl=US");
  });

  it("carries the listing's contact email, null when there is none", () => {
    expect(toLead(app({ email: "dev@example.com" }), filters).email).toBe("dev@example.com");
    expect(toLead(app(), filters).email).toBeNull();
  });
});

describe("cardCanStillQualify", () => {
  it("treats the run's own storefront as final", () => {
    // Home card already shows the rating — a detail fetch can only repeat it.
    expect(cardCanStillQualify({ rating: 3.8, installs: 10_000 }, filters, true)).toBe(false);
    expect(cardCanStillQualify({ rating: 2.9, installs: 10_000 }, filters, true)).toBe(true);
    expect(cardCanStillQualify({ rating: null, installs: null }, filters, true)).toBe(true);
  });

  it("keeps foreign cards a full star below the ceiling and drops the rest", () => {
    // Measured live twice: research R9 (foreign 3.6-4.0 passed 0 of 2 at a
    // 4.0 ceiling) and a niche-query probe where 9 of 10 foreign cards at or
    // below 3.5 rejected against the BD detail page (US 3.2 -> BD 4.0, KR
    // 3.3 -> BD 4.4, KR 1.3 -> BD 3.6) — the drift runs about +1.0 stars, so
    // a foreign card must print a full star below the ceiling to be worth a
    // fetch; home cards keep the whole ceiling (5 of 5 agreed card-to-detail).
    expect(FOREIGN_RATING_WINDOW).toBe(-1.0);
    expect(cardCanStillQualify({ rating: 2.0, installs: 10_000 }, filters, false)).toBe(true);
    expect(cardCanStillQualify({ rating: 2.1, installs: 10_000 }, filters, false)).toBe(false);
    expect(cardCanStillQualify({ rating: 3.0, installs: 10_000 }, filters, true)).toBe(true);
    expect(cardCanStillQualify({ rating: 3.1, installs: 10_000 }, filters, true)).toBe(false);
    expect(cardCanStillQualify({ rating: null, installs: null }, filters, false)).toBe(true);
  });

  it("always drops an over-cap install bucket", () => {
    // Play prints the same install bucket on every storefront.
    expect(cardCanStillQualify({ rating: 2.0, installs: 1_000_000 }, filters, true)).toBe(false);
    expect(cardCanStillQualify({ rating: 2.0, installs: 1_000_000 }, filters, false)).toBe(false);
    expect(cardCanStillQualify({ rating: null, installs: 10_000 }, filters, false)).toBe(true);
  });
});

describe("newly published mode", () => {
  const solo: LeadFilters = { ...filters, publishedWithinDays: 30 };

  it("keeps an app the rating ceiling would have dropped", () => {
    // The rating ceiling is not a rule in the mode: a rating is only shown
    // for an app people have already rated.
    const result = evaluateApp(app({ rating: 4.8, ratingRaw: "4.8" }), solo, new Set());
    expect(result.status).toBe("match");
    expect(result.lead?.packageName).toBe("com.example.budget");
  });

  it("still drops an app the install ceiling would have dropped", () => {
    // A brand-new app has few installs, so the cap stays in force.
    const result = evaluateApp(
      app({ installs: 900_000_000, installsRaw: "900,000,000+" }),
      solo,
      new Set(),
    );
    expect(result.status).toBe("reject");
    expect(result.reasons).toContain("installs-too-high");
  });

  it("keeps an app with no rating and no install count", () => {
    const result = evaluateApp(
      app({ rating: null, ratingRaw: null, installs: null, installsRaw: null }),
      solo,
      new Set(),
    );
    expect(result.status).toBe("reject");
    expect(result.reasons).toContain("missing-installs");
  });

  it("still drops an app that does not carry the keyword", () => {
    const result = evaluateApp(
      app({ title: "Zombie Run", summary: "run away", rating: 4.9, ratingRaw: "4.9" }),
      solo,
      new Set(),
    );
    expect(result.status).toBe("reject");
    expect(result.reasons).toContain("not-relevant");
  });

  it("still drops a duplicate", () => {
    const result = evaluateApp(app(), solo, new Set(["com.example.budget"]));
    expect(result.reasons).toEqual(["duplicate"]);
  });

  it("never lets the rating ceiling disqualify a card, but the install cap does", () => {
    expect(cardCanStillQualify({ rating: 4.9, installs: 10_000 }, solo, true)).toBe(true);
    expect(cardCanStillQualify({ rating: 4.9, installs: 10_000 }, solo, false)).toBe(true);
    expect(cardCanStillQualify({ rating: 4.9, installs: 900_000_000 }, solo, true)).toBe(false);
  });

  it("keeps a lead whose rating breaks the ceiling", () => {
    const lead = { ...toLead(app({ rating: 4.9, ratingRaw: "4.9" }), solo), releasedAt: Date.now() };
    // The rating ceiling is not a rule in the mode.
    expect(leadPassesFilters(lead, solo)).toBe(false); // rated, so not new
    // The same lead under the normal rules is dropped on the ceiling.
    expect(leadPassesFilters(lead, filters)).toBe(false);
  });

  it("keeps an unrated lead published inside the window", () => {
    const lead = { ...toLead(app({ rating: null, ratingRaw: null }), solo), releasedAt: Date.now() };
    expect(leadPassesFilters(lead, solo)).toBe(true);
  });

  it("never disqualifies a detail page", () => {
    expect(detailAppQualifies({ rating: null } as StoreApp, solo)).toBe(true);
    expect(detailAppQualifies({ rating: 4.9 } as StoreApp, solo)).toBe(true);
    expect(detailAppQualifies({ rating: 4.9 } as StoreApp, filters)).toBe(false);
  });

  it("drops a lead published before the window", () => {
    const fresh = { ...toLead(app({ rating: null, ratingRaw: null }), solo), releasedAt: Date.now() - 5 * 86_400_000 };
    const old = { ...fresh, releasedAt: Date.now() - 90 * 86_400_000 };
    const undated = { ...fresh, releasedAt: null };

    expect(leadPassesFilters(fresh, solo)).toBe(true);
    expect(leadPassesFilters(old, solo)).toBe(false);
    // No recorded release date cannot be proven new.
    expect(leadPassesFilters(undated, solo)).toBe(false);
    // The same lead passes when the mode is off.
    expect(leadPassesFilters(undated, filters)).toBe(false);
  });

  it("drops a lead people have already rated", () => {
    const rated = { ...toLead(app({ rating: 4.9, ratingRaw: "4.9" }), solo), releasedAt: Date.now() };
    // Rated, so it is not a brand-new listing — whatever the date says.
    expect(leadPassesFilters(rated, solo)).toBe(false);
  });
});
