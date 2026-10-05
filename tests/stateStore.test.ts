import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readJson, StoreError, writeJson } from "@/lib/server/stateStore";
import { installGitHubMock, storedJson, type GitHubMock } from "./helpers/githubMock";

describe("stateStore", () => {
  let mock: GitHubMock;

  beforeEach(() => {
    process.env.PSA_STATE_REPO = "owner/state-repo";
    process.env.GITHUB_TOKEN = "test-token";
    mock = installGitHubMock();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("round-trips JSON through the contents API", async () => {
    await writeJson("runs/a.state.json", { hello: "world", n: 1 }, "psa: create");
    expect(storedJson(mock.files, "runs/a.state.json")).toEqual({ hello: "world", n: 1 });

    await expect(readJson("runs/a.state.json")).resolves.toEqual({ hello: "world", n: 1 });
  });

  it("returns null for a missing file and reads it back after a write", async () => {
    await expect(readJson("runs/missing.json")).resolves.toBeNull();
    await writeJson("runs/missing.json", { now: true }, "psa: create");
    await expect(readJson("runs/missing.json")).resolves.toEqual({ now: true });
  });

  it("sends the cached ETag on fresh reads and accepts the 304", async () => {
    await writeJson("runs/b.state.json", { v: 1 }, "psa: create");
    await readJson("runs/b.state.json", true);

    const before = mock.fetchMock.mock.calls.length;
    const value = await readJson("runs/b.state.json", true);
    expect(value).toEqual({ v: 1 });

    const lastCall = mock.fetchMock.mock.calls.at(-1)!;
    const headers = new Headers(
      (lastCall[1] as RequestInit | undefined)?.headers as Record<string, string>,
    );
    expect(headers.get("If-None-Match")).toBeTruthy();
    expect(mock.fetchMock.mock.calls.length).toBe(before + 1);
  });

  it("retries a write that lost the sha race", async () => {
    mock.failNextPut(409);
    await writeJson("runs/c.state.json", { v: 2 }, "psa: retry");
    expect(storedJson(mock.files, "runs/c.state.json")).toEqual({ v: 2 });
  });

  it("reports a rate-limited response as a resumable StoreError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("rate limited", {
            status: 403,
            headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "123" },
          }),
      ),
    );

    const failure = await readJson("runs/whatever.json", true).catch((error) => error);
    expect(failure).toBeInstanceOf(StoreError);
    expect((failure as StoreError).kind).toBe("rate-limit");
    expect((failure as StoreError).retryAt).toBe(123_000);
  });

  it("fails loudly when the store is not configured", async () => {
    delete process.env.PSA_STATE_REPO;
    const failure = await writeJson("runs/x.json", {}, "psa: x").catch((error) => error);
    expect(failure).toBeInstanceOf(StoreError);
    expect((failure as StoreError).kind).toBe("config");
  });
});
