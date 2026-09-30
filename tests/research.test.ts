import { describe, expect, it } from "vitest";
import { evaluateApp } from "@/lib/filters/leadFilter";
import { tokenizeKeyword } from "@/lib/filters/relevance";
import { PlayClient } from "@/lib/playstore/client";
import { fetchAppDetail } from "@/lib/playstore/detail";
import { searchApps } from "@/lib/playstore/search";
import { fetchSearchSuggestions } from "@/lib/playstore/suggest";
import type { StoreApp } from "@/types/lead";

const live = process.env.PLAY_LIVE === "1";
const KEYWORD = "crypto wallet";
const FILTERS = {
  keyword: KEYWORD,
  maxRating: 3,
  maxInstalls: 100_000,
  limit: 1000,
};
const SUFFIXES = "abcdefghijklmnopqrstuvwxyz".split("");

function passesRatingInstall(app: StoreApp): boolean {
  return app.rating !== null && app.rating <= 3 && app.installs !== null && app.installs <= 100_000;
}

describe.skipIf(!live)("research", () => {
  it("R1 suggestion breadth for long-tail planning", { timeout: 300_000 }, async () => {
      const client = new PlayClient();
      const tokens = tokenizeKeyword(KEYWORD).significant;
      const unique = new Set<string>();
      const byPrefix = new Map<string, number>();

      for (const suffix of SUFFIXES) {
        const prefix = `${KEYWORD} ${suffix}`;
        const sugg = await fetchSearchSuggestions(client, prefix, "en", "US", undefined, 10);
        byPrefix.set(prefix, sugg.length);
        for (const s of sugg) {
          const lower = s.toLowerCase();
          if (tokens.every((t) => lower.includes(t))) unique.add(s);
        }
      }
      console.log("[R1] keyword-preserving suggestions:", unique.size);
      console.log("[R1] sample:", [...unique].slice(0, 25));
      expect(unique.size).toBeGreaterThan(20);
    });

  it("R2 unique-app yield per query and overlap", { timeout: 300_000 }, async () => {
      const client = new PlayClient();
      const queries = [
        KEYWORD,
        `${KEYWORD} app`,
        `${KEYWORD} free`,
        `${KEYWORD} offline`,
        `${KEYWORD} beta`,
        `${KEYWORD} open source`,
        `${KEYWORD} simple`,
        `${KEYWORD} a`,
        `${KEYWORD} b`,
        `${KEYWORD} crypto wallet for beginners`,
      ];
      const all = new Set<string>();
      let rows = 0;
      for (const query of queries) {
        try {
          const res = await searchApps(client, { query });
          rows += res.apps.length;
          for (const a of res.apps) all.add(a.packageName);
          console.log(
            `[R2] "${query}" -> ${res.apps.length} cards, ${all.size} unique total, token=${res.continuationToken ? "yes" : "no"}`,
          );
        } catch (error) {
          console.log("[R2] failed", query, error instanceof Error ? error.message : error);
        }
      }
      console.log(`[R2] rows=${rows} unique=${all.size} dupRate=${(1 - all.size / rows).toFixed(2)}`);
      expect(all.size).toBeGreaterThan(50);
    });

  it("R3 similar-apps yield + strict qualification rate", { timeout: 300_000 }, async () => {
      const client = new PlayClient();
      const seeds = [
        "com.gmail.maxdiland.cryptocomplication",
        "com.cleevio.spendee",
      ];
      const all = new Set<string>();
      const pool: StoreApp[] = [];

      for (const seed of seeds) {
        try {
          const detail = await fetchAppDetail(client, seed);
          console.log(
            `[R3] ${seed} -> similar=${detail.similarApps.length} withRating=${detail.similarApps.filter((a) => a.rating !== null).length} withInstalls=${detail.similarApps.filter((a) => a.installs !== null).length}`,
          );
          for (const a of detail.similarApps) {
            all.add(a.packageName);
            pool.push(a);
          }
        } catch (error) {
          console.log("[R3] seed failed", seed, error instanceof Error ? error.message : error);
        }
      }

      const ratingInstallOk = pool.filter(passesRatingInstall);
      const matched = pool.filter(
        (a) => evaluateApp(a, FILTERS, new Set()).status === "match",
      );
      console.log(
        `[R3] similar pool=${pool.length} unique=${all.size} rating<=3&installs<=100k=${ratingInstallOk.length} strictMatch=${matched.length}`,
      );
      console.log(
        "[R3] strict matches:",
        matched.map((a) => `${a.title} | ${a.rating} | ${a.installsRaw}`).slice(0, 20),
      );
      expect(pool.length).toBeGreaterThan(10);
    });

  it("R4 long-tail query strict yield", { timeout: 300_000 }, async () => {
      const client = new PlayClient();
      const queries = [
        `${KEYWORD} a`,
        `${KEYWORD} b`,
        `${KEYWORD} c`,
        `${KEYWORD} d`,
        `${KEYWORD} e`,
        `${KEYWORD} f`,
        `${KEYWORD} beta`,
        `${KEYWORD} test`,
        `${KEYWORD} demo`,
        `${KEYWORD} old`,
      ];
      const seen = new Set<string>();
      let evaluated = 0;
      let ratingOk = 0;
      let matched = 0;
      for (const query of queries) {
        try {
          const res = await searchApps(client, { query });
          for (const a of res.apps) {
            if (seen.has(a.packageName)) continue;
            seen.add(a.packageName);
            evaluated += 1;
            if (passesRatingInstall(a)) ratingOk += 1;
            if (evaluateApp(a, FILTERS, new Set()).status === "match") {
              matched += 1;
              console.log(`[R4] MATCH "${query}" -> ${a.title} | ${a.rating} | ${a.installsRaw}`);
            }
          }
        } catch (error) {
          console.log("[R4] failed", query, error instanceof Error ? error.message : error);
        }
      }
      console.log(
        `[R4] unique=${evaluated} ratingInstallOk=${ratingOk} strictMatch=${matched} rate=${((matched / Math.max(evaluated, 1)) * 100).toFixed(2)}%`,
      );
      expect(evaluated).toBeGreaterThan(50);
    });
});

