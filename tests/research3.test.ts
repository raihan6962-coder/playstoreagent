import { describe, expect, it } from "vitest";
import { PlayClient } from "@/lib/playstore/client";
import { fetchAppDetail } from "@/lib/playstore/detail";
import { searchApps } from "@/lib/playstore/search";
import { evaluateApp } from "@/lib/filters/leadFilter";
import type { LeadFilters, StoreApp } from "@/types/lead";

const live = process.env.PLAY_LIVE === "1";

const KEYWORD = "budget tracker";
const PROFILES: LeadFilters[] = [
  { keyword: KEYWORD, maxRating: 4, maxInstalls: 500_000, limit: 1_000, country: "US" },
  { keyword: KEYWORD, maxRating: 4.5, maxInstalls: 5_000_000, limit: 1_000, country: "US" },
];

describe.skipIf(!live)("research 3", () => {
  it(
    "R8 measures the yield of walking 'similar apps' from small leads",
    { timeout: 300_000 },
    async () => {
      const client = new PlayClient({ concurrency: 6, intervalMs: 180, retries: 1 });

      // Seed from one search: the smallest, lowest rated apps are the best seeds.
      const seeds = new Map<string, StoreApp>();
      for (const gl of ["US", "GB", "IN", "ID", "BR", "NG"]) {
        const res = await searchApps(client, { query: KEYWORD, hl: "en", gl });
        for (const app of res.apps) {
          if (app.installs === null) continue;
          const existing = seeds.get(app.packageName);
          if (!existing || (app.installs ?? Infinity) < (existing.installs ?? Infinity)) {
            seeds.set(app.packageName, app);
          }
        }
      }

      const ranked = [...seeds.values()]
        .filter((app) => app.installs !== null && app.installs <= 500_000)
        .sort((a, b) => (a.installs ?? 0) - (b.installs ?? 0))
        .slice(0, 16);

      console.log(`[R8] seeds=${ranked.length} (small apps from ${seeds.size} search results)`);

      const similar = new Map<string, StoreApp>();
      let details = 0;
      await Promise.all(
        ranked.map(async (app) => {
          try {
            const detail = await fetchAppDetail(client, app.packageName);
            details += 1;
            for (const related of detail.similarApps) {
              similar.set(related.packageName, related);
            }
          } catch (error) {
            console.log(`[R8] detail failed ${app.packageName}: ${error instanceof Error ? error.message : error}`);
          }
        }),
      );

      console.log(`[R8] detailRequests=${details} similarUnique=${similar.size}`);

      for (const profile of PROFILES) {
        const seen = new Set<string>();
        let matches = 0;
        for (const app of similar.values()) {
          const evaluation = evaluateApp(app, profile, seen);
          seen.add(app.packageName);
          if (evaluation.status === "match") matches += 1;
        }
        console.log(
          `[R8] profile maxRating=${profile.maxRating} maxInstalls=${profile.maxInstalls}: ` +
            `matches=${matches}/${similar.size} perDetailRequest=${(matches / Math.max(details, 1)).toFixed(3)}`,
        );
      }

      expect(details).toBeGreaterThan(0);
      expect(similar.size).toBeGreaterThan(details);
    },
  );
});
