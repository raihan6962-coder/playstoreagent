import { describe, expect, it } from "vitest";
import { evaluateApp } from "@/lib/filters/leadFilter";
import { createInitialCursor, runGenerationStep } from "@/lib/playstore/crawler";
import type { Lead, LeadFilters, SessionCursor, StoreApp } from "@/types/lead";

const live = process.env.PLAY_LIVE === "1";

const KEYWORD = "budget tracker";
const FILTERS: LeadFilters = {
  keyword: KEYWORD,
  maxRating: 4,
  maxInstalls: 500_000,
  limit: 1_000,
};

describe.skipIf(!live)("live scale run", () => {
  it(
    "collects leads across resumed steps without ever breaking the rules",
    { timeout: 300_000 },
    async () => {
      const leads: Lead[] = [];
      let cursor: SessionCursor | null = createInitialCursor(KEYWORD);
      const startedAt = Date.now();
      const stepBudgetMs = 70_000;
      let steps = 0;
      let requests = 0;
      let reason = "";
      let message = "";

      while (cursor && steps < 3 && Date.now() - startedAt < 240_000) {
        steps += 1;
        const result = await runGenerationStep({
          filters: FILTERS,
          cursor,
          budgetMs: stepBudgetMs,
          emit: (event) => {
            if (event.type === "lead") leads.push(event.lead);
          },
        });
        reason = result.reason;
        message = result.message;
        requests = result.stats.requests;
        console.log(
          `[scale] step ${steps} reason=${result.reason} requests=${result.stats.requests} ` +
            `queriesRun=${result.stats.queriesRun} pagesFetched=${result.stats.pagesFetched} ` +
            `discovered=${result.stats.discovered} evaluated=${result.stats.evaluated} ` +
            `duplicates=${result.stats.duplicates} matched=${result.stats.matched} ` +
            `suggestions=${result.cursor?.suggestions.length ?? "n/a"} planIndex=${result.cursor?.planIndex ?? "n/a"}`,
        );
        if (result.reason !== "budget-exhausted") break;
        cursor = result.cursor;
      }

      const seconds = (Date.now() - startedAt) / 1000;
      console.log(
        `[scale] reason=${reason} steps=${steps} leads=${leads.length} requests=${requests} ` +
          `seconds=${seconds.toFixed(1)} rate=${(requests / Math.max(seconds, 0.001)).toFixed(2)} req/s ` +
          `message="${message}"`,
      );

      expect(leads.length).toBeGreaterThan(0);
      expect(requests).toBeGreaterThan(0);
      expect(["budget-exhausted", "target-reached", "plan-exhausted"]).toContain(reason);

      const verified = new Set<string>();
      for (const lead of leads) {
        const storeApp: StoreApp = { ...lead };
        const evaluation = evaluateApp(storeApp, FILTERS, verified);

        if (verified.has(lead.packageName)) {
          expect(evaluation.reasons).toEqual(["duplicate"]);
        } else {
          expect(evaluation.status).toBe("match");
          expect(lead.rating).not.toBeNull();
          expect(lead.rating).toBeLessThanOrEqual(FILTERS.maxRating);
          expect(lead.installs).not.toBeNull();
          expect(lead.installs).toBeLessThanOrEqual(FILTERS.maxInstalls);
          expect(lead.relevanceScore).toBeGreaterThanOrEqual(50);
          expect(lead.keyword).toBe(KEYWORD);
          verified.add(lead.packageName);
        }
      }

      expect(requests / Math.max(seconds, 0.001)).toBeGreaterThan(1.5);
    },
  );
});
