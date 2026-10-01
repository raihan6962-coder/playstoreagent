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
  country: "US",
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
      const filters = { keyword: KEYWORD, ...profile, limit: 1000, country: "US" };
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

  /**
   * R6: what does one verification actually pay, per queue bucket?
   *
   * The crawler queues (a) foreign cards already at/below the ceiling,
   * (b) foreign cards inside the drift window above it (the "lottery"), and
   * (c) country cards already below the ceiling. This measures each bucket's
   * true pass rate at the run's own storefront — the number that decides
   * where the verify budget should go.
   */
  it("R6 verification pass rate by card-rating bucket", { timeout: 600_000 }, async () => {
    const client = new PlayClient({ intervalMs: 150, retries: 1 });
    const COUNTRY = "BD";
    const CEILING = 3.5;
    const queries = [
      KEYWORD,
      `${KEYWORD} app`,
      `${KEYWORD} free`,
      `${KEYWORD} lite`,
      `${KEYWORD} open source`,
      `${KEYWORD} old`,
      `${KEYWORD} a`,
      `${KEYWORD} b`,
      `${KEYWORD} simple`,
      `${KEYWORD} portfolio`,
    ];

    const buckets = new Map<string, Map<string, { card: number | null; home: number | null }>>();
    const bucketOf = (card: number | null, countryFinal: boolean): string => {
      if (card === null) return "card rating missing";
      if (countryFinal) return `country card <=${CEILING} (final)`;
      if (card <= CEILING) return `foreign card <=${CEILING}`;
      if (card <= CEILING + 1) return `foreign card (${CEILING}, ${CEILING + 1}] window`;
      return `foreign card >${CEILING + 1} (not queued)`;
    };

    // Foreign (US) cards — what a non-home search hands the crawler.
    const seen = new Set<string>();
    let sampleBudget = 18;
    for (const query of queries) {
      let res;
      try {
        res = await searchApps(client, { query, hl: "en", gl: "US" });
      } catch {
        continue;
      }
      for (const app of res.apps) {
        if (seen.has(app.packageName) || sampleBudget <= 0) continue;
        if (app.installs !== null && app.installs > 500_000) continue;
        seen.add(app.packageName);
        sampleBudget -= 1;
        const bucket = bucketOf(app.rating, false);
        let map = buckets.get(bucket);
        if (!map) buckets.set(bucket, (map = new Map()));
        if (map.size >= 15) continue;
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

    // Home (BD) cards — what a country-native search hands the crawler.
    let homeBudget = 10;
    for (const query of queries) {
      if (homeBudget <= 0) break;
      let res;
      try {
        res = await searchApps(client, { query, hl: "en", gl: COUNTRY });
      } catch {
        continue;
      }
      for (const app of res.apps) {
        if (app.rating === null || app.rating > CEILING) continue;
        if (app.installs !== null && app.installs > 500_000) continue;
        if (seen.has(app.packageName)) continue;
        seen.add(app.packageName);
        homeBudget -= 1;
        const bucket = bucketOf(app.rating, true);
        let map = buckets.get(bucket);
        if (!map) buckets.set(bucket, (map = new Map()));
        let home: number | null = null;
        try {
          const detail = await fetchAppDetail(client, app.packageName, "en", COUNTRY);
          home = detail.app?.rating ?? null;
        } catch {
          // leave null
        }
        map.set(app.packageName, { card: app.rating, home });
        if (homeBudget <= 0) break;
      }
    }

    console.log(`[R6] pass ceiling <=${CEILING} at gl=${COUNTRY}:`);
    for (const [bucket, map] of buckets) {
      const checked = [...map.values()].filter((row) => row.home !== null);
      const passed = checked.filter((row) => (row.home as number) <= CEILING);
      const sample = [...map.entries()]
        .slice(0, 6)
        .map(([pkg, row]) => `${pkg.replace(/^com\./, "")} card=${row.card} home=${row.home}`)
        .join(" | ");
      console.log(
        `[R6]   ${bucket}: ${passed.length}/${checked.length} pass (${((passed.length / Math.max(checked.length, 1)) * 100).toFixed(0)}%) -- ${sample}`,
      );
    }
    expect([...buckets.values()].reduce((sum, map) => sum + map.size, 0)).toBeGreaterThan(10);
  });

  /**
   * R6b: the bucket the crawler actually lives on — cards already printed
   * at/below the ceiling (long-tail queries surface niche apps that the
   * head queries never show), checked against the run's own storefront.
   */
  it("R6b at-ceiling cards from long-tail queries, home vs foreign", { timeout: 600_000 }, async () => {
    const client = new PlayClient({ intervalMs: 150, retries: 1 });
    const COUNTRY = "BD";
    const CEILING = 3.5;
    const longTail = [
      `${KEYWORD} lite`,
      `${KEYWORD} simple`,
      `${KEYWORD} old`,
      `${KEYWORD} offline`,
      `${KEYWORD} tiny`,
      `${KEYWORD} a`,
      `${KEYWORD} b`,
      `${KEYWORD} demo`,
      `${KEYWORD} open source`,
      `${KEYWORD} test`,
    ];
    const gls = ["BD", "US", "IN", "ID", "TR"];

    const rows: { gl: string; pkg: string; card: number | null; home: number | null }[] = [];
    const seen = new Set<string>();
    for (const gl of gls) {
      let atCeiling = 0;
      for (const query of longTail) {
        let res;
        try {
          res = await searchApps(client, { query, hl: "en", gl });
        } catch {
          continue;
        }
        for (const app of res.apps) {
          if (app.rating === null || app.rating > CEILING) continue;
          if (app.installs !== null && app.installs > 500_000) continue;
          if (seen.has(app.packageName) || atCeiling >= 8) continue;
          seen.add(app.packageName);
          atCeiling += 1;
          let home: number | null = null;
          try {
            const detail = await fetchAppDetail(client, app.packageName, "en", COUNTRY);
            home = detail.app?.rating ?? null;
          } catch {
            // null: verification would fail
          }
          rows.push({ gl, pkg: app.packageName, card: app.rating, home });
        }
      }
      console.log(`[R6b] gl=${gl}: ${atCeiling} cards at/below ceiling sampled`);
    }

    for (const gl of gls) {
      const bucket = rows.filter((row) => row.gl === gl);
      const checked = bucket.filter((row) => row.home !== null);
      const passed = checked.filter((row) => (row.home as number) <= CEILING);
      console.log(
        `[R6b] gl=${gl}: pass ${passed.length}/${checked.length} (${((passed.length / Math.max(checked.length, 1)) * 100).toFixed(0)}%)` +
          bucket
            .slice(0, 8)
            .map((row) => ` | ${row.pkg.replace(/^com\./, "")} card=${row.card} home=${row.home}`)
            .join(""),
      );
    }
    expect(rows.length).toBeGreaterThan(5);
  });

  /**
   * R8: the home-bucket mystery. Live runs queue ~2600 home (gl=BD) cards
   * per step but then ceiling-reject ~97% of verifications, which contradicts
   * R6b's home passes. This measures the same pair R6b did — card printed by
   * a BD search vs the BD detail page — at a bigger sample, and also pulls
   * the US detail for the same package to see whether Play's search cards
   * carry a global rating while detail pages carry the local one.
   */
  it("R8 home card vs home detail disagreement", { timeout: 600_000 }, async () => {
    const client = new PlayClient({ intervalMs: 150, retries: 1 });
    const CEILING = 3.5;
    const queries = [
      "wallet",
      "crypto",
      `${KEYWORD} old`,
      `${KEYWORD} simple`,
      `${KEYWORD} a`,
      `${KEYWORD} b`,
      `${KEYWORD} test`,
      `${KEYWORD} offline`,
      `${KEYWORD} tiny`,
      `${KEYWORD} open source`,
    ];
    const rows: { pkg: string; card: number; bd: number | null; us: number | null }[] = [];
    const seen = new Set<string>();
    for (const query of queries) {
      if (rows.length >= 30) break;
      let res;
      try {
        res = await searchApps(client, { query, hl: "en", gl: "BD" });
      } catch {
        continue;
      }
      for (const app of res.apps) {
        if (rows.length >= 30) break;
        if (app.rating === null || app.rating > CEILING || app.rating === 0) continue;
        if (app.installs !== null && app.installs > 500_000) continue;
        if (seen.has(app.packageName)) continue;
        seen.add(app.packageName);
        let bd: number | null = null;
        let us: number | null = null;
        try {
          const detail = await fetchAppDetail(client, app.packageName, "en", "BD");
          bd = detail.app?.rating ?? null;
        } catch {
          // null: verification would reject
        }
        try {
          const detail = await fetchAppDetail(client, app.packageName, "en", "US");
          us = detail.app?.rating ?? null;
        } catch {
          // null
        }
        rows.push({ pkg: app.packageName, card: app.rating, bd, us });
      }
    }

    const checked = rows.filter((row) => row.bd !== null);
    const passed = checked.filter((row) => (row.bd as number) <= CEILING);
    const disagree = checked.filter((row) => Math.abs((row.bd as number) - row.card) > 0.05);
    const higher = checked.filter((row) => (row.bd as number) > CEILING && row.card <= CEILING);
    console.log(
      `[R8] card<=${CEILING} from BD search: detail(BD) pass ${passed.length}/${checked.length} ` +
        `(${((passed.length / Math.max(checked.length, 1)) * 100).toFixed(0)}%), ` +
        `disagreements ${disagree.length}, detail over ceiling ${higher.length}`,
    );
    for (const row of rows.slice(0, 20)) {
      console.log(
        `[R8] ${row.pkg.replace(/^com\./, "")}: cardBD=${row.card} detailBD=${row.bd} detailUS=${row.us}`,
      );
    }
    // Supply-bound: at-ceiling cards are genuinely rare in head-query results,
    // so a sample of 1-2 is a meaningful observation, not a broken parse.
    expect(rows.length).toBeGreaterThan(1);
  });

  /**
   * R7: does the Bengali-language home storefront (hl=bn, gl=BD) surface a
   * different card set than English (hl=en, gl=BD)? If yes, adding it to the
   * sweep doubles the only bucket that verifies at 100%.
   */
  it("R7 Bengali vs English home storefront coverage", { timeout: 300_000 }, async () => {
    const client = new PlayClient({ intervalMs: 150, retries: 1 });
    const queries = [KEYWORD, `${KEYWORD} lite`, `${KEYWORD} a`, `${KEYWORD} old`, `${KEYWORD} free`];
    const sets: Record<string, Set<string>> = { en: new Set(), bn: new Set() };
    const atCeiling: Record<string, Set<string>> = { en: new Set(), bn: new Set() };

    for (const hl of ["en", "bn"] as const) {
      for (const query of queries) {
        try {
          const res = await searchApps(client, { query, hl, gl: "BD" });
          for (const app of res.apps) {
            sets[hl].add(app.packageName);
            if (
              app.rating !== null &&
              app.rating <= 3.5 &&
              (app.installs === null || app.installs <= 500_000)
            ) {
              atCeiling[hl].add(app.packageName);
            }
          }
        } catch {
          // count what we got
        }
      }
      console.log(
        `[R7] hl=${hl}: unique=${sets[hl].size} atCeiling=${atCeiling[hl].size} [${[...atCeiling[hl]].slice(0, 8).join(", ")}]`,
      );
    }
    const overlap = [...sets.bn].filter((pkg) => sets.en.has(pkg)).length;
    const bnOnlyCeiling = [...atCeiling.bn].filter((pkg) => !atCeiling.en.has(pkg));
    console.log(
      `[R7] overlap=${overlap}/${sets.bn.size} bn-only cards | bn-only atCeiling: ${bnOnlyCeiling.join(", ") || "(none)"}`,
    );
    expect(sets.bn.size).toBeGreaterThan(5);
  });
});

