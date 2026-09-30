import { describe, expect, it } from "vitest";
import { buildBasePlan, buildPlan, dedupePlan, MAX_PLAN_SIZE } from "@/lib/playstore/queryPlan";
import { leadsToCsv, csvFilename, leadRow } from "@/lib/csv/export";
import {
  MAX_LEADS,
  parseInstallInput,
  validateKeyword,
  validateLimit,
  validateMaxRating,
} from "@/lib/validation/input";
import { sanitizeCursor } from "@/lib/validation/cursor";
import { createInitialCursor } from "@/lib/playstore/crawler";
import type { Lead } from "@/types/lead";

describe("query plan", () => {
  it("starts with the exact keyword and stays within the cap", () => {
    const plan = buildPlan("budget tracker", ["budget tracker app"]);
    expect(plan[0]).toMatchObject({ query: "budget tracker", kind: "primary" });
    expect(plan.length).toBeLessThanOrEqual(MAX_PLAN_SIZE);
    expect(plan.some((entry) => entry.kind === "suggestion")).toBe(true);
    expect(plan.some((entry) => entry.gl !== "US")).toBe(true);
    expect(plan.some((entry) => entry.price === "paid")).toBe(true);
  });

  it("still produces a useful plan without suggestions", () => {
    const plan = buildBasePlan("budget tracker");
    expect(plan.length).toBeGreaterThan(10);
    expect(plan.every((entry) => entry.query.length > 0)).toBe(true);
  });

  it("deduplicates repeated queries", () => {
    const plan = buildPlan("budget tracker");
    const keys = plan.map((entry) => `${entry.query}|${entry.hl}|${entry.gl}|${entry.price ?? ""}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(dedupePlan([...plan, ...plan]).length).toBe(plan.length);
  });
});

describe("input validation", () => {
  it("accepts a normal request", () => {
    expect(validateKeyword("  budget   tracker ")).toEqual({ ok: true, value: "budget tracker" });
    expect(validateMaxRating("3")).toEqual({ ok: true, value: 3 });
    expect(parseInstallInput("100K")).toEqual({ ok: true, value: 100_000 });
    expect(validateLimit("10")).toEqual({ ok: true, value: 10 });
  });

  it("rejects out-of-range values", () => {
    expect(validateKeyword("a").ok).toBe(false);
    expect(validateMaxRating("9").ok).toBe(false);
    expect(validateMaxRating("0").ok).toBe(false);
    expect(parseInstallInput("lots").ok).toBe(false);
    expect(validateLimit(String(MAX_LEADS + 1)).ok).toBe(false);
    expect(validateLimit(0).ok).toBe(false);
  });
});

describe("sanitizeCursor", () => {
  it("round-trips a cursor produced by the crawler", () => {
    const cursor = createInitialCursor("budget tracker");
    expect(sanitizeCursor(cursor, "budget tracker")).not.toBeNull();
  });

  it("discards cursors for a different keyword", () => {
    const cursor = createInitialCursor("budget tracker");
    expect(sanitizeCursor(cursor, "sudoku")).toBeNull();
  });

  it("discards malformed cursors", () => {
    expect(sanitizeCursor(null, "budget tracker")).toBeNull();
    expect(sanitizeCursor({ keyword: "budget tracker" }, "budget tracker")).toBeNull();
    expect(sanitizeCursor({ ...createInitialCursor("budget tracker"), suggestions: "nope" }, "budget tracker")).toBeNull();
    expect(
      sanitizeCursor({ ...createInitialCursor("budget tracker"), phase: "done" }, "budget tracker"),
    ).toBeNull();
    expect(
      sanitizeCursor(
        { ...createInitialCursor("budget tracker"), planIndex: 9_999 },
        "budget tracker",
      ),
    ).toBeNull();
  });
});

describe("csv export", () => {
  const lead: Lead = {
    packageName: "com.example.budget",
    title: 'Budget, "Tracker"',
    developer: "Example Dev",
    rating: 2.1,
    ratingRaw: "2.1",
    ratingsCount: 57,
    installsRaw: "10,000+",
    installs: 10_000,
    installsUpper: 50_000,
    category: "Finance",
    summary: "line one\nline two",
    description: null,
    icon: null,
    urlPath: "/store/apps/details?id=com.example.budget",
    playStoreUrl: "https://play.google.com/store/apps/details?id=com.example.budget",
    keyword: "budget tracker",
    relevanceScore: 100,
    relevanceTerms: ["budget", "tracker"],
    installCertainty: "bucket",
  };

  it("quotes and escapes cells", () => {
    expect(leadRow(lead)).toEqual([
      'Budget, "Tracker"',
      "com.example.budget",
      "Example Dev",
      "2.1",
      "57",
      "10,000+",
      "Finance",
      "100%",
      "https://play.google.com/store/apps/details?id=com.example.budget",
    ]);

    const csv = leadsToCsv([lead]);
    const lines = csv.split("\r\n");
    expect(lines[0]).toContain("App Name");
    expect(lines[1]).toContain('"Budget, ""Tracker"""');
    expect(lines).toHaveLength(2);
  });

  it("builds a safe filename", () => {
    expect(csvFilename("Budget Tracker!")).toBe(
      `playstore-leads-budget-tracker-${new Date().toISOString().slice(0, 10)}.csv`,
    );
  });
});
