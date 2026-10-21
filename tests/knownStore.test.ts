import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadKnownApps, saveKnownApps } from "@/lib/server/known";
import { KNOWN_SHARDS, KnownApps, keywordSlug, shardFor } from "@/lib/playstore/known";
import { installGitHubMock, storedJson, type GitHubMock } from "./helpers/githubMock";

describe("known apps store", () => {
  let mock: GitHubMock;

  beforeEach(() => {
    process.env.PSA_STATE_REPO = "owner/state-repo";
    process.env.GITHUB_TOKEN = "test-token";
    mock = installGitHubMock();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("starts empty for a keyword nobody has run", async () => {
    const known = await loadKnownApps("wallet");
    expect(known.size).toBe(0);
    expect(known.dirtyShards()).toEqual([]);
  });

  it("persists a keyword's packages and reads them back", async () => {
    const known = new KnownApps("wallet");
    known.add("com.example.a");
    known.add("com.example.b");

    await saveKnownApps(known);
    // The dirty shards are cleared once they are safely written.
    expect(known.dirtyShards()).toEqual([]);

    const reloaded = await loadKnownApps("wallet");
    expect(reloaded.size).toBe(2);
    expect(reloaded.has("com.example.a")).toBe(true);
    expect(reloaded.has("com.example.b")).toBe(true);
  });

  it("writes only the shards that changed", async () => {
    const known = new KnownApps("wallet");
    known.add("com.example.a");
    const dirty = known.dirtyShards();
    expect(dirty).toEqual([shardFor("com.example.a")]);

    await saveKnownApps(known);
    const slug = keywordSlug("wallet");
    const written = Array.from(mock.files.keys()).filter((path) =>
      path.startsWith(`config/known/${slug}/`),
    );
    // Exactly one file: the shard that gained a package. The other shards
    // were never touched, so they were never written.
    expect(written).toEqual([`config/known/${slug}/${dirty[0]}.json`]);

    // A later save that changes nothing writes nothing.
    const callsBefore = mock.fetchMock.mock.calls.length;
    await saveKnownApps(known);
    expect(mock.fetchMock.mock.calls.length).toBe(callsBefore);
  });

  it("keeps two keywords apart", async () => {
    const wallet = new KnownApps("wallet");
    wallet.add("com.example.wallet");
    await saveKnownApps(wallet);

    const crypto = await loadKnownApps("crypto");
    expect(crypto.size).toBe(0);
    expect(crypto.has("com.example.wallet")).toBe(false);
  });

  it("stores each package in the shard it hashes to", async () => {
    const known = new KnownApps("wallet");
    const names = Array.from({ length: 50 }, (_, index) => `com.example.app${index}`);
    for (const name of names) known.add(name);
    await saveKnownApps(known);

    const slug = keywordSlug("wallet");
    for (let shard = 0; shard < KNOWN_SHARDS; shard += 1) {
      const stored = storedJson(mock.files, `config/known/${slug}/${shard}.json`);
      if (typeof stored !== "string") continue;
      for (const line of stored.split("\n")) {
        if (!line) continue;
        expect(shardFor(line)).toBe(shard);
      }
    }
  });
});
