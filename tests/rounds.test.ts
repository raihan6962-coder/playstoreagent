import { describe, expect, it, vi } from "vitest";
import {
  createInitialCursor,
  runGenerationStep,
} from "@/lib/playstore/crawler";
import { MAX_CONSECUTIVE_DRY_ROUNDS, MAX_SECONDARY_ROUNDS } from "@/lib/keywords/secondary";
import { buildCycleQueries, planSize } from "@/lib/playstore/queryPlan";
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
  const leads = () => events.filter((e) => e.type === "lead").map((e) => e.lead);
  const messages = () => events.filter((e) => e.type === "progress").map((e) => e.message);
  return { events, emit, leads, messages };
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

/** Cursor whose main-keyword cycle is already collected, below the lead target. */
function dryCursor(): ReturnType<typeof createInitialCursor> {
  const cursor = createInitialCursor(KEYWORD);
  cursor.phase = "collect";
  cursor.planIndex = planSize(buildCycleQueries(KEYWORD, []));
  cursor.counters.discovered = 5;
  cursor.counters.evaluated = 5;
  cursor.seen = APPS.map((app) => app.packageName);
  return cursor;
}

describe("AI keyword rounds", () => {
  it("fires a round when the keyword queue runs dry, cycles the phrases, and counts the attempt", async () => {
    const harness = collect();
    const client = makeFakeClient({ search: searchRoutes, detail: detailRoute });
    const cursor = dryCursor();
    const generate = vi
      .fn()
      .mockResolvedValueOnce(["budget planner"])
      .mockResolvedValue([]);

    const result = await runGenerationStep({
      filters: filters(),
      cursor,
      budgetMs: 20_000,
      emit: harness.emit,
      client,
      generateSecondary: generate,
    });

    // Rounds are asked against the MAIN keyword so every phrase stays in its
    // neighbourhood, with the tried phrases attached so the model opens
    // fresh ground instead of reshuffling.
    expect(generate).toHaveBeenCalledWith(KEYWORD, expect.any(Array));
    expect(cursor.keywords).toContain("budget planner");
    expect(cursor.secondaryRounds).toBeGreaterThanOrEqual(1);
    expect(harness.messages().some((message) => message.includes(`round 1 of ${MAX_SECONDARY_ROUNDS}`))).toBe(
      true,
    );
    expect(harness.messages().some((message) => message.includes("Queued 1 related keywords"))).toBe(true);
    // The generated phrase gets its own collect cycle: it is actually
    // requested from Play.
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
    expect(cursor.keywords).toEqual([KEYWORD]);
    expect(harness.messages().some((message) => message.includes("Round 1 produced no new keywords"))).toBe(
      true,
    );
    expect(result.reason).toBe("plan-exhausted");
  });

  it("drops round phrases that are already queued but still counts the round", async () => {
    const harness = collect();
    const client = makeFakeClient({ search: searchRoutes, detail: detailRoute });
    const cursor = dryCursor();
    // "budget tracker" is the main keyword itself — dedupe must drop it.
    const generate = vi.fn().mockResolvedValue(["budget tracker", "  budget tracker  "]);

    await runGenerationStep({
      filters: filters(),
      cursor,
      budgetMs: 20_000,
      emit: harness.emit,
      client,
      generateSecondary: generate,
    });

    expect(cursor.keywords).toEqual([KEYWORD]);
    expect(cursor.secondaryRounds).toBeGreaterThanOrEqual(1);
    expect(harness.messages().some((message) => message.includes("Queued"))).toBe(false);
  });

  it("stops generating after three consecutive dry rounds even with rounds left", async () => {
    const harness = collect();
    const client = makeFakeClient({ search: searchRoutes, detail: detailRoute });
    const cursor = dryCursor();
    cursor.dryRounds = MAX_CONSECUTIVE_DRY_ROUNDS;
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
    expect(cursor.secondaryRounds).toBe(0);
    expect(harness.messages().some((message) => message.includes("generating related keywords"))).toBe(
      false,
    );
    expect(result.reason).toBe("plan-exhausted");
  });

  it("resets the dry counter when a round produces fresh keywords", async () => {
    const harness = collect();
    const client = makeFakeClient({ search: searchRoutes, detail: detailRoute });
    const cursor = dryCursor();
    cursor.dryRounds = MAX_CONSECUTIVE_DRY_ROUNDS - 1; // one round left before the dry stop
    const generate = vi
      .fn()
      .mockResolvedValueOnce(["budget planner"])
      .mockResolvedValue([]);

    await runGenerationStep({
      filters: filters(),
      cursor,
      budgetMs: 20_000,
      emit: harness.emit,
      client,
      generateSecondary: generate,
    });

    expect(cursor.keywords).toContain("budget planner");
    // Round two firing at all proves the productive round reset the counter
    // (without the reset, dryRounds would have blocked it at MAX); the dry
    // second round then counts up from zero again.
    expect(cursor.secondaryRounds).toBeGreaterThanOrEqual(2);
    expect(cursor.dryRounds).toBeGreaterThanOrEqual(1);
    expect(cursor.dryRounds).toBeLessThan(MAX_CONSECUTIVE_DRY_ROUNDS);
  });

  it("advances through queued keywords without calling the generator", async () => {
    const harness = collect();
    const client = makeFakeClient({ search: searchRoutes, detail: detailRoute });
    const cursor = dryCursor();
    cursor.keywords = [KEYWORD, "budget planner"];

    const result = await runGenerationStep({
      filters: filters(),
      cursor,
      budgetMs: 20_000,
      emit: harness.emit,
      client,
    });

    expect(cursor.keywordIndex).toBe(1);
    expect(cursor.counters.cycles).toBeGreaterThanOrEqual(1);
    expect(
      harness.messages().some((message) => message.includes("Searching Play Store for “budget planner”")),
    ).toBe(true);
    expect(result.reason).toBe("plan-exhausted");
  });

  it("ends a stale cycle early instead of burning its whole plan", async () => {
    // Every search re-returns seen apps: after hundreds of searches with
    // nothing new, the cycle gives up and the run moves on — late-cycle
    // queries otherwise re-request the same seen apps thousands of times.
    const harness = collect();
    const client = makeFakeClient({ search: searchRoutes, detail: detailRoute });
    const cursor = dryCursor();
    cursor.keywords = [KEYWORD, "budget planner"];
    cursor.planIndex = 0;
    cursor.cycleQueries = 0;

    const result = await runGenerationStep({
      filters: filters(),
      cursor,
      budgetMs: 20_000,
      emit: harness.emit,
      client,
    });

    expect(cursor.keywordIndex).toBe(1);
    expect(cursor.counters.cycles).toBeGreaterThanOrEqual(1);
    // Hundreds of stagnant searches per cycle, not the ~4,300-request plan.
    expect(cursor.counters.queriesRun).toBeLessThan(1_000);
    expect(result.reason).toBe("plan-exhausted");
  });

  it("converts a main-relevant app discovered in a secondary cycle", async () => {
    // GOOD answers the main keyword but not "expense manager": found late
    // (the main cycle never searched here), it must still convert under the
    // main keyword instead of dying as irrelevant in a cycle that was never
    // about it.
    const harness = collect();
    const client = makeFakeClient({
      search: searchRoutes,
      detail: (packageName: string) => {
        // The zombie stays off-topic on its own page too.
        if (packageName === "com.example.zombie") {
          return detailHtml(
            {
              packageName: "com.example.zombie",
              title: "Zombie Run Adventure",
              rating: "1.9",
              ratingValue: 1.9,
              installs: "5,000+",
              summary: "Run from the undead horde",
            },
            [],
            "5,000+",
          );
        }
        return detailRoute(packageName);
      },
    });
    const cursor = createInitialCursor(KEYWORD);
    cursor.keywords = [KEYWORD, "expense manager"];
    cursor.planIndex = planSize(buildCycleQueries(KEYWORD, []));

    const result = await runGenerationStep({
      filters: filters({ limit: 10 }),
      cursor,
      budgetMs: 20_000,
      emit: harness.emit,
      client,
    });

    const names = harness.leads().map((lead) => lead.packageName).sort();
    expect(names).toEqual(["com.example.budget", "com.example.budget.mini"]);
    expect(harness.leads().every((lead) => lead.keyword === KEYWORD)).toBe(true);
    expect(result.stats.matched).toBe(2);
    // The funnel now explains itself: over-ceiling, over-install and
    // off-topic cards are counted at the card level.
    expect(result.stats.cardDropRating).toBeGreaterThan(0);
    expect(result.stats.cardDropInstalls).toBeGreaterThan(0);
    expect(result.stats.cardDropIrrelevant).toBeGreaterThan(0);
  });

  it("judges a secondary cycle against its own keyword and cleans its pool", async () => {
    // "Expense Manager" carries none of the main keyword's words: the main
    // cycle's harvest must skip it, and the secondary cycle must convert it —
    // each cycle filters by its own phrase.
    const EXPENSE = {
      packageName: "com.example.expense",
      title: "Expense Manager",
      rating: "2.0",
      ratingValue: 2.0,
      installs: "10,000+",
      summary: "Manage every expense account from one manager dashboard. ".repeat(8),
    };
    expect(EXPENSE.summary.length).toBeGreaterThanOrEqual(300);
    const harness = collect();
    const client = makeFakeClient({
      search: () => searchHtml([makeAppEntry(EXPENSE)]),
      detail: () => detailHtml({ ...EXPENSE }, [], "10,000+"),
    });
    const cursor = createInitialCursor(KEYWORD);
    cursor.keywords = [KEYWORD, "expense manager"];

    const result = await runGenerationStep({
      filters: filters({ limit: 10 }),
      cursor,
      budgetMs: 20_000,
      emit: harness.emit,
      client,
    });

    expect(harness.leads().map((lead) => lead.packageName)).toEqual(["com.example.expense"]);
    expect(harness.leads()[0].keyword).toBe("expense manager");
    expect(result.stats.matched).toBe(1);
    expect(result.stats.collected).toBe(1);
    // The main cycle's harvest skipped it at the gate (complete text, wrong
    // topic) instead of spending a verify on it.
    expect(result.stats.cardDropIrrelevant).toBe(1);
    expect(cursor.counters.cycles).toBe(2);
    // The temporary pool never survives its cycle.
    expect(cursor.tempCandidates).toHaveLength(0);
    expect(cursor.cycleSeen).toHaveLength(0);
    expect(result.reason).toBe("plan-exhausted");
  });

  it("stops immediately at the query safety cap without issuing requests", async () => {
    const harness = collect();
    const client = makeFakeClient({ search: searchRoutes, detail: detailRoute });
    const cursor = dryCursor();
    cursor.counters.queriesRun = 12;

    const result = await runGenerationStep({
      filters: filters(),
      cursor,
      budgetMs: 20_000,
      emit: harness.emit,
      client,
      queryBudget: 12,
    });

    expect(result.reason).toBe("query-cap");
    expect(result.message).toContain("safety cap");
    expect(result.message).toContain("Resume");
    // The phase is preserved so the granted Resume continues, not restarts.
    expect(result.cursor?.phase).toBe("collect");
    expect(harness.messages().some((message) => message.includes("Searching Play Store"))).toBe(false);
  });
});
