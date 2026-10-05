/**
 * Durable run storage backed by the contents/git-data API of a *private*
 * GitHub repository (PSA_STATE_REPO). There is no database in this project —
 * Gist needs a scope our token does not have, Vercel Blob's store-creation
 * API is inaccessible from this account, and the main repo is public — so a
 * private scratch repo gives us persistent, per-run JSON files that survive
 * serverless cold starts with no other infrastructure.
 *
 * The browser never talks to GitHub: every read/write goes through our own
 * route handlers, which hold the token server-side.
 *
 * Files per run:
 *   runs/{id}.state.json  cursor, stats, log, lease  (single writer: the tick)
 *   runs/{id}.meta.json   status, token              (any writer: stop/resume)
 *   runs/{id}.leads.json  the passing leads          (written by the tick)
 *
 * History grows one commit per write, so every {@link SQUASH_EVERY} writes the
 * branch is re-rooted to a single root commit (same tree, empty parents) —
 * the repo's history stays ~1 deep while contents keep updating normally.
 */

export class StoreError extends Error {
  constructor(
    message: string,
    readonly kind: "rate-limit" | "conflict" | "not-found" | "server" | "config",
    readonly retryAt?: number,
  ) {
    super(message);
    this.name = "StoreError";
  }
}

const SQUASH_EVERY = 50;
const READ_CACHE_MS = 1_500;

interface CacheEntry {
  at: number;
  raw: unknown;
  sha: string;
  /** Weak/strong validator so unchanged reads can ride GitHub's free 304s. */
  etag?: string;
}

const readCache = new Map<string, CacheEntry>();
/** Per-path write serialization: checkpoint and finalize writes never race. */
const pathQueues = new Map<string, Promise<unknown>>();
let writeCount = 0;
let squashing: Promise<void> | null = null;

function config(): { repo: string; token: string } {
  const repo = process.env.PSA_STATE_REPO ?? "";
  const token = process.env.GITHUB_TOKEN ?? "";
  if (!repo || !token) {
    throw new StoreError(
      "State store is not configured (PSA_STATE_REPO / GITHUB_TOKEN).",
      "config",
    );
  }
  return { repo, token };
}

function api(pathname: string): string {
  return `https://api.github.com${pathname}`;
}

async function gh(pathname: string, init?: RequestInit): Promise<Response> {
  const { token } = config();
  return fetch(api(pathname), {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
    cache: "no-store",
  });
}

function throwFor(response: Response, context: string): never {
  if (response.status === 403 || response.status === 429) {
    const remaining = response.headers.get("x-ratelimit-remaining");
    const reset = Number(response.headers.get("x-ratelimit-reset"));
    const rateLimited = remaining === "0" || response.status === 429;
    throw new StoreError(
      rateLimited
        ? `GitHub rate limit hit while ${context}.`
        : `GitHub refused while ${context} (403).`,
      "rate-limit",
      rateLimited && Number.isFinite(reset) ? reset * 1_000 : Date.now() + 60_000,
    );
  }
  if (response.status === 409 || response.status === 422) {
    throw new StoreError(`Concurrent update while ${context}.`, "conflict");
  }
  if (response.status === 404) {
    throw new StoreError(`Missing while ${context}: 404.`, "not-found");
  }
  throw new StoreError(`GitHub error while ${context}: ${response.status}.`, "server");
}

interface ContentResponse {
  sha?: string;
  content?: string;
  encoding?: string;
}

async function fetchContent(path: string): Promise<{ sha: string; value: unknown } | null> {
  const cached = readCache.get(path);
  const response = await gh(`/repos/${config().repo}/contents/${path}?ref=main`, {
    headers: cached?.etag ? { "If-None-Match": cached.etag } : {},
  });
  if (response.status === 304 && cached) {
    // Unchanged: refresh the TTL and answer from cache. GitHub does not count
    // 304s against the rate limit — that is what keeps a 3s polling client
    // (two conditional reads per poll) inside the hourly budget.
    cached.at = Date.now();
    return { sha: cached.sha, value: cached.raw };
  }
  if (response.status === 404) return null;
  if (!response.ok) throwFor(response, `reading ${path}`);
  const body = (await response.json()) as ContentResponse;
  if (!body.sha || typeof body.content !== "string") {
    throw new StoreError(`Malformed contents response for ${path}.`, "server");
  }
  if (body.encoding !== "base64" || body.content.length === 0) {
    throw new StoreError(
      `${path} exceeds the contents API size limit.`,
      "server",
    );
  }
  const text = Buffer.from(body.content.replace(/\s/g, ""), "base64").toString("utf8");
  const value = JSON.parse(text);
  readCache.set(path, {
    at: Date.now(),
    raw: value,
    sha: body.sha,
    etag: response.headers.get("etag") ?? undefined,
  });
  return { sha: body.sha, value };
}

