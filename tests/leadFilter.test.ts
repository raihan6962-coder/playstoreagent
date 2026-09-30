import { describe, expect, it } from "vitest";
import { evaluateApp, toLead } from "@/lib/filters/leadFilter";
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
});
