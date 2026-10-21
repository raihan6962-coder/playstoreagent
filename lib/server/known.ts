/**
 * Durable storage for a keyword's "already judged" memory.
 *
 * One directory per keyword, one file per shard:
 *   config/known/{slug}/0.json … 7.json
 * Each file holds the shard's package names, newline separated — the most
 * compact exact representation, and the only one that stays readable when
 * the set grows into the tens of thousands.
 *
 * Sharding is not decoration: a single file for a broad keyword would be
 * megabytes, and every step would rewrite all of it. With shards, a step
 * that judged thirty new apps writes only the shards those apps fell into.
 */

import { readJson, writeJson } from "@/lib/server/stateStore";
import { KNOWN_SHARDS, KnownApps, keywordSlug } from "@/lib/playstore/known";

function shardPath(keyword: string, shard: number): string {
  return `config/known/${keywordSlug(keyword)}/${shard}.json`;
}

/**
 * Load the known packages for a keyword. A missing or unreadable shard is
 * an empty shard, never a failure: losing the memory would only cost a
 * repeated app, while failing the tick would cost the whole run.
 */
export async function loadKnownApps(keyword: string): Promise<KnownApps> {
  // The shards are independent — one round trip each, in parallel.
  const reads = await Promise.all(
    Array.from({ length: KNOWN_SHARDS }, (_, shard) =>
      readJson<string>(shardPath(keyword, shard), true),
    ),
  );
  const texts = reads.map((raw) => (typeof raw === "string" ? raw : ""));
  return KnownApps.fromShardText(keyword, texts);
}

/** Write only the shards that changed since the last save. */
export async function saveKnownApps(known: KnownApps): Promise<void> {
  const dirty = known.dirtyShards();
  for (const shard of dirty) {
    await writeJson(
      shardPath(known.keyword, shard),
      known.shardText(shard),
      `psa: known ${known.keyword} ${shard}`,
    );
  }
  known.clearDirty(dirty);
}
