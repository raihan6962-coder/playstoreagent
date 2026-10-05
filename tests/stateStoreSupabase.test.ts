import { afterEach, describe, expect, it, vi } from "vitest";
import { mutateJson, readJson, StoreError, writeJson } from "@/lib/server/stateStore";

const BASE = "https://sbtest.supabase.co";
const KEY = "service-role-test-key";

interface Row {
  path: string;
  value: unknown;
  updated_at: string;
}

/**
 * In-memory PostgREST stand-in for `state_files`: GET/PATCH/POST with the
 * exact shapes PostgREST returns (arrays, 201/204, 409 on duplicate key,
 * representation on CAS patches), plus test hooks to simulate a concurrent
 * writer between a read and its write.
 */
function installSupabaseMock() {
  const rows = new Map<string, Row>();
  let seq = 0;
  let rateLimitNext = false;
  let beforePatch: ((row: Row) => void) | null = null;
  let beforeInsert: (() => void) | null = null;
  const counts = { get: 0, post: 0, patch: 0 };

  const stamp = () => `1970-01-01T00:00:00.${String(++seq).padStart(6, "0")}+00:00`;

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (!url.pathname.endsWith("/rest/v1/state_files")) {
      throw new Error(`unexpected url ${String(input)}`);
    }
    if (rateLimitNext) {
      rateLimitNext = false;
      return new Response("rate limited", { status: 429, headers: { "retry-after": "7" } });
    }

    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers as HeadersInit | undefined);
    const pathFilter = url.searchParams.get("path");
    const path = pathFilter ? pathFilter.replace(/^eq\./, "") : null;
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;

    if (method === "GET") {
      counts.get += 1;
      const row = path ? rows.get(path) : undefined;
      return Response.json(row ? [{ value: row.value, updated_at: row.updated_at }] : []);
    }

    if (method === "POST") {
      counts.post += 1;
      if (beforeInsert) {
        const hook = beforeInsert;
        beforeInsert = null;
        hook();
      }
      if (!body || typeof body.path !== "string") {
        return Response.json({ code: "22P02", message: "bad body" }, { status: 400 });
      }
      const upsert = (headers.get("Prefer") ?? "").includes("resolution=merge-duplicates");
      const existing = rows.get(body.path);
      if (existing && !upsert) {
        return Response.json(
          { code: "23505", message: "duplicate key value violates unique constraint" },
          { status: 409 },
        );
      }
      const row: Row = { path: body.path, value: body.value, updated_at: stamp() };
      rows.set(row.path, row);
      const minimal = (headers.get("Prefer") ?? "").includes("return=minimal");
      if (minimal) return new Response(null, { status: 204 });
      return Response.json([row], { status: existing ? 200 : 201 });
    }

    if (method === "PATCH") {
      counts.patch += 1;
      const stampFilter = url.searchParams.get("updated_at");
      const expected = stampFilter ? stampFilter.replace(/^eq\./, "") : null;
      const row = path ? rows.get(path) : undefined;
      // The hook fires only where our CAS *would* have landed — then moves
      // the row's stamp, so the comparison below misses like a lost race.
      if (row && expected === row.updated_at && beforePatch) {
        const hook = beforePatch;
        beforePatch = null;
        hook(row);
      }
      const current = path ? rows.get(path) : undefined;
      if (!current || expected !== current.updated_at) return Response.json([]);
      if (body) {
        if ("value" in body) current.value = body.value;
        current.updated_at = stamp();
      }
      return Response.json([
        { path: current.path, value: current.value, updated_at: current.updated_at },
      ]);
    }

    return Response.json({ message: "method not allowed" }, { status: 405 });
  });

  vi.stubGlobal("fetch", fetchMock);
  return {
    rows,
    counts,
    fetchMock,
    failNextWithRateLimit: () => {
      rateLimitNext = true;
    },
    /** Simulates another instance writing the row between read and PATCH. */
    concurrentPatchWrite: (value: unknown) => {
      beforePatch = (row) => {
        row.value = value;
        row.updated_at = stamp();
      };
    },
    concurrentInsert: (rowPath: string, value: unknown) => {
      beforeInsert = () => {
        rows.set(rowPath, { path: rowPath, value, updated_at: stamp() });
      };
    },
  };
}

