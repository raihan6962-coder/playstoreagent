import { describe, expect, it } from "vitest";
import { KnownApps, KNOWN_SHARDS, keywordSlug, shardFor } from "@/lib/playstore/known";

describe("KnownApps", () => {
  it("maps a package to a stable shard", () => {
    // The shard must never change between runs: a package that moved would
    // split a keyword's memory into two half-truths.
    const name = "com.example.someapp";
    expect(shardFor(name)).toBe(shardFor(name));
    expect(shardFor(name)).toBeGreaterThanOrEqual(0);
    expect(shardFor(name)).toBeLessThan(KNOWN_SHARDS);
  });

  it("keeps every package in the shard it hashes to", () => {
    const known = new KnownApps("wallet");
    for (let index = 0; index < 200; index += 1) {
      known.add(`com.example.app${index}`);
    }
    for (let index = 0; index < 200; index += 1) {
      const name = `com.example.app${index}`;
      expect(known.has(name)).toBe(true);
      expect(known.shardText(shardFor(name))).toContain(name);
    }
    expect(known.size).toBe(200);
  });

  it("reports an add as new only once", () => {
    const known = new KnownApps("wallet");
    expect(known.add("com.example.app")).toBe(true);
    expect(known.add("com.example.app")).toBe(false);
    expect(known.size).toBe(1);
  });

  it("marks only the shards that changed as dirty", () => {
    const known = new KnownApps("wallet");
    known.add("com.example.app");
    const dirty = known.dirtyShards();
    expect(dirty).toEqual([shardFor("com.example.app")]);

    known.clearDirty(dirty);
    expect(known.dirtyShards()).toEqual([]);

    // Adding a package that lands in the same shard dirties it again.
    known.add("com.example.app2");
    expect(known.dirtyShards().length).toBeGreaterThan(0);
  });

  it("round-trips through its shard text", () => {
    const known = new KnownApps("wallet");
    const names = ["com.example.a", "com.example.b", "com.example.c"];
    for (const name of names) known.add(name);

    const texts: string[] = [];
    for (let shard = 0; shard < KNOWN_SHARDS; shard += 1) texts.push(known.shardText(shard));

    const restored = KnownApps.fromShardText("wallet", texts);
    expect(restored.size).toBe(known.size);
    for (const name of names) expect(restored.has(name)).toBe(true);
    expect(restored.has("com.example.never")).toBe(false);
  });

  it("drops blank lines without losing the rest of the shard", () => {
    // The text array is indexed by shard, so a name only comes back if it
    // was stored in the shard it hashes to.
    const texts: string[] = [];
    texts[shardFor("com.example.a")] = "com.example.a\n\n   \n";
    const restored = KnownApps.fromShardText("wallet", texts);
    expect(restored.has("com.example.a")).toBe(true);
    expect(restored.size).toBe(1);
  });

  it("starts empty when a shard is missing", () => {
    const restored = KnownApps.fromShardText("wallet", []);
    expect(restored.size).toBe(0);
  });
});

describe("keywordSlug", () => {
  it("produces a filesystem-safe key", () => {
    const slug = keywordSlug("Crypto Wallet / Pro");
    expect(slug).toMatch(/^[a-z0-9-]+$/);
    expect(slug.startsWith("crypto-wallet-pro-")).toBe(true);
  });

  it("keeps two different keywords apart", () => {
    expect(keywordSlug("a/b")).not.toBe(keywordSlug("a-b"));
  });

  it("handles a keyword with no usable characters", () => {
    expect(keywordSlug("!!!")).toMatch(/^keyword-[0-9a-f]{8}$/);
  });
});
