import { describe, expect, it } from "vitest";
import { PlayClient } from "@/lib/playstore/client";
import { fetchAppDetail } from "@/lib/playstore/detail";
import { searchApps } from "@/lib/playstore/search";
import { roundRating } from "@/lib/parser/rating";

const live = process.env.PLAY_LIVE === "1";
const KEYWORD = process.env.PROBE_KEYWORD || "budget tracker";
const COUNTRY = "BD";
const CEILING = 4;

function bandOf(card: number, countryFinal: boolean): string {
  if (countryFinal) return `home card <=${CEILING}`;
  if (card <= 3) return "foreign <=3.0";
  if (card <= 3.5) return "foreign (3.0,3.5]";
  if (card <= CEILING) return "foreign (3.5,4.0]";
  return `foreign >${CEILING}`;
}

describe.skipIf(!live)("band research", () => {
  it(
    "R9 verification pass rate per card-rating band",
    { timeout: 600_000 },
    async () => {
      const client = new PlayClient({ intervalMs: 150, retries: 1 });
      const queries = [
        KEYWORD,
        `${KEYWORD} app`,
        `${KEYWORD} free`,
        `${KEYWORD} lite`,
        `${KEYWORD} simple`,
        `${KEYWORD} a`,
        `${KEYWORD} b`,
        `${KEYWORD} old`,
        `${KEYWORD} tracker`,
        `${KEYWORD} expense`,
        `${KEYWORD} personal`,
        `${KEYWORD} small`,
      ];

      type Row = { card: number; home: number | null };
      const buckets = new Map<string, Map<string, Row>>();

      const sample = async (
        gl: string,
        countryFinal: boolean,
        budget: { foreign: number; home: number },
        seen: Set<string>,
      ): Promise<void> => {
        for (const query of queries) {
          const room = countryFinal ? budget.home : budget.foreign;
          if (room <= 0) return;
          let res;
          try {
            res = await searchApps(client, { query, hl: "en", gl });
          } catch {
            continue;
          }
          for (const app of res.apps) {
            if (seen.has(app.packageName)) continue;
            if (app.rating === null) continue;
            if (app.rating > CEILING) continue;
            const roomNow = countryFinal ? budget.home : budget.foreign;
            if (roomNow <= 0) return;
            seen.add(app.packageName);
            if (countryFinal) budget.home -= 1;
            else budget.foreign -= 1;

            const bucket = bandOf(app.rating, countryFinal);
            let map = buckets.get(bucket);
            if (!map) buckets.set(bucket, (map = new Map()));
            if (map.size >= 20) continue;

            let home: number | null = null;
            try {
              const detail = await fetchAppDetail(client, app.packageName, "en", COUNTRY);
              home = detail.app?.rating ?? null;
            } catch {
              // leave null: the verification would have failed too
            }
            map.set(app.packageName, { card: app.rating, home });
          }
        }
      };

      const seen = new Set<string>();
      await sample("US", false, { foreign: 45, home: 0 }, seen);
      await sample(COUNTRY, true, { foreign: 0, home: 15 }, seen);

      console.log(`[R9] ${KEYWORD}: BD verification pass rate by card band (ceiling ${CEILING}):`);
      for (const [bucket, map] of buckets) {
        const checked = [...map.values()].filter((row) => row.home !== null);
        const passed = checked.filter((row) => roundRating(row.home as number) <= CEILING);
        const sample6 = [...map.entries()]
          .slice(0, 6)
          .map(([pkg, row]) => `${pkg.replace(/^com\./, "")} c=${row.card} h=${row.home}`)
          .join(" | ");
        console.log(
          `[R9]   ${bucket}: ${passed.length}/${checked.length} pass (${((passed.length / Math.max(checked.length, 1)) * 100).toFixed(0)}%) -- ${sample6}`,
        );
      }
      expect([...buckets.values()].reduce((sum, map) => sum + map.size, 0)).toBeGreaterThan(2);
    },
  );
});