describe("stateStore (Supabase backend)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  });

  function setup() {
    process.env.SUPABASE_URL = BASE;
    process.env.SUPABASE_SERVICE_ROLE_KEY = KEY;
    return installSupabaseMock();
  }

  it("round-trips JSON through PostgREST", async () => {
    setup();
    await writeJson("sb/roundtrip.json", { hello: "world", n: 1 }, "psa: create");
    expect(await readJson("sb/roundtrip.json", true)).toEqual({ hello: "world", n: 1 });
    // Non-fresh read rides the write-through cache (no extra round trip).
    expect(await readJson("sb/roundtrip.json")).toEqual({ hello: "world", n: 1 });
  });

  it("returns null for a missing path", async () => {
    setup();
    await expect(readJson("sb/missing.json", true)).resolves.toBeNull();
  });

  it("expires the read cache after its TTL", async () => {
    const mock = setup();
    await writeJson("sb/ttl.json", { v: 1 }, "psa: create");
    await readJson("sb/ttl.json"); // cache hit — no fetch
    expect(mock.counts.get).toBe(0);

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 2_000);
    expect(await readJson("sb/ttl.json")).toEqual({ v: 1 });
    expect(mock.counts.get).toBe(1); // TTL expired — went to the database
  });

  it("mutates read-modify-write cycles through CAS patches", async () => {
    const mock = setup();
    await writeJson("sb/mutate.json", { n: 1 }, "psa: create");
    await mutateJson<{ n: number }>("sb/mutate.json", (current) => ({ n: current!.n + 1 }), "psa: bump");
    expect(mock.counts.patch).toBe(1);
    expect(await readJson("sb/mutate.json", true)).toEqual({ n: 2 });
  });

  it("creates a missing file through the insert path", async () => {
    setup();
    await mutateJson<{ made: boolean }>("sb/fresh-mutate.json", () => ({ made: true }), "psa: make");
    expect(await readJson("sb/fresh-mutate.json", true)).toEqual({ made: true });
  });

  it("skips the write when the mutate returns null", async () => {
    const mock = setup();
    await writeJson("sb/skip.json", { keep: true }, "psa: create");
    await mutateJson("sb/skip.json", () => null, "psa: skip");
    expect(mock.counts.post + mock.counts.patch).toBe(1); // only the initial upsert
    expect(await readJson("sb/skip.json", true)).toEqual({ keep: true });
  });

  it("retries a CAS that lost to a concurrent writer without losing either change", async () => {
    const mock = setup();
    await writeJson("sb/cas.json", { n: 0 }, "psa: create");
    mock.concurrentPatchWrite({ n: 10 });

    await mutateJson<{ n: number }>("sb/cas.json", (current) => ({ n: current!.n + 1 }), "psa: bump");

    expect(mock.counts.patch).toBe(2); // first CAS missed, second landed
    expect(await readJson("sb/cas.json", true)).toEqual({ n: 11 });
  });

  it("retries an insert that raced with another instance", async () => {
    const mock = setup();
    mock.concurrentInsert("sb/insert-race.json", { other: true });

    await mutateJson<Record<string, unknown>>(
      "sb/insert-race.json",
      (current) => ({ ...(current ?? {}), mine: true }),
      "psa: race",
    );

    expect(await readJson("sb/insert-race.json", true)).toEqual({ other: true, mine: true });
  });

  it("maps a 429 to a resumable rate-limit StoreError", async () => {
    const mock = setup();
    mock.failNextWithRateLimit();
    const failure = await readJson("sb/limited.json", true).catch((error) => error);
    expect(failure).toBeInstanceOf(StoreError);
    expect((failure as StoreError).kind).toBe("rate-limit");
    expect((failure as StoreError).retryAt).toBeGreaterThan(Date.now());
  });

  it("sends the service-role key on every request", async () => {
    const mock = setup();
    await writeJson("sb/auth.json", { ok: true }, "psa: create");
    const [, init] = mock.fetchMock.mock.calls[0]!;
    const headers = new Headers((init as RequestInit).headers as HeadersInit);
    expect(headers.get("apikey")).toBe(KEY);
    expect(headers.get("Authorization")).toBe(`Bearer ${KEY}`);
  });
});
