import { describe, expect, it } from "vitest";
import { PlayClient } from "@/lib/playstore/client";
import { PLAN_LOCALES } from "@/lib/playstore/queryPlan";
import { searchApps } from "@/lib/playstore/search";

const live = process.env.PLAY_LIVE === "1";
const KEYWORD = "budget tracker";

const CORE_LOCALES = ["US", "GB", "CA", "AU", "IN", "PK", "ID", "BR", "NG", "DE", "JP", "FR"];

describe.skipIf(!live)("research 2", () => {
  it(
    "R6 measures how much each storefront and query adds",
    { timeout: 300_000 },
    async () => {
      const client = new PlayClient({ concurrency: 4, intervalMs: 200, retries: 1 });
      const queries = [
        KEYWORD,
        `"${KEYWORD}"`,
        `${KEYWORD} app`,
        `${KEYWORD} old`,
        `${KEYWORD} lite`,
      ];

      const byPkg = new Map<string, Set<string>>();
      const perLocale = new Map<string, number>();
      const perQuery = new Map<string, number>();
      let requests = 0;

      for (const query of queries) {
        await Promise.all(
          PLAN_LOCALES.map(async (locale) => {
            try {
              const res = await searchApps(client, {
                query,
                hl: locale.hl,
                gl: locale.gl,
                price: locale.price,
              });
              requests += 1;
              for (const app of res.apps) {
                const key = `${query}|${locale.gl}|${locale.hl}|${locale.price ?? "all"}`;
                const entry = byPkg.get(app.packageName) ?? new Set<string>();
                entry.add(key);
                byPkg.set(app.packageName, entry);
                perLocale.set(locale.gl, (perLocale.get(locale.gl) ?? 0) + 1);
                perQuery.set(query, (perQuery.get(query) ?? 0) + 1);
              }
            } catch {
              requests += 1;
            }
          }),
        );
      }

      const total = byPkg.size;
      const core = [...byPkg.keys()].filter((pkg) =>
        [...byPkg.get(pkg)!].some((key) => CORE_LOCALES.includes(key.split("|")[1])),
      );
      const coreFirst = queries
        .slice(0, 3)
        .flatMap((query) =>
          CORE_LOCALES.map((gl) => `${query}|${gl}|en|all`),
        );
      const coreFirstSet = new Set(coreFirst);
      const coreFirstUnique = [...byPkg.entries()].filter(([, keys]) =>
        [...keys].some((key) => coreFirstSet.has(key)),
      ).length;

      console.log(`[R6] requests=${requests} unique=${total}`);
      console.log(
        `[R6] core12=${core.length} (${((core.length / total) * 100).toFixed(1)}%) ` +
          `first3queriesx12locales=${coreFirstUnique} (${((coreFirstUnique / total) * 100).toFixed(1)}%)`,
      );
      console.log(
        `[R6] perLocale=${JSON.stringify([...perLocale.entries()].sort((a, b) => b[1] - a[1]))}`,
      );
      console.log(`[R6] perQuery=${JSON.stringify([...perQuery.entries()])}`);

      // Marginal unique apps contributed by each storefront, in plan order.
      const covered = new Set<string>();
      const marginalLocales: Array<[string, number]> = [];
      for (const locale of PLAN_LOCALES) {
        const suffix = `|${locale.gl}|${locale.hl}|${locale.price ?? "all"}`;
        let added = 0;
        for (const [pkg, keys] of byPkg) {
          if (covered.has(pkg)) continue;
          if ([...keys].some((key) => key.endsWith(suffix))) {
            covered.add(pkg);
            added += 1;
          }
        }
        marginalLocales.push([`${locale.gl}${locale.price ? `:${locale.price}` : ""}`, added]);
      }
      console.log(`[R6] marginalLocale=${JSON.stringify(marginalLocales)}`);

      const coveredQueries = new Set<string>();
      const marginalQueries: Array<[string, number]> = [];
      for (const query of queries) {
        let added = 0;
        for (const [pkg, keys] of byPkg) {
          if (coveredQueries.has(pkg)) continue;
          if ([...keys].some((key) => key.startsWith(`${query}|`))) {
            coveredQueries.add(pkg);
            added += 1;
          }
        }
        marginalQueries.push([query, added]);
      }
      console.log(`[R6] marginalQuery=${JSON.stringify(marginalQueries)}`);

      expect(total).toBeGreaterThan(50);
    },
  );

  it(
    "R7 measures achievable request throughput",
    { timeout: 300_000 },
    async () => {
      const configs = [
        { name: "c4-i250", concurrency: 4, intervalMs: 250 },
        { name: "c6-i150", concurrency: 6, intervalMs: 150 },
        { name: "c8-i120", concurrency: 8, intervalMs: 120 },
      ];
      const total = 60;

      for (const config of configs) {
        const client = new PlayClient({
          concurrency: config.concurrency,
          intervalMs: config.intervalMs,
          retries: 1,
        });
        const startedAt = Date.now();
        let ok = 0;
        let failed = 0;
        const work: Promise<void>[] = [];
        for (let index = 0; index < total; index += 1) {
          const query = `${KEYWORD} ${index % 2 === 0 ? "app" : "free"} ${index}`;
          work.push(
            client
              .get(`https://play.google.com/store/search?c=apps&q=${encodeURIComponent(query)}&hl=en&gl=US`)
              .then(
                () => {
                  ok += 1;
                },
                () => {
                  failed += 1;
                },
              ),
          );
        }
        await Promise.all(work);
        const seconds = (Date.now() - startedAt) / 1000;
        console.log(
          `[R7] ${config.name} ok=${ok} failed=${failed} seconds=${seconds.toFixed(1)} ` +
            `rate=${(ok / seconds).toFixed(2)} req/s`,
        );
        expect(ok).toBeGreaterThan(total / 2);
      }
    },
  );
});
