import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  beginTick,
  createRun,
  isValidRunId,
  kickTick,
  resumeRun,
  snapshotRun,
  stopRun,
} from "@/lib/server/runs";
import type { RunMeta, RunState } from "@/lib/server/runs";
import { readJson, writeJson } from "@/lib/server/stateStore";
import type { LeadFilters } from "@/types/lead";
import { installGitHubMock, storedJson, type GitHubMock } from "./helpers/githubMock";

const ORIGIN = "http://run.test";

function filters(): LeadFilters {
  return { keyword: "budget tracker", maxRating: 3, maxInstalls: 100_000, limit: 10, country: "US" };
}

describe("run orchestration", () => {
  let mock: GitHubMock;

  beforeEach(() => {
    process.env.PSA_STATE_REPO = "owner/state-repo";
    process.env.GITHUB_TOKEN = "test-token";
    mock = installGitHubMock();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("creates a run with meta, state and a curated creation log line", async () => {
    const { runId, token } = await createRun(filters());
    expect(isValidRunId(runId)).toBe(true);
    expect(token).not.toBe(runId);

    const meta = storedJson(mock.files, `runs/${runId}.meta.json`) as RunMeta;
    expect(meta).toMatchObject({ runId, token, status: "running" });

    const state = storedJson(mock.files, `runs/${runId}.state.json`) as RunState;
    expect(state.keyword).toBe("budget tracker");
    expect(state.cursor.phase).toBe("suggest");
    expect(state.log).toHaveLength(1);
    expect(state.log[0].message).toContain("Run created");
    expect(state.leaseUntil).toBe(0);
  });

  it("acquires the lease once and reports a concurrent tick as busy", async () => {
    const { runId, token } = await createRun(filters());

    const first = await beginTick(runId, token);
    expect(first.kind).toBe("step");
    if (first.kind !== "step") return;
    expect(first.state.leaseUntil).toBeGreaterThan(Date.now());

    const second = await beginTick(runId, token);
    expect(second.kind).toBe("busy");
  });

  it("rejects a wrong token and an unknown run", async () => {
    const { runId, token } = await createRun(filters());
    expect((await beginTick(runId, "not-the-token")).kind).toBe("forbidden");
    expect((await beginTick(crypto.randomUUID(), token)).kind).toBe("missing");
  });

  it("finalizes a pending stop instead of starting a step", async () => {
    const { runId, token } = await createRun(filters());
    const metaPath = `runs/${runId}.meta.json`;
    const meta = (await readJson<RunMeta>(metaPath, true))!;
    meta.status = "stop-requested";
    await writeJson(metaPath, meta, "psa: stop");

    const begin = await beginTick(runId, token);
    expect(begin).toEqual({ kind: "final", status: "stopped" });
    expect((storedJson(mock.files, metaPath) as RunMeta).status).toBe("stopped");
  });

  it("stops a run with no live lease immediately", async () => {
    const { runId, token } = await createRun(filters());
    const result = await stopRun(runId, token);
    expect(result).toEqual({ ok: true, status: "stopped" });
    expect((storedJson(mock.files, `runs/${runId}.meta.json`) as RunMeta).status).toBe(
      "stopped",
    );
  });

  it("only requests a stop while a step holds the lease", async () => {
    const { runId, token } = await createRun(filters());
    const begin = await beginTick(runId, token);
    expect(begin.kind).toBe("step");

    const result = await stopRun(runId, token);
    expect(result).toEqual({ ok: true, status: "stop-requested" });
    expect((storedJson(mock.files, `runs/${runId}.meta.json`) as RunMeta).status).toBe(
      "stop-requested",
    );
  });

  it("snapshots with token gating and version-based log/leads gating", async () => {
    const { runId, token } = await createRun(filters());

    const full = await snapshotRun(runId, token);
    expect(full.ok).toBe(true);
    if (!full.ok) return;
    expect(full.status).toBe("running");
    expect(full.log?.length).toBeGreaterThan(0);
    expect(full.leads).toEqual([]);
    const logLastId = full.versions.logLastId;

    // Nothing new: log and leads collapse to null.
    const quiet = await snapshotRun(runId, token, {
      logSince: logLastId,
      leadsSince: full.versions.leads,
    });
    expect(quiet.ok).toBe(true);
    if (!quiet.ok) return;
    expect(quiet.log).toBeNull();
    expect(quiet.leads).toBeNull();

    expect(await snapshotRun(runId, "wrong-token")).toEqual({ ok: false, code: 401 });
    expect(await snapshotRun(crypto.randomUUID(), token)).toEqual({ ok: false, code: 404 });
  });

  it("reports a run whose checkpoints stopped as stalled", async () => {
    const { runId, token } = await createRun(filters());
    const statePath = `runs/${runId}.state.json`;
    const state = (await readJson<RunState>(statePath, true))!;
    state.updatedAt = Date.now() - 120_000;
    await writeJson(statePath, state, "psa: age");

    const snapshot = await snapshotRun(runId, token);
    expect(snapshot.ok).toBe(true);
    if (!snapshot.ok) return;
    expect(snapshot.status).toBe("stalled");
  });

  it("resumes a stopped run and kicks the chain", async () => {
    const { runId, token } = await createRun(filters());
    await stopRun(runId, token);
    expect((storedJson(mock.files, `runs/${runId}.meta.json`) as RunMeta).status).toBe("stopped");

    const result = await resumeRun(runId, token, ORIGIN);
    expect(result).toEqual({ ok: true, status: "running" });
    expect((storedJson(mock.files, `runs/${runId}.meta.json`) as RunMeta).status).toBe("running");

    const kicked = mock.fetchMock.mock.calls.some(([url]) =>
      String(url).includes(`/api/runs/${runId}/tick`),
    );
    expect(kicked).toBe(true);
  });

  it("refuses to resume while a stop is still in flight", async () => {
    const { runId, token } = await createRun(filters());
    await beginTick(runId, token); // hold the lease
    await stopRun(runId, token); // status: stop-requested

    const result = await resumeRun(runId, token, ORIGIN);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe(409);
  });

  it("retries the chain kick after a transient network failure", async () => {
    const { runId, token } = await createRun(filters());
    const original = mock.fetchMock.getMockImplementation() as (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => Promise<Response>;
    let tickCalls = 0;
    mock.fetchMock.mockImplementation(
      async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = String(input);
        if (url.includes("/tick") && tickCalls++ === 0) throw new TypeError("fetch failed");
        return original(input, init);
      },
    );

    await kickTick(ORIGIN, runId, token);
    expect(tickCalls).toBeGreaterThanOrEqual(2);
  });
});
