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

  it("times out when headers arrive but the body never does", async () => {
    // Regression: the abort timer used to be cleared the moment headers
    // arrived, so a throttled connection that stalled the payload blocked
    // `response.text()` forever and deadlocked every window behind it.
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          init?.signal?.addEventListener("abort", () =>
            controller.error(init.signal?.reason ?? new Error("aborted")),
          );
          // Headers are "sent"; the payload never arrives.
        },
      });
      return new Response(stream, { status: 200 });
    }) as typeof fetch;

    const client = new PlayClient({
      concurrency: 1,
      intervalMs: 1,
      retries: 0,
      timeoutMs: 300,
    });
    const startedAt = Date.now();
    await expect(
      client.get("https://play.google.com/store/search?c=apps&q=x"),
    ).rejects.toThrow(/Timed out/);
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });
});
