import { describe, expect, it, vi } from "vitest";
import {
  createInitialCursor,
  runGenerationStep,
} from "@/lib/playstore/crawler";
import {
  buildPlanQueries,
  keepsKeyword,
  MAX_SUGGESTION_QUERIES,
  planSize,
} from "@/lib/playstore/queryPlan";
import { PlayHttpError } from "@/lib/playstore/client";
import type { GenerationEvent, LeadFilters } from "@/types/lead";
import { detailHtml, makeAppEntry, makeFakeClient, searchHtml } from "./fixtures";

const KEYWORD = "budget tracker";

function filters(overrides: Partial<LeadFilters> = {}): LeadFilters {
  return { keyword: KEYWORD, maxRating: 3, maxInstalls: 100_000, limit: 2, country: "US", ...overrides };
}

const GOOD = {
  packageName: "com.example.budget",
  title: "Budget Tracker",
  rating: "2.1",
  ratingValue: 2.1,
  installs: "10,000+",
};

const GOOD_TWO = {
  packageName: "com.example.budget.mini",
  title: "Mini Budget Tracker",
  rating: "2.7",
  ratingValue: 2.7,
  installs: "5,000+",
};

const TOO_POPULAR_RATING = {
  packageName: "com.example.famous",
  title: "Budget Tracker Classic",
  rating: "4.6",
  ratingValue: 4.6,
  installs: "10,000+",
};

const TOO_MANY_INSTALLS = {
  packageName: "com.example.huge",
  title: "Budget Tracker Deluxe",
  rating: "2.2",
  ratingValue: 2.2,
  installs: "10,000,000+",
};

const IRRELEVANT = {
  packageName: "com.example.zombie",
  title: "Zombie Run Adventure",
  rating: "1.9",
  ratingValue: 1.9,
  installs: "5,000+",
};

function collect() {
  const events: GenerationEvent[] = [];
  const emit = (event: GenerationEvent) => events.push(event);
  const leads = () => events.filter((e) => e.type === "lead").map((e) => e.lead);
  const updates = () => events.filter((e) => e.type === "lead-update").map((e) => e.app);
  const done = () => events.find((e) => e.type === "done");
  const messages = () => events.filter((e) => e.type === "progress").map((e) => e.message);
  return { events, emit, leads, updates, done, messages };
}

function searchRoutes() {
  return searchHtml([
    makeAppEntry(GOOD),
    makeAppEntry(GOOD_TWO),
    makeAppEntry(TOO_POPULAR_RATING),
    makeAppEntry(TOO_MANY_INSTALLS),
    makeAppEntry(IRRELEVANT),
  ]);
}

function detailRoute(packageName: string): string {
  const all = [GOOD, GOOD_TWO, TOO_POPULAR_RATING, TOO_MANY_INSTALLS, IRRELEVANT];
  const main = all.find((entry) => entry.packageName === packageName);
  if (!main) return searchHtml([]);
  const similar = all.filter((entry) => entry.packageName !== packageName);
  return detailHtml(
    { ...main, summary: "Track your budget" },
    similar.map((entry) => ({ ...entry })),
    main.installs ?? "10,000+",
  );
}

