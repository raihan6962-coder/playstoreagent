/**
 * The "already judged" memory for one keyword.
 *
 * A normal run may re-search the same keyword as often as the operator
 * likes, and every one of those runs re-collects the same apps. The
 * "new apps only" mode exists to break that loop: it needs to know which
 * packages this keyword has already produced, across every earlier run.
 *
 * This module is the pure part — the set itself and how a package maps to a
 * shard. Storage lives in lib/server/known.ts; the crawler only ever sees
 * this class, so nothing here may import a server module.
 *
 * Exact names, never hashes: a false positive would silently drop a real
 * lead, and a missed lead is worse than a large file.
 */

/** Shards per keyword. Keeps each stored file small enough to write often. */
export const KNOWN_SHARDS = 8;

/**
 * FNV-1a (32-bit) over the package name. Stable across processes and
 * runs — the shard a package lands in must never change, or a keyword's
 * memory would split into two half-truths.
 */
export function shardFor(packageName: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < packageName.length; index += 1) {
    hash ^= packageName.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % KNOWN_SHARDS;
}

/**
 * The set of packages already judged for a keyword, plus the bookkeeping the
 * store needs: which shards changed since the last save.
 */
export class KnownApps {
  /** Package names per shard. */
  private readonly shards: Set<string>[];

  /** Shards that gained a package since the last {@link drainDirty}. */
  private readonly dirty: Set<number>;

  readonly keyword: string;

  constructor(keyword: string, shards: Set<string>[] = []) {
    this.keyword = keyword;
    this.dirty = new Set();
    this.shards = [];
    for (let index = 0; index < KNOWN_SHARDS; index += 1) {
      this.shards.push(shards[index] ?? new Set<string>());
    }
  }

  /** Build a set from stored shard payloads (newline-separated names). */
  static fromShardText(keyword: string, texts: string[]): KnownApps {
    const shards: Set<string>[] = [];
    for (let index = 0; index < KNOWN_SHARDS; index += 1) {
      const set = new Set<string>();
      for (const line of (texts[index] ?? "").split("\n")) {
        const name = line.trim();
        if (name) set.add(name);
      }
      shards.push(set);
    }
    return new KnownApps(keyword, shards);
  }

  /** Serialize a shard for storage. */
  shardText(index: number): string {
    return Array.from(this.shards[index]).join("\n");
  }

  has(packageName: string): boolean {
    return this.shards[shardFor(packageName)].has(packageName);
  }

  /** Record a package as judged. Returns true when it was new. */
  add(packageName: string): boolean {
    const shard = shardFor(packageName);
    if (this.shards[shard].has(packageName)) return false;
    this.shards[shard].add(packageName);
    this.dirty.add(shard);
    return true;
  }

  /** How many packages are remembered. */
  get size(): number {
    let total = 0;
    for (const shard of this.shards) total += shard.size;
    return total;
  }

  /** Shards that changed since the last drain. */
  dirtyShards(): number[] {
    return Array.from(this.dirty).sort((a, b) => a - b);
  }

  /** Mark the given shards as saved. */
  clearDirty(shards: number[]): void {
    for (const shard of shards) this.dirty.delete(shard);
  }
}

/**
 * A stable, filesystem-safe key for a keyword. The hash suffix keeps two
 * keywords that sanitise to the same text apart ("a/b" and "a-b").
 */
export function keywordSlug(keyword: string): string {
  const base = keyword
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  let hash = 0x811c9dc5;
  for (let index = 0; index < keyword.length; index += 1) {
    hash ^= keyword.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  const suffix = hash.toString(16).padStart(8, "0");
  return `${base || "keyword"}-${suffix}`;
}
