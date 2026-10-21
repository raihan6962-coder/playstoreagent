import { describe, expect, it } from "vitest";
import { tokenizeKeyword } from "@/lib/filters/relevance";
import { PlayClient } from "@/lib/playstore/client";
import { fetchAppDetail } from "@/lib/playstore/detail";
import { createInitialCursor, runGenerationStep } from "@/lib/playstore/crawler";
import { searchApps } from "@/lib/playstore/search";
import type { GenerationEvent, Lead } from "@/types/lead";

/**
 * Live checks against the real Play Store. They are skipped unless PLAY_LIVE=1
 * so the default `npm test` run stays offline and deterministic.
 *
 *   PLAY_LIVE=1 npm test
 */
const LIVE = process.env.PLAY_LIVE === "1";

const liveDescribe = describe.skipIf(!LIVE);

function satisfied(lead: Lead, keyword: string, maxRating: number, maxInstalls: number): boolean {
  const terms = tokenizeKeyword(keyword).significant;
  return (
    lead.rating !== null &&
    lead.rating <= maxRating &&
    lead.installs !== null &&
    lead.installs <= maxInstalls &&
    terms.every((term) => lead.relevanceTerms.includes(term))
  );
}

liveDescribe("live Play Store", () => {
  it(
    "parses a real search results page",
    async () => {
      const client = new PlayClient();
      const result = await searchApps(client, { query: "budget tracker" });

      expect(result.apps.length).toBeGreaterThan(0);
      expect(result.apps[0].packageName).toContain(".");
      expect(result.apps[0].title.length).toBeGreaterThan(0);
      expect(result.apps.some((app) => app.rating !== null)).toBe(true);
      expect(result.apps.some((app) => app.installs !== null)).toBe(true);
      expect(result.buildLabel).toContain("boq_");
    },
    60_000,
  );

  it(
    "parses a real app detail page",
    async () => {
      const client = new PlayClient();
      const search = await searchApps(client, { query: "budget tracker" });
      const packageName = search.apps[0].packageName;

      const detail = await fetchAppDetail(client, packageName);

      expect(detail.app?.packageName).toBe(packageName);
      expect(detail.app?.title.length).toBeGreaterThan(0);
      expect(detail.app?.ratingsCount).not.toBeNull();
    },
    60_000,
  );

  it(
    "reads a real listing's first-release date",
    async () => {
      const client = new PlayClient();
      // A listing the store tracks a release date for.
      const detail = await fetchAppDetail(client, "com.jvnconsultancy.writebengalialphabet");

      expect(detail.app?.releasedAt).not.toBeNull();
      const released = detail.app?.releasedAt ?? 0;
      // A plausible date in the past, not in the future and not in 1970.
      expect(released).toBeGreaterThan(Date.UTC(2020, 0, 1));
      expect(released).toBeLessThan(Date.now());
      console.log(`[live] released ${new Date(released).toISOString().slice(0, 10)}`);
    },
    60_000,
  );

  it(
    "has no release date for a listing the store no longer dates",
    async () => {
      const client = new PlayClient();
      // Listed in 2011: Play leaves the release row empty for listings this old.
      const detail = await fetchAppDetail(client, "com.google.android.apps.translate");
      expect(detail.app?.releasedAt).toBeNull();
    },
    60_000,
  );

  it(
    "runs a small end-to-end generation against the live store",
    async () => {
      const maxRating = 4;
      const maxInstalls = 1_000_000;
      const limit = 3;
      const leads: Lead[] = [];
      const events: GenerationEvent[] = [];

      const result = await runGenerationStep({
        filters: { keyword: "budget tracker", maxRating, maxInstalls, limit, country: "US" },
        cursor: createInitialCursor("budget tracker"),
        // A production run harvests a thousand cards before it filters any of
        // them; a live probe has seconds, not minutes, so it uses a small
        // floor to reach the filter stage at all.
        harvestTarget: 60,
        budgetMs: 75_000,
        emit: (event) => {
          events.push(event);
          if (event.type === "lead") leads.push(event.lead);
        },
      });

      console.log(
        `[live] reason=${result.reason} discovered=${result.stats.discovered} ` +
          `collected=${result.stats.collected} evaluated=${result.stats.evaluated} ` +
          `matched=${result.stats.matched} ` +
          `queries=${result.stats.queriesRun}/${result.stats.queriesTotal} ` +
          `lowestRating=${result.stats.lowestRatingSeen}`,
      );

      expect(result.stats.discovered).toBeGreaterThan(0);
      expect(result.stats.evaluated).toBeGreaterThan(0);
      expect(events.some((event) => event.type === "progress")).toBe(true);
      for (const lead of leads) {
        expect(satisfied(lead, "budget tracker", maxRating, maxInstalls)).toBe(true);
      }
    },
    120_000,
  );
});