/**
 * Read a JSON file. Fresh reads bypass the short TTL and go conditional on
 * the cached ETag (a 304 is free and still refreshes the TTL) — used by the
 * tick's lease/stop checks and the snapshot poll, where a stale answer would
 * double-run a step or delay a stop. Returns null for a missing file.
 */
export async function readJson<T>(path: string, fresh = false): Promise<T | null> {
  if (!fresh) {
    const hit = readCache.get(path);
    if (hit && Date.now() - hit.at < READ_CACHE_MS) return hit.raw as T;
  }
  const found = await fetchContent(path);
  if (!found) readCache.delete(path);
  return found ? (found.value as T) : null;
}

async function putContent(path: string, value: unknown, message: string): Promise<void> {
  const body = JSON.stringify(value);
  const content = Buffer.from(body, "utf8").toString("base64");

  const attempt = async (sha?: string): Promise<Response> =>
    gh(`/repos/${config().repo}/contents/${path}`, {
      method: "PUT",
      body: JSON.stringify({
        message,
        content,
        branch: "main",
        ...(sha ? { sha } : {}),
      }),
    });

  // The cache carries the current blob sha — no pre-GET needed for the common
  // single-writer case (that would double every checkpoint's cost).
  let sha = readCache.get(path)?.sha || undefined;
  if (!sha) {
    const existing = await fetchContent(path).catch(() => null);
    sha = existing?.sha;
  }
  let response = await attempt(sha);
  if (response.status === 409 || response.status === 422) {
    // Someone (another instance) wrote between our read and the PUT: re-read
    // the sha and try once more with it.
    const existing = await fetchContent(path);
    response = await attempt(existing?.sha);
  }
  if (!response.ok) throwFor(response, `writing ${path}`);
  const written = (await response.json()) as ContentResponse;
  // Cache the *serialized* payload: callers may keep mutating the object they
  // handed us, and a 304 must answer with exactly what the file contains.
  readCache.set(path, {
    at: Date.now(),
    raw: JSON.parse(body),
    sha: written.sha ?? "",
    etag: response.headers.get("etag") ?? undefined,
  });
}

/** Write a JSON file, counted toward the history squash. */
export function writeJson(path: string, value: unknown, message: string): Promise<void> {
  const previous = pathQueues.get(path) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(() => writeOne(path, value, message));
  pathQueues.set(path, next);
  return next;
}

/**
 * Read-modify-write a file *inside* its path queue, so two updaters of the
 * same file (create appending to the active index, the sweep pruning it)
 * can never lose each other's changes. `mutate` returns the next value, or
 * null/undefined to skip the write.
 */
export function mutateJson<T>(
  path: string,
  mutate: (current: T | null) => T | null | undefined,
  message: string,
): Promise<void> {
  const previous = pathQueues.get(path) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(async () => {
      const current = await readJson<T>(path, true);
      const updated = mutate(current);
      if (updated === undefined || updated === null) return;
      await writeOne(path, updated, message);
    });
  pathQueues.set(path, next);
  return next;
}

async function writeOne(path: string, value: unknown, message: string): Promise<void> {
  // A PUT must never run inside a squash window: the squash force-updates the
  // ref onto the pre-write tree, which would silently revert the PUT. Every
  // writer waits out the in-flight squash first (it runs at most every
  // SQUASH_EVERY writes and takes well under a second).
  if (squashing !== null) await squashing;
  try {
    await putContent(path, value, message);
  } catch (error) {
    // The cache may already hold a caller's pre-write mutation of this path;
    // drop it so the next read re-fetches the truth from the store.
    readCache.delete(path);
    throw error;
  }
  writeCount += 1;
  if (writeCount % SQUASH_EVERY === 0 && squashing === null) {
    squashing = squashHistory().finally(() => {
      squashing = null;
    });
  }
}

/**
 * Re-root the branch onto a brand-new root commit that points at the *same*
 * tree: contents stay byte-identical while every historic commit becomes
 * unreachable, so an unbounded run history can never accumulate.
 * Best-effort — the store keeps working if the squash itself fails.
 */
export async function squashHistory(): Promise<void> {
  try {
    const repo = config().repo;
    const ref = await gh(`/repos/${repo}/git/ref/heads/main`);
    if (!ref.ok) return;
    const headSha = ((await ref.json()) as { object: { sha: string } }).object.sha;
    const commit = await gh(`/repos/${repo}/git/commits/${headSha}`);
    if (!commit.ok) return;
    const treeSha = ((await commit.json()) as { tree: { sha: string } }).tree.sha;
    const created = await gh(`/repos/${repo}/git/commits`, {
      method: "POST",
      body: JSON.stringify({
        message: "psa: squash run-state history",
        tree: treeSha,
        parents: [],
      }),
    });
    if (!created.ok) return;
    const newSha = ((await created.json()) as { sha: string }).sha;
    await gh(`/repos/${repo}/git/refs/heads/main`, {
      method: "PATCH",
      body: JSON.stringify({ sha: newSha, force: true }),
    });
  } catch {
    // Squashing is maintenance, never correctness.
  }
}
