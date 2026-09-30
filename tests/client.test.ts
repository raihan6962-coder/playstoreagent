import { afterEach, describe, expect, it } from "vitest";
import { PlayClient, PlayRateLimitError } from "@/lib/playstore/client";

const originalFetch = globalThis.fetch;

function html(): string {
  return "<html><body>AF_initDataCallback({key: 'ds:1', hash: '1', data:[[]], sideChannel: {}});</body></html>";
}

describe("PlayClient concurrency", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("parallelises requests without exceeding the configured limit", async () => {
    let active = 0;
    let peak = 0;
    globalThis.fetch = (async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 25));
      active -= 1;
      return new Response(html(), { status: 200 });
    }) as typeof fetch;

    const client = new PlayClient({ concurrency: 4, intervalMs: 5, retries: 0 });
    await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        client.get(`https://play.google.com/store/search?c=apps&q=${index}`),
      ),
    );

    expect(client.requests).toBe(12);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(4);
  });

  it("serialises requests when concurrency is 1", async () => {
    let active = 0;
    let peak = 0;
    globalThis.fetch = (async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      return new Response(html(), { status: 200 });
    }) as typeof fetch;

    const client = new PlayClient({ concurrency: 1, intervalMs: 1, retries: 0 });
    await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        client.get(`https://play.google.com/store/search?c=apps&q=${index}`),
      ),
    );
    expect(peak).toBe(1);
  });

  it("reports a 429 as a rate limit error once retries are spent", async () => {
    globalThis.fetch = (async () => new Response("slow down", { status: 429 })) as typeof fetch;

    const client = new PlayClient({ concurrency: 1, intervalMs: 1, retries: 1 });
    await expect(
      client.get("https://play.google.com/store/search?c=apps&q=x"),
    ).rejects.toBeInstanceOf(PlayRateLimitError);
  });
});