describe("runGenerationStep", () => {
  it("collects leads that pass relevance, rating and install rules", async () => {
    const harness = collect();
    const client = makeFakeClient({ search: () => searchRoutes(), detail: detailRoute });

    const result = await runGenerationStep({
      filters: filters(),
      cursor: createInitialCursor(KEYWORD),
      budgetMs: 8_000,
      emit: harness.emit,
      client,
    });

    const leads = harness.leads();
    expect(leads.map((lead) => lead.packageName).sort()).toEqual([
      "com.example.budget",
      "com.example.budget.mini",
    ]);
    expect(result.reason).toBe("target-reached");
    expect(result.stats.matched).toBe(2);
    expect(harness.done()).toMatchObject({ type: "done" });
  });

  it("never returns apps above the rating or install ceiling", async () => {
    const harness = collect();
    const client = makeFakeClient({ search: () => searchRoutes(), detail: detailRoute });

    const result = await runGenerationStep({
      filters: filters({ limit: 50 }),
      cursor: createInitialCursor(KEYWORD),
      budgetMs: 8_000,
      emit: harness.emit,
      client,
    });

    const names = harness.leads().map((lead) => lead.packageName);
    expect(names).not.toContain("com.example.famous");
    expect(names).not.toContain("com.example.huge");
    expect(names).not.toContain("com.example.zombie");
    expect(result.reason).toBe("plan-exhausted");
    expect(result.cursor).toBeNull();
    expect(result.message).toContain("Only 2 matching apps were found");
  });

  it("stops searching as soon as the lead target is reached", async () => {
    const harness = collect();
    const client = makeFakeClient({ search: () => searchRoutes(), detail: detailRoute });
    const cursor = createInitialCursor(KEYWORD);

    await runGenerationStep({
      filters: filters({ limit: 1 }),
      cursor,
      budgetMs: 8_000,
      emit: harness.emit,
      client,
    });

    expect(harness.leads()).toHaveLength(1);
    expect(cursor.planIndex).toBeLessThan(planSize(buildPlanQueries(KEYWORD, cursor.suggestions)));
    expect(harness.messages().some((message) => message.includes("Searching Play Store"))).toBe(true);
  });

  it("enriches confirmed leads with the ratings count from their detail page", async () => {
    const harness = collect();
    const client = makeFakeClient({ search: () => searchRoutes(), detail: detailRoute });

    await runGenerationStep({
      filters: filters(),
      cursor: createInitialCursor(KEYWORD),
      budgetMs: 8_000,
      emit: harness.emit,
      client,
    });

    const updates = harness.updates();
    expect(updates.length).toBeGreaterThan(0);
    expect(updates.every((app) => app.ratingsCount !== null)).toBe(true);
    expect(updates.some((app) => app.packageName === "com.example.budget")).toBe(true);
  });

  it("removes a lead whose detail page reports a rating above the ceiling", async () => {
    const harness = collect();
    const client = makeFakeClient({
      search: () => searchRoutes(),
      detail: (packageName) => {
        if (packageName === "com.example.budget") {
          // Search card printed 2.1; the authoritative detail page says 4.6.
          return detailHtml(
            { ...GOOD, ratingValue: 4.6, summary: "Track your budget" },
            [GOOD_TWO, TOO_POPULAR_RATING, TOO_MANY_INSTALLS, IRRELEVANT].map((entry) => ({
              ...entry,
            })),
            "10,000+",
          );
        }
        return detailRoute(packageName);
      },
    });

    const result = await runGenerationStep({
      filters: filters(),
      cursor: createInitialCursor(KEYWORD),
      budgetMs: 8_000,
      emit: harness.emit,
      client,
    });

    const removes = harness.events.filter(
      (event): event is Extract<GenerationEvent, { type: "lead-remove" }> =>
        event.type === "lead-remove",
    );
    expect(removes.map((event) => event.packageName)).toEqual(["com.example.budget"]);
    expect(harness.updates().some((app) => app.packageName === "com.example.budget")).toBe(false);
    expect(result.stats.matched).toBe(1);
    expect(result.message).toContain("Only 1 matching app was found");
  });

  it("hands back a resumable cursor when the time budget is already spent", async () => {
    const harness = collect();
    const client = makeFakeClient({ search: () => searchRoutes(), detail: detailRoute });

    const result = await runGenerationStep({
      filters: filters(),
      cursor: createInitialCursor(KEYWORD),
      budgetMs: 10,
      emit: harness.emit,
      client,
    });

    expect(result.reason).toBe("budget-exhausted");
    expect(result.cursor).not.toBeNull();
    expect(result.cursor?.phase).toBe("suggest");
    expect(harness.leads()).toHaveLength(0);

    const resumed = await runGenerationStep({
      filters: filters(),
      cursor: result.cursor!,
      budgetMs: 8_000,
      emit: harness.emit,
      client,
    });
    expect(resumed.reason).toBe("target-reached");
    expect(harness.leads()).toHaveLength(2);
  });

  it("collects keyword-preserving suggestions before searching", async () => {
    const harness = collect();
    const client = makeFakeClient({
      search: () => searchRoutes(),
      detail: detailRoute,
      suggest: () => ["family budget tracker", "budget ledger tracker"],
    });
    const cursor = createInitialCursor(KEYWORD);

    await runGenerationStep({
      filters: filters({ limit: 1 }),
      cursor,
      budgetMs: 8_000,
      emit: harness.emit,
      client,
    });

    expect(cursor.suggestions).toEqual(
      expect.arrayContaining(["family budget tracker", "budget ledger tracker"]),
    );
    expect(cursor.suggestions.every((label) => keepsKeyword(KEYWORD, label))).toBe(true);
    const queries = buildPlanQueries(KEYWORD, cursor.suggestions);
    expect(queries.some((item) => item.kind === "suggestion")).toBe(true);
    expect(queries.length).toBeLessThanOrEqual(
      buildPlanQueries(KEYWORD, []).length + MAX_SUGGESTION_QUERIES,
    );
  });

  it("wraps up early when the caller aborts", async () => {
    const harness = collect();
    const client = makeFakeClient({ search: () => searchRoutes(), detail: detailRoute });

    const result = await runGenerationStep({
      filters: filters(),
      cursor: createInitialCursor(KEYWORD),
      budgetMs: 8_000,
      emit: harness.emit,
      client,
      aborted: () => true,
    });

    expect(result.reason).toBe("budget-exhausted");
    expect(client.requests).toBe(0);
  });

  it("reports a hard failure when Play's markup can no longer be read", async () => {
    const harness = collect();
    const client = makeFakeClient({ search: () => "<html><body>consent wall</body></html>" });

    const result = await runGenerationStep({
      filters: filters(),
      cursor: createInitialCursor(KEYWORD),
      budgetMs: 8_000,
      emit: harness.emit,
      client,
    });

    expect(result.reason).toBe("failed");
    expect(result.cursor).toBeNull();
    expect(result.message).toContain("page structure");
  });

  it("keeps counters consistent across a resume", async () => {
    const client = makeFakeClient({ search: () => searchRoutes(), detail: detailRoute });
    const first = collect();

    const partial = await runGenerationStep({
      filters: filters({ limit: 1 }),
      cursor: createInitialCursor(KEYWORD),
      budgetMs: 10,
      emit: first.emit,
      client,
    });

    expect(partial.reason).toBe("budget-exhausted");
    expect(partial.cursor!.counters.evaluated).toBe(0);
    expect(partial.cursor!.counters.requests).toBe(0);

    const second = collect();
    const resumed = await runGenerationStep({
      filters: filters({ limit: 1 }),
      cursor: partial.cursor!,
      budgetMs: 8_000,
      emit: second.emit,
      client,
    });

    expect(resumed.reason).toBe("target-reached");
    expect(partial.cursor!.counters.requests).toBeGreaterThan(0);
    expect(partial.cursor!.counters.evaluated).toBeGreaterThan(0);
    expect(second.events.some((event) => event.type === "lead")).toBe(true);
  });

  it("emits progress messages that describe the current step", async () => {
    const harness = collect();
    const client = makeFakeClient({ search: () => searchRoutes(), detail: detailRoute });

    await runGenerationStep({
      filters: filters(),
      cursor: createInitialCursor(KEYWORD),
      budgetMs: 8_000,
      emit: vi.fn().mockImplementation(harness.emit),
      client,
    });

    const messages = harness.messages();
    expect(messages.some((message) => message.includes("Searching Play Store"))).toBe(true);
    expect(messages.some((message) => message.includes("Fetching details"))).toBe(true);
  });

  it("keeps generating through fresh query waves when the base plan runs dry", async () => {
    const harness = collect();
    const client = makeFakeClient({ search: () => searchRoutes(), detail: detailRoute });
    const cursor = createInitialCursor(KEYWORD);
    // A run that already walked the whole base plan but is far below the limit.
    cursor.phase = "search";
    cursor.planIndex = planSize(buildPlanQueries(KEYWORD));
    cursor.counters.discovered = 5;
    cursor.counters.evaluated = 5;
    cursor.seen = [
      "com.example.budget",
      "com.example.budget.mini",
      "com.example.famous",
      "com.example.huge",
      "com.example.zombie",
    ];

    const result = await runGenerationStep({
      filters: filters({ limit: 100 }),
      cursor,
      budgetMs: 8_000,
      emit: harness.emit,
      client,
    });

    expect(cursor.wave).toBe(1);
    expect(harness.messages().some((message) => message.includes("extending the query plan"))).toBe(true);
    expect(result.reason).toBe("plan-exhausted");
    expect(result.message).toContain("2 query waves");
    expect(result.message).toContain("Only 0 matching apps were found");
  });

  it("stops honestly when an extra wave finds nothing new", async () => {
    const harness = collect();
    const client = makeFakeClient({ search: () => searchRoutes(), detail: detailRoute });
    const cursor = createInitialCursor(KEYWORD);
    cursor.phase = "search";
    cursor.planIndex = planSize(buildPlanQueries(KEYWORD));
    cursor.counters.discovered = 5;
    cursor.counters.evaluated = 5;
    cursor.waveDiscovered = 5; // the last wave already ran with this many discoveries

    const result = await runGenerationStep({
      filters: filters({ limit: 100 }),
      cursor,
      budgetMs: 8_000,
      emit: harness.emit,
      client,
    });

    expect(cursor.wave).toBe(0);
    expect(harness.messages().some((message) => message.includes("extending the query plan"))).toBe(false);
    expect(result.reason).toBe("plan-exhausted");
    expect(result.message).not.toContain("query waves");
  });

  it("removes a lead whose detail page now returns 404", async () => {
    const harness = collect();
    const client = makeFakeClient({
      search: () => searchRoutes(),
      detail: (packageName) => {
        if (packageName === "com.example.budget") {
          throw new PlayHttpError("Play Store responded with 404.", 404, false);
        }
        return detailRoute(packageName);
      },
    });

    const result = await runGenerationStep({
      filters: filters({ limit: 10 }),
      cursor: createInitialCursor(KEYWORD),
      budgetMs: 8_000,
      emit: harness.emit,
      client,
    });

    const removes = harness.events.filter(
      (event): event is Extract<GenerationEvent, { type: "lead-remove" }> =>
        event.type === "lead-remove",
    );
    expect(removes.map((event) => event.packageName)).toEqual(["com.example.budget"]);
    expect(
      harness.events.some(
        (event) => event.type === "warning" && event.message.includes("no longer lists"),
      ),
    ).toBe(true);
    expect(result.stats.matched).toBe(1);
    expect(result.reason).toBe("plan-exhausted");
  });
});