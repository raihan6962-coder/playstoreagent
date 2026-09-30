import { describe, expect, it } from "vitest";
import { PlayClient } from "@/lib/playstore/client";
import { fetchAppDetail } from "@/lib/playstore/detail";

const live = process.env.PLAY_LIVE === "1";

/**
 * Ratings differ per storefront for the same app (measured 2026-09 for
 * com.tria.v2: 2.13 US / 2.19 BD / 4.55 KR with identical review counts), so
 * the run's country has to reach the detail fetch — otherwise the table shows
 * numbers the user's Play Store disagrees with.
 */
describe.skipIf(!live)("country storefront detail fetches", () => {
  it(
    "reads the rating from the requested country",
    { timeout: 60_000 },
    async () => {
      const client = new PlayClient({ concurrency: 2, intervalMs: 300, retries: 1 });

      const bd = await fetchAppDetail(client, "com.tria.v2", "en", "BD");
      const kr = await fetchAppDetail(client, "com.tria.v2", "en", "KR");
      console.log(
        `[country] com.tria.v2 BD=${bd.app?.rating} KR=${kr.app?.rating} ` +
          `BD count=${bd.app?.ratingsCount} KR count=${kr.app?.ratingsCount}`,
      );

      expect(bd.app?.rating).not.toBeNull();
      expect(kr.app?.rating).not.toBeNull();
      // BD is a ~2.2 store and KR ~4.5: reading the wrong gl flips this.
      expect(bd.app!.rating).toBeLessThan(3);
      expect(kr.app!.rating).toBeGreaterThan(4);
    },
  );

  it(
    "recovers a rating from the visible stars when JSON-LD omits it",
    { timeout: 60_000 },
    async () => {
      // Measured 2026-09: this page serves no aggregateRating JSON-LD, only the
      // aria label next to the stars — without the fallback the lead would
      // keep a stale search-card number.
      const client = new PlayClient({ concurrency: 2, intervalMs: 300, retries: 1 });
      const detail = await fetchAppDetail(client, "com.telangana.twalletnew", "en", "BD");
      console.log(`[country] T Wallet BD rating=${detail.app?.rating}`);

      expect(detail.app?.rating).not.toBeNull();
      expect(detail.app!.rating).toBeGreaterThan(0);
      expect(detail.app!.rating).toBeLessThanOrEqual(5);
    },
  );
});
