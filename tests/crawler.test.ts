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
  // An irrelevant listing keeps its own text on its own page: only fetching
  // it (description rescue) would ever read it, and it still must not pass.
  const summary =
    main.packageName === IRRELEVANT.packageName ? "Run from the undead horde" : "Track your budget";
  return detailHtml(
    { ...main, summary },
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

  it("verifies a candidate against its country's detail page before showing it", async () => {
    const harness = collect();
    const client = makeFakeClient({ search: () => searchRoutes(), detail: detailRoute });

    await runGenerationStep({
      filters: filters(),
      cursor: createInitialCursor(KEYWORD),
      budgetMs: 8_000,
      emit: harness.emit,
      client,
    });

    const leads = harness.leads();
    expect(leads).toHaveLength(2);
    // The table shows what the detail page (this run's country) reports: the
    // ratings count is already there when the row appears.
    expect(leads.every((lead) => lead.ratingsCount === 57)).toBe(true);
    expect(leads.every((lead) => lead.rating !== null)).toBe(true);
    // Nothing was ever shown and then taken back.
    expect(harness.events.filter((event) => event.type === "lead-remove")).toHaveLength(0);
  });

  it("never shows a lead whose detail page reports a rating above the ceiling", async () => {
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

    // The lead never became a lead: verification rejected it before the first
    // emission, so there is nothing to retract.
    expect(harness.leads().map((lead) => lead.packageName)).toEqual(["com.example.budget.mini"]);
    expect(harness.events.filter((event) => event.type === "lead-remove")).toHaveLength(0);
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

  it("never shows a lead whose detail page returns 404", async () => {
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

    // The app was gone before it was ever shown: no row, no retraction.
    expect(harness.leads().map((lead) => lead.packageName)).toEqual(["com.example.budget.mini"]);
    expect(harness.events.filter((event) => event.type === "lead-remove")).toHaveLength(0);
    expect(result.stats.matched).toBe(1);
    expect(result.reason).toBe("plan-exhausted");
  });

  it("verifies pending candidates before reporting the plan exhausted", async () => {
    const harness = collect();
    const client = makeFakeClient({ search: () => searchRoutes(), detail: detailRoute });
    const cursor = createInitialCursor(KEYWORD);
    // A resumed session whose plan ran dry while candidates were still queued:
    // the terminal decision must not discard them.
    cursor.phase = "enrich";
    cursor.pendingQueue = [
      { p: "com.example.budget", i: 10_000, s: "Track your budget" },
      { p: "com.example.budget.mini", i: 5_000, s: "Track your budget" },
    ];
    cursor.seen = ["com.example.budget", "com.example.budget.mini"];
    cursor.counters.discovered = 5;
    cursor.counters.evaluated = 5;

    const result = await runGenerationStep({
      filters: filters({ limit: 50 }),
      cursor,
      budgetMs: 8_000,
      emit: harness.emit,
      client,
    });

    expect(harness.leads().map((lead) => lead.packageName).sort()).toEqual([
      "com.example.budget",
      "com.example.budget.mini",
    ]);
    expect(cursor.pendingQueue).toHaveLength(0);
    expect(result.stats.matched).toBe(2);
    expect(result.reason).toBe("plan-exhausted");
    expect(result.cursor).toBeNull();
  });

  it("never fetches a foreign match printed in the drift dead band", async () => {
    const harness = collect();
    const fetched: string[] = [];
    const client = makeFakeClient({
      search: () => searchRoutes(),
      detail: (packageName: string) => {
        fetched.push(packageName);
        // No similar-app walk: the only way GOOD_TWO can enter the queues is
        // the foreign search card that should now reject it outright.
        const entry = [GOOD, GOOD_TWO, TOO_POPULAR_RATING, TOO_MANY_INSTALLS, IRRELEVANT].find(
          (item) => item.packageName === packageName,
        );
        if (!entry) return searchHtml([]);
        return detailHtml(
          { ...entry, summary: entry.packageName === IRRELEVANT.packageName ? "Run from the undead horde" : "Track your budget" },
          [],
          entry.installs ?? "10,000+",
        );
      },
    });

    const cursor = createInitialCursor(KEYWORD);
    cursor.phase = "search";
    // Index 1 of the sweep for country US is a foreign storefront (US owns
    // index 0), so every search card is read abroad: GOOD_TWO printed 2.7
    // sits in the dead band between the 2.5 half-star line and the 3.0
    // ceiling (research R9: foreign cards there passed 0 of 2 at home).
    cursor.planIndex = 1;

    const result = await runGenerationStep({
      filters: filters({ limit: 50 }),
      cursor,
      budgetMs: 8_000,
      emit: harness.emit,
      client,
    });

    // GOOD_TWO's dead-band card must never verify into a row. (It may still
    // be *fetched* as an expansion seed — rated relevant cards seed the
    // similar-app walk — but a seed's detail never emits a lead by itself.)
    expect(harness.leads().map((lead) => lead.packageName)).toEqual(["com.example.budget"]);
    expect(result.stats.matched).toBe(1);
  });

  it("verifies home-storefront matches ahead of foreign ones", async () => {
    const harness = collect();
    const fetched: string[] = [];
    const client = makeFakeClient({
      search: () => searchRoutes(),
      detail: (packageName: string) => {
        fetched.push(packageName);
        // No similar-app walk: only the two hand-queued matches are fetched,
        // so the fetch order below is exactly the verify order.
        const entry = [GOOD, TOO_POPULAR_RATING].find((item) => item.packageName === packageName);
        if (!entry) return searchHtml([]);
        return detailHtml({ ...entry, summary: "Track your budget" }, [], entry.installs ?? "10,000+");
      },
    });

    const cursor = createInitialCursor(KEYWORD);
    cursor.phase = "enrich";
    // Foreign match queued first, home match second: the home card's rating
    // is already final (research R6b: 2 of 2 verified), so it must be pulled
    // before the foreign one still carrying drift risk.
    cursor.pendingQueue = [
      { p: "com.example.famous", i: 10_000, s: "Track your budget" },
      { p: "com.example.budget", i: 10_000, s: "Track your budget", h: true },
    ];
    cursor.seen = ["com.example.famous", "com.example.budget"];
    cursor.counters.discovered = 2;
    cursor.counters.evaluated = 2;

    const result = await runGenerationStep({
      filters: filters({ limit: 50 }),
      cursor,
      budgetMs: 8_000,
      emit: harness.emit,
      client,
    });

    expect(fetched[0]).toBe("com.example.budget");
    expect(harness.leads().map((lead) => lead.packageName)).toEqual(["com.example.budget"]);
    expect(result.stats.matched).toBe(1);
    expect(cursor.pendingQueue).toHaveLength(0);
    expect(result.reason).toBe("plan-exhausted");
    expect(result.cursor).toBeNull();
  });

  it("keeps every shown lead when a step wraps up and the next one resumes", async () => {
    const client = makeFakeClient({ search: () => searchRoutes(), detail: detailRoute });
    const first = collect();

    // Spend the whole budget inside the search phase with a match already
    // queued for verification: the step must come back resumable instead of
    // dropping the candidate or emitting it unverified.
    const cursor = createInitialCursor(KEYWORD);
    cursor.phase = "search";
    const partial = await runGenerationStep({
      filters: filters({ limit: 50 }),
      cursor,
      budgetMs: 1,
      emit: first.emit,
      client,
    });

    expect(partial.reason).toBe("budget-exhausted");
    expect(partial.cursor).not.toBeNull();
    expect(first.leads()).toHaveLength(0);

    const second = collect();
    const resumed = await runGenerationStep({
      filters: filters({ limit: 50 }),
      cursor: partial.cursor!,
      budgetMs: 8_000,
      emit: second.emit,
      client,
    });

    const allEvents = [...first.events, ...second.events];
    expect(allEvents.filter((event) => event.type === "lead-remove")).toHaveLength(0);
    expect(second.leads().length).toBeGreaterThan(0);
    expect(resumed.reason).toBe("plan-exhausted");
    expect(resumed.stats.matched).toBe(second.leads().length);
  });

  it("recovers a partial keyword match from the detail page's full description", async () => {
    // The card proves "crypto" but not "wallet": dropped at card level before,
    // the listing's description completes the keyword once fetched.
    const PARTIAL = {
      packageName: "com.example.cryptokeep",
      title: "Crypto Keeper",
      rating: "2.3",
      ratingValue: 2.3,
      installs: "10,000+",
      summary: "Cold storage",
    };
    const harness = collect();
    const client = makeFakeClient({
      search: () => searchHtml([makeAppEntry(PARTIAL)]),
      detail: () =>
        detailHtml(
          { ...PARTIAL, summary: "A crypto wallet for cold storage", email: "hi@cryptokeep.io" },
          [],
          "10,000+",
        ),
    });

    const result = await runGenerationStep({
      filters: filters({ keyword: "crypto wallet", limit: 10 }),
      cursor: createInitialCursor("crypto wallet"),
      budgetMs: 8_000,
      emit: harness.emit,
      client,
    });

    const leads = harness.leads();
    expect(leads.map((lead) => lead.packageName)).toContain("com.example.cryptokeep");
    expect(result.stats.candidates).toBeGreaterThan(0);
    expect(result.stats.verifyRejected).toBe(0);
    expect(result.stats.matched).toBe(1);
    expect(result.reason).toBe("plan-exhausted");
    // The contact email rides along with the verified lead.
    expect(leads[0].email).toBe("hi@cryptokeep.io");
    expect(harness.events.filter((event) => event.type === "lead-remove")).toHaveLength(0);
  });

  it("fetches a zero-term card whose numbers pass to read its description", async () => {
    // Play returned this listing for the query, but the card's own truncated
    // text (title + snippet) carries no keyword term — only the detail page's
    // full description can prove relevance, and both printed numbers already
    // pass, so the card is worth exactly one fetch.
    const NO_CARD_TERMS = {
      packageName: "com.example.ledgerly",
      title: "Ledgerly",
      rating: "2.9",
      ratingValue: 2.9,
      installs: "50,000+",
      summary: "Manage your money",
    };
    const harness = collect();
    const client = makeFakeClient({
      search: () => searchHtml([makeAppEntry(NO_CARD_TERMS)]),
      detail: () =>
        detailHtml(
          { ...NO_CARD_TERMS, summary: "A crypto wallet for careful people" },
          [],
          "50,000+",
        ),
    });

    const result = await runGenerationStep({
      filters: filters({ keyword: "crypto wallet", limit: 10 }),
      cursor: createInitialCursor("crypto wallet"),
      budgetMs: 8_000,
      emit: harness.emit,
      client,
    });

    expect(harness.leads().map((lead) => lead.packageName)).toContain("com.example.ledgerly");
    expect(result.stats.candidates).toBeGreaterThan(0);
    expect(result.stats.verifyRejected).toBe(0);
    expect(result.stats.matched).toBe(1);
    expect(result.reason).toBe("plan-exhausted");
  });

  it("never queues a zero-term card whose printed numbers are already hopeless", async () => {
    // The description rescue only fires when both ceilings pass on the card:
    // a zero-term listing rated 4.6 under a 3.0 ceiling is a known miss on
    // every storefront, so no request is spent proving it again.
    const HOPELESS = {
      packageName: "com.example.ledgerly.premium",
      title: "Ledgerly Premium",
      rating: "4.6",
      ratingValue: 4.6,
      installs: "50,000+",
      summary: "Manage your money",
    };
    const harness = collect();
    const client = makeFakeClient({
      search: () => searchHtml([makeAppEntry(HOPELESS)]),
      detail: () => detailHtml({ ...HOPELESS, summary: "A crypto wallet for careful people" }),
    });

    const result = await runGenerationStep({
      filters: filters({ keyword: "crypto wallet", limit: 10 }),
      cursor: createInitialCursor("crypto wallet"),
      budgetMs: 8_000,
      emit: harness.emit,
      client,
    });

    expect(harness.leads()).toHaveLength(0);
    expect(result.stats.candidates).toBe(0);
    expect(result.stats.verifyRejected).toBe(0);
    expect(result.stats.matched).toBe(0);
    expect(result.reason).toBe("plan-exhausted");
  });

  it("never shows a partial match whose detail page still lacks the full keyword", async () => {
    const PARTIAL = {
      packageName: "com.example.cryptokeep",
      title: "Crypto Keeper",
      rating: "2.3",
      ratingValue: 2.3,
      installs: "10,000+",
      summary: "Cold storage",
    };
    const harness = collect();
    const client = makeFakeClient({
      search: () => searchHtml([makeAppEntry(PARTIAL)]),
      // The description still never says "wallet": the fetch settles it as a
      // reject, and the row must never appear.
      detail: () => detailHtml({ ...PARTIAL, summary: "Cold storage only" }, [], "10,000+"),
    });

    const result = await runGenerationStep({
      filters: filters({ keyword: "crypto wallet", limit: 10 }),
      cursor: createInitialCursor("crypto wallet"),
      budgetMs: 8_000,
      emit: harness.emit,
      client,
    });

    expect(harness.leads()).toHaveLength(0);
    expect(result.stats.candidates).toBeGreaterThan(0);
    expect(result.stats.verifyRejected).toBeGreaterThan(0);
    expect(result.stats.matched).toBe(0);
    expect(result.reason).toBe("plan-exhausted");
  });

  it("verifies a fully relevant card whose rating the search card could not report", async () => {
    // Some cards print no rating at all: the card is relevant and the
    // installs pass, but without a number the old flow never verified it.
    const NO_CARD_RATING = {
      packageName: "com.example.budget.dark",
      title: "Budget Tracker Dark",
      rating: null,
      ratingValue: 2.4,
      installs: "10,000+",
    };
    const harness = collect();
    const client = makeFakeClient({
      search: () => searchHtml([makeAppEntry(NO_CARD_RATING)]),
      detail: () =>
        detailHtml({ ...NO_CARD_RATING, summary: "Track your budget" }, [], "10,000+"),
    });

    const result = await runGenerationStep({
      filters: filters({ limit: 10 }),
      cursor: createInitialCursor(KEYWORD),
      budgetMs: 8_000,
      emit: harness.emit,
      client,
    });

    expect(harness.leads().map((lead) => lead.packageName)).toEqual(["com.example.budget.dark"]);
    expect(result.stats.candidates).toBeGreaterThan(0);
    expect(result.stats.verifyRejected).toBe(0);
  });

  it("queues unrated home cards behind rated ones", async () => {
    // Live runs measured 521 unrated fetches spending the verify budget ahead
    // of rated candidates: unrated cards may still get their one authoritative
    // fetch, but never in front of a card that can pass today.
    const UNRATED = {
      packageName: "com.example.crypto.unrated",
      title: "Crypto Keeper Dark",
      rating: null,
      ratingValue: null,
      installs: "10,000+",
      summary: "Cold storage",
    };
    const RATED = {
      packageName: "com.example.crypto.rated",
      title: "Crypto Keeper",
      rating: "2.3",
      ratingValue: 2.3,
      installs: "10,000+",
      summary: "Cold storage",
    };
    const harness = collect();
    const client = makeFakeClient({
      search: () => searchHtml([makeAppEntry(UNRATED), makeAppEntry(RATED)]),
      // Every detail fetch fails as a transport error: the entries stay
      // queued (pendingRetried only defers them) so the order is readable.
      detail: () => {
        throw new Error("network down");
      },
    });

    const result = await runGenerationStep({
      filters: filters({ keyword: "crypto wallet", limit: 10 }),
      cursor: createInitialCursor("crypto wallet"),
      budgetMs: 8_000,
      emit: harness.emit,
      client,
    });

    expect(result.cursor?.candidateQueue.map((entry) => entry.p)).toEqual([
      "com.example.crypto.rated",
      "com.example.crypto.unrated",
    ]);
    expect(result.stats.homeQueued).toBe(2);
  });

  it("rejects a match whose detail page carries no text of its own", async () => {
    // The card snippet read as a full match ("budget tracker" in the summary),
    // but the detail page arrives with numbers only — no JSON-LD description,
    // no AF summary. Falling back to the card's snippet there let a live run
    // emit an "Alice's Hotel" lead for "wallet" whose real listing never said
    // the word; the detail page must confirm the text itself or the entry
    // rejects.
    const CARD = {
      packageName: "com.example.cash.helper",
      title: "Cash Helper",
      rating: "2.5",
      ratingValue: 2.5,
      installs: "10,000+",
      summary: "Track your budget tracker monthly",
    };
    const harness = collect();
    const client = makeFakeClient({
      search: () => searchHtml([makeAppEntry(CARD)]),
      detail: () =>
        detailHtml({ ...CARD, summary: null }).replace(
          /<script type="application\/ld\+json"[^>]*>[\s\S]*?<\/script>/,
          "",
        ),
    });

    const result = await runGenerationStep({
      filters: filters({ limit: 10 }),
      cursor: createInitialCursor(KEYWORD),
      budgetMs: 8_000,
      emit: harness.emit,
      client,
    });

    expect(harness.leads()).toHaveLength(0);
    expect(result.stats.verifyTextRejected).toBeGreaterThan(0);
    expect(result.stats.matched).toBe(0);
  });
});