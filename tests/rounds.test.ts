import { describe, expect, it, vi } from "vitest";
import {
  createInitialCursor,
  runGenerationStep,
} from "@/lib/playstore/crawler";
import { MAX_SECONDARY_ROUNDS } from "@/lib/keywords/secondary";
import { buildPlanQueries, planSize } from "@/lib/playstore/queryPlan";
import type { GenerationEvent, LeadFilters } from "@/types/lead";
import { detailHtml, makeAppEntry, makeFakeClient, searchHtml } from "./fixtures";

const KEYWORD = "budget tracker";

function filters(overrides: Partial<LeadFilters> = {}): LeadFilters {
  return { keyword: KEYWORD, maxRating: 3, maxInstalls: 100_000, limit: 100, country: "US", ...overrides };
}

const APPS = [
  { packageName: "com.example.budget", title: "Budget Tracker", rating: "2.1", ratingValue: 2.1, installs: "10,000+" },
  { packageName: "com.example.budget.mini", title: "Mini Budget Tracker", rating: "2.7", ratingValue: 2.7, installs: "5,000+" },
  { packageName: "com.example.famous", title: "Budget Tracker Classic", rating: "4.6", ratingValue: 4.6, installs: "10,000+" },
  { packageName: "com.example.huge", title: "Budget Tracker Deluxe", rating: "2.2", ratingValue: 2.2, installs: "10,000,000+" },
  { packageName: "com.example.zombie", title: "Zombie Run Adventure", rating: "1.9", ratingValue: 1.9, installs: "5,000+" },
];

function collect() {
  const events: GenerationEvent[] = [];
  const emit = (event: GenerationEvent) => events.push(event);
  const messages = () => events.filter((e) => e.type === "progress").map((e) => e.message);
  return { events, emit, messages };
}

function searchRoutes(): string {
  return searchHtml(APPS.map((app) => makeAppEntry(app)));
}

function detailRoute(packageName: string): string {
  const main = APPS.find((app) => app.packageName === packageName);
  if (!main) return searchHtml([]);
  const similar = APPS.filter((app) => app.packageName !== packageName);
  return detailHtml(
    { ...main, summary: "Track your budget" },
    similar.map((app) => ({ ...app })),
    main.installs ?? "10,000+",
  );
}

/** Cursor already at the end of the base plan, below the lead target. */
function dryCursor(): ReturnType<typeof createInitialCursor> {
  const cursor = createInitialCursor(KEYWORD);
  cursor.phase = "search";
  cursor.planIndex = planSize(buildPlanQueries(KEYWORD));
  cursor.counters.discovered = 5;
  cursor.counters.evaluated = 5;
  cursor.waveDiscovered = 5; // waves suppressed unless a test opts in
  cursor.seen = APPS.map((app) => app.packageName);
  return cursor;
}

describe("AI keyword rounds", () => {
  it("fires a round when the plan runs dry, searches the phrases, and counts the attempt", async () => {
    const harness = collect();
    const client = makeFakeClient({ search: searchRoutes, detail: detailRoute });
    const cursor = dryCursor();
    const generate = vi
      .fn()
      .mockResolvedValueOnce(["budget planner", "expense log"])
      .mockResolvedValue([]);

    const result = await runGenerationStep({
      filters: filters(),
      cursor,
      budgetMs: 20_000,
      emit: harness.emit,
      client,
      generateSecondary: generate,
    });

    expect(generate).toHaveBeenCalledWith(KEYWORD);
    expect(cursor.extraTail.map((entry) => entry.query)).toEqual(
      expect.arrayContaining(["budget planner", "expense log"]),
    );
    expect(cursor.secondaryRounds).toBeGreaterThanOrEqual(1);
    expect(harness.messages().some((message) => message.includes("round 1 of 5"))).toBe(true);
    expect(harness.messages().some((message) => message.includes("Queued 2 related keywords"))).toBe(true);
    // The generated phrases are actually requested from Play.
    expect(
      harness.messages().some((message) => message.includes("Searching Play Store for “budget planner”")),
    ).toBe(true);
    expect(result.reason).toBe("plan-exhausted");
  });

  it("skips generation entirely once the round budget is spent", async () => {
    const harness = collect();
    const client = makeFakeClient({ search: searchRoutes, detail: detailRoute });
    const cursor = dryCursor();
    cursor.secondaryRounds = MAX_SECONDARY_ROUNDS;
    const generate = vi.fn();

    const result = await runGenerationStep({
      filters: filters(),
      cursor,
      budgetMs: 20_000,
      emit: harness.emit,
      client,
      generateSecondary: generate,
    });

    expect(generate).not.toHaveBeenCalled();
    expect(harness.messages().some((message) => message.includes("generating related keywords"))).toBe(
      false,
    );
    expect(result.reason).toBe("plan-exhausted");
  });

  it("treats a failing generator as an empty round instead of failing the run", async () => {
    const harness = collect();
    const client = makeFakeClient({ search: searchRoutes, detail: detailRoute });
    const cursor = dryCursor();
    const generate = vi.fn().mockRejectedValue(new Error("groq down"));

    const result = await runGenerationStep({
      filters: filters(),
      cursor,
      budgetMs: 20_000,
      emit: harness.emit,
      client,
      generateSecondary: generate,
    });

    expect(cursor.secondaryRounds).toBeGreaterThanOrEqual(1);
    expect(cursor.extraTail).toEqual([]);
    expect(harness.messages().some((message) => message.includes("Round 1 produced no new keywords"))).toBe(
      true,
    );
    expect(result.reason).toBe("plan-exhausted");
  });

  it("drops round phrases that are already in the plan but still counts the round", async () => {
    const harness = collect();
    const client = makeFakeClient({ search: searchRoutes, detail: detailRoute });
    const cursor = dryCursor();
    // "budget tracker" is the primary query itself — dedupe must drop it.
    const generate = vi.fn().mockResolvedValue(["budget tracker", "  budget tracker  "]);

    await runGenerationStep({
      filters: filters(),
      cursor,
      budgetMs: 20_000,
      emit: harness.emit,
      client,
      generateSecondary: generate,
    });

    expect(cursor.extraTail).toEqual([]);
    expect(cursor.secondaryRounds).toBeGreaterThanOrEqual(1);
    expect(harness.messages().some((message) => message.includes("Queued"))).toBe(false);
  });
});
