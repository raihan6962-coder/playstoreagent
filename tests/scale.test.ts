import { describe, expect, it } from "vitest";
import { mergeLead } from "@/lib/client/generation";
import { evaluateApp, leadPassesFilters } from "@/lib/filters/leadFilter";
import { tokenizeKeyword } from "@/lib/filters/relevance";
import { PlayClient } from "@/lib/playstore/client";
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
      const emitted: Lead[] = [];
      const visible = new Map<string, Lead>();
      let cursor: SessionCursor | null = createInitialCursor(KEYWORD);
      // Same settings the server uses by default (see crawler.ts). The client
      // is recreated per step, exactly like the route does.
      let rateLimitHits = 0;
      const startedAt = Date.now();
      const stepBudgetMs = 70_000;
      let steps = 0;
      let requests = 0;
      let reason = "";
      let message = "";
      let removals = 0;
      let updates = 0;

      while (cursor && steps < 3 && Date.now() - startedAt < 240_000) {
        steps += 1;
        const client = new PlayClient({ concurrency: 8, intervalMs: 180 });
        const result = await runGenerationStep({
          filters: FILTERS,
          cursor,
          budgetMs: stepBudgetMs,
          client,
          emit: (event) => {
            // Mirror the dashboard: every event goes through the same guards
            // before a row can exist in the table (and the CSV).
            if (event.type === "lead") {
              emitted.push(event.lead);
              if (leadPassesFilters(event.lead, FILTERS)) {
                visible.set(event.lead.packageName, event.lead);
              }
            } else if (event.type === "lead-update") {
              updates += 1;
              const base = visible.get(event.app.packageName);
              if (!base) return;
              const merged = mergeLead(base, event.app);
              if (leadPassesFilters(merged, FILTERS)) {
                visible.set(merged.packageName, merged);
              } else {
                visible.delete(base.packageName);
                removals += 1;
              }
            } else if (event.type === "lead-remove") {
              if (visible.delete(event.packageName)) removals += 1;
            }
          },
        });
        reason = result.reason;
        message = result.message;
        requests = result.stats.requests;
        rateLimitHits += client.rateLimitHits;
        console.log(
          `[scale] step ${steps} reason=${result.reason} requests=${result.stats.requests} ` +
            `queriesRun=${result.stats.queriesRun} pagesFetched=${result.stats.pagesFetched} ` +
            `discovered=${result.stats.discovered} evaluated=${result.stats.evaluated} ` +
            `duplicates=${result.stats.duplicates} matched=${result.stats.matched} ` +
            `visible=${visible.size} updates=${updates} removals=${removals} ` +
            `suggestions=${result.cursor?.suggestions.length ?? "n/a"} planIndex=${result.cursor?.planIndex ?? "n/a"}`,
        );
        if (result.reason !== "budget-exhausted") break;
        cursor = result.cursor;
      }

      const seconds = (Date.now() - startedAt) / 1000;
      const rate = requests / Math.max(seconds, 0.001);
      console.log(
        `[scale] reason=${reason} steps=${steps} emitted=${emitted.length} ` +
          `visible=${visible.size} removals=${removals} requests=${requests} ` +
          `rateLimitHits=${rateLimitHits} ` +
          `seconds=${seconds.toFixed(1)} rate=${rate.toFixed(2)} req/s ` +
          `message="${message}"`,
      );

      expect(emitted.length).toBeGreaterThan(0);
      expect(visible.size).toBeGreaterThan(0);
      expect(requests).toBeGreaterThan(0);
      expect(["budget-exhausted", "target-reached", "plan-exhausted"]).toContain(reason);

      // Every lead the server emitted already satisfies the rules on its own…
      const verified = new Set<string>();
      const terms = tokenizeKeyword(KEYWORD).significant;
      for (const lead of emitted) {
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
          expect(terms.every((term) => lead.relevanceTerms.includes(term))).toBe(true);
          expect(lead.keyword).toBe(KEYWORD);
          verified.add(lead.packageName);
        }
      }

      // …and what the table still shows after detail-page merges is clean too.
      for (const lead of visible.values()) {
        expect(leadPassesFilters(lead, FILTERS)).toBe(true);
        expect(lead.rating).toBeLessThanOrEqual(FILTERS.maxRating);
        expect(lead.installs).toBeLessThanOrEqual(FILTERS.maxInstalls);
        expect(terms.every((term) => lead.relevanceTerms.includes(term))).toBe(true);
      }

      expect(rate).toBeGreaterThan(1.5);
    },
  );
});