describe.skipIf(!live)("research yield matrix", () => {
  it("R5 query x country yield matrix", { timeout: 900_000 }, async () => {
    const client = new PlayClient({ intervalMs: 200, retries: 1 });
    const queries = [
      KEYWORD,
      `"${KEYWORD}"`,
      `${KEYWORD} app`,
      `${KEYWORD} free`,
      `${KEYWORD} offline`,
      `${KEYWORD} beta`,
      `${KEYWORD} simple`,
      `${KEYWORD} old`,
      `${KEYWORD} lite`,
      `${KEYWORD} a`,
      `${KEYWORD} b`,
      `${KEYWORD} c`,
      `${KEYWORD} bitcoin`,
      `${KEYWORD} ethereum`,
      `${KEYWORD} card`,
      `${KEYWORD} exchange`,
      `${KEYWORD} portfolio`,
      `${KEYWORD} tracker`,
      `${KEYWORD} hot`,
      `${KEYWORD} cold`,
    ];
    const countries = ["US", "GB", "IN", "ID", "BR", "NG", "PK", "DE"];
    const profiles = [
      { name: "A <=3 / <=100k", maxRating: 3, maxInstalls: 100_000 },
      { name: "B <=4 / <=500k", maxRating: 4, maxInstalls: 500_000 },
      { name: "C <=4.5 / <=5M", maxRating: 4.5, maxInstalls: 5_000_000 },
    ];

    const unique = new Map<string, StoreApp>();
    const rejects = new Map<string, number>();
    let requests = 0;
    const started = Date.now();

    for (const gl of countries) {
      for (const query of queries) {
        try {
          const res = await searchApps(client, { query, hl: "en", gl });
          requests += 1;
          for (const app of res.apps) if (!unique.has(app.packageName)) unique.set(app.packageName, app);
        } catch (error) {
          requests += 1;
          const key = `ERR:${error instanceof Error ? error.name : "unknown"}`;
          rejects.set(key, (rejects.get(key) ?? 0) + 1);
        }
      }
      console.log(`[R5] gl=${gl} unique=${unique.size} requests=${requests}`);
    }

    const apps = [...unique.values()];
    console.log(`[R5] done requests=${requests} unique=${apps.length} ms=${Date.now() - started}`);

    for (const profile of profiles) {
      const filters = { keyword: KEYWORD, ...profile, limit: 1000 };
      const seen = new Set<string>();
      const reasonCounts = new Map<string, number>();
      let matches = 0;
      let ratingInstallOk = 0;
      for (const app of apps) {
        const evaluation = evaluateApp(app, filters, seen);
        seen.add(app.packageName);
        for (const reason of evaluation.reasons) reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);
        if (evaluation.status === "match") matches += 1;
        if (
          app.rating !== null &&
          app.rating <= profile.maxRating &&
          app.installs !== null &&
          app.installs <= profile.maxInstalls
        ) {
          ratingInstallOk += 1;
        }
      }
      const perRequest = matches / Math.max(requests, 1);
      console.log(
        `[R5] profile ${profile.name}: matches=${matches} ratingInstallOk=${ratingInstallOk} perRequest=${perRequest.toFixed(3)} requestsFor1000=${Math.ceil(1000 / Math.max(perRequest, 0.0001))}`,
      );
      console.log(`[R5]   rejects=${JSON.stringify([...reasonCounts.entries()])}`);
    }
    expect(apps.length).toBeGreaterThan(200);
  });

});

