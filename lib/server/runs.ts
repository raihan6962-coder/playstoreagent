/**
 * Server-driven runs: create → tick → checkpoint → chain, with the browser
 * acting purely as a polling observer. This is what lets a search keep
 * collecting leads after the tab is closed — the continuation lives in a
 * self-chaining serverless tick (each tick's `after()` work finishes by
 * fetching the next tick and awaiting only its headers), not in the client.
 *
 * Concurrency model:
 *  - The meta file holds status/token (any writer: stop, resume, finalize).
 *  - The state file holds cursor/stats/log + a lease (single writer: the tick
 *    that owns `leaseUntil`). `beginTick` is the mutex: it acquires the lease
 *    or reports busy, so a chained tick and a user Resume can never run a step
 *    concurrently.
 *  - The tick releases the lease (`leaseUntil = 0`) in its final checkpoint
 *    *before* chaining, so the next `beginTick` can acquire it.
 *
 * Durability: checkpoints every CHECKPOINT_MS persist cursor/stats/log/leads
 * and re-read the meta file (that is how a Stop request reaches a live step —
 * the crawler's `aborted()` sees the flag within one checkpoint). If the
 * instance dies, checkpoints stop, `updatedAt` ages out and the snapshot
 * reports `stalled` → the client's Resume re-kicks the chain.
 */

import { randomUUID, timingSafeEqual } from "node:crypto";
import { generateSecondaryKeywords, primeRoundOne } from "@/lib/keywords/secondary";
import { createInitialCursor, runGenerationStep } from "@/lib/playstore/crawler";
import { buildPlanQueries, planSize } from "@/lib/playstore/queryPlan";
import { mutateJson, readJson, StoreError, writeJson } from "@/lib/server/stateStore";
import type {
  DoneReason,
  GenerationEvent,
  GenerationStats,
  Lead,
  LeadFilters,
  SessionCursor,
} from "@/types/lead";
import type {
  LogEntry,
  RunStatus,
  SnapshotStatus,
} from "@/types/run";

/** One tick's step budget — leaves headroom below the route's maxDuration. */
const TICK_BUDGET_MS = 240_000;
/** Extra lease time past the budget so clock skew cannot free a live step. */
const LEASE_MARGIN_MS = 45_000;
const CHECKPOINT_MS = 10_000;
const HEARTBEAT_MS = 20_000;
const LOG_MAX = 300;
/** No writes for this long while claiming `running` ⇒ the step is gone. */
const STALLED_MS = 60_000;
/**
 * Queries a run may spend before the `query-cap` backstop stops it. Every
 * Resume of a query-capped run grants the next tranche of the same size, so
 * the cap bounds *unattended* spinning, not a user who keeps pressing Resume.
 */
export const DEFAULT_QUERY_BUDGET = 50_000;
export const QUERY_BUDGET_GRANT = 50_000;
/**
 * How long a run that ended on a storage rate limit waits before the sweep
 * restarts it unattended. Long enough that the window has usually moved,
 * self-limiting because a fresh rate-limit just re-ends the run and restarts
 * this clock.
 */
const RATE_LIMIT_REVIVE_MS = 10 * 60_000;

/**
 * Ids of runs the sweep should watch. Create appends; the sweep prunes
 * (finished runs) and adds nothing else — one writer at a time is enforced
 * by the store's per-path queue inside `mutateJson`.
 */
const ACTIVE_INDEX_PATH = "runs/_active.json";
const ACTIVE_INDEX_CAP = 100;

interface ActiveIndex {
  ids: string[];
  updatedAt: number;
}

/**
 * Per-app progress lines the live log deliberately drops: they would flood the
 * panel (one per query / one per detail fetch) while `stats.currentQuery` and
 * the counters already show that activity. Everything else — phase changes,
 * keyword rounds, waves, leads, warnings, the finish message — is kept.
 */
const SUPPRESSED_LOG_PREFIXES = [
  "Searching Play Store for",
  "Fetching details for",
  "Exploring apps related to",
];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isValidRunId(runId: string): boolean {
  return UUID_RE.test(runId);
}

function metaPath(runId: string): string {
  return `runs/${runId}.meta.json`;
}
function statePath(runId: string): string {
  return `runs/${runId}.state.json`;
}
function leadsPath(runId: string): string {
  return `runs/${runId}.leads.json`;
}

function tokenMatches(expected: string, got: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(got, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface RunMeta {
  runId: string;
  token: string;
  status: RunStatus;
  reason: DoneReason | null;
  message: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface RunState {
  runId: string;
  keyword: string;
  filters: LeadFilters;
  cursor: SessionCursor;
  stats: GenerationStats;
  log: LogEntry[];
  logSeq: number;
  /** Bumped on every state write — the client's `since` cursor. */
  version: number;
  leadsVersion: number;
  /** Persisted write counter (diagnostics + squash cadence bookkeeping). */
  seq: number;
  /** Lease window of the tick currently running a step; 0 = nobody holds it. */
  leaseUntil: number;
  createdAt: number;
  updatedAt: number;
  startedAt: number;
  stepCount: number;
  /** Query tranche granted to this run; topped up on Resume after `query-cap`. */
  queryBudget: number;
}

function emptyStats(filters: LeadFilters, cursor: SessionCursor): GenerationStats {
  return {
    ...cursor.counters,
    keyword: filters.keyword,
    target: filters.limit,
    queriesTotal: planSize(
      buildPlanQueries(cursor.keyword, cursor.suggestions, cursor.secondary, cursor.extraTail),
    ),
    currentQuery: null,
    phase: cursor.phase,
    wave: cursor.wave,
    elapsedMs: 0,
  };
}

function withElapsed(stats: GenerationStats, state: RunState): GenerationStats {
  return { ...stats, elapsedMs: Date.now() - state.startedAt };
}

function appendLog(state: RunState, kind: LogEntry["kind"], message: string): void {
  if (SUPPRESSED_LOG_PREFIXES.some((prefix) => message.startsWith(prefix))) return;
  const last = state.log[state.log.length - 1];
  if (last && last.kind === kind && last.message === message) {
    last.t = Date.now();
    return;
  }
  state.logSeq += 1;
  state.log.push({ id: state.logSeq, t: Date.now(), kind, message });
  while (state.log.length > LOG_MAX) state.log.shift();
}

/** Strip the heavyweight free text — neither the table nor the CSV reads it. */
function stripLead(lead: Lead): Lead {
  return { ...lead, summary: null, description: null };
}

function heartbeat(state: RunState): string {
  const { matched, target, queriesRun } = {
    matched: state.stats.matched,
    target: state.stats.target,
    queriesRun: state.stats.queriesRun,
  };
  return `Still working — ${matched}/${target} leads after ${queriesRun} queries.`;
}

export interface CreateRunResult {
  runId: string;
  token: string;
}

/** Validate + persist a new run; the caller kicks the first tick via after(). */
export async function createRun(filters: LeadFilters): Promise<CreateRunResult> {
  const runId = randomUUID();
  const token = randomUUID();
  const now = Date.now();
  const cursor = createInitialCursor(filters.keyword);
  const state: RunState = {
    runId,
    keyword: filters.keyword,
    filters,
    cursor,
    stats: emptyStats(filters, cursor),
    log: [],
    logSeq: 0,
    version: 1,
    leadsVersion: 0,
    seq: 1,
    leaseUntil: 0,
    createdAt: now,
    updatedAt: now,
    startedAt: now,
    stepCount: 0,
    queryBudget: DEFAULT_QUERY_BUDGET,
  };
  appendLog(
    state,
    "info",
    `Run created for “${filters.keyword}” — target ${filters.limit} leads, rating ≤ ${filters.maxRating}, installs ≤ ${filters.maxInstalls}.`,
  );
  const meta: RunMeta = {
    runId,
    token,
    status: "running",
    reason: null,
    message: null,
    createdAt: now,
    updatedAt: now,
  };
  await writeJson(metaPath(runId), meta, `psa: create ${runId}`);
  await writeJson(statePath(runId), state, `psa: create ${runId}`);
  // Best-effort: without the index entry the sweep would never notice this
  // run if its chain died — but a failing store has already failed the create
  // writes above, so this only guards a partial outage.
  await addToActiveIndex(runId);
  return { runId, token };
}

/** Append a run to the sweep's watch list (serialized against sweep prunes). */
async function addToActiveIndex(runId: string): Promise<void> {
  try {
    await mutateJson<ActiveIndex>(
      ACTIVE_INDEX_PATH,
      (current) => {
        const ids = Array.isArray(current?.ids)
          ? current.ids.filter((id) => isValidRunId(id))
          : [];
        if (!ids.includes(runId)) ids.push(runId);
        return { ids: ids.slice(-ACTIVE_INDEX_CAP), updatedAt: Date.now() };
      },
      "psa: index add",
    );
  } catch (error) {
    console.error("active index add failed", error);
  }
}

export type TickBegin =
  | { kind: "step"; state: RunState }
  | { kind: "busy" }
  | { kind: "final"; status: RunStatus }
  | { kind: "missing" }
  | { kind: "forbidden" };

/**
 * The tick mutex. Runs in the route handler (before `after()`), so a second
 * tick arriving while the lease is held gets `busy` and does not schedule a
 * step. Also finalizes a pending Stop when no step is alive to see it.
 */
export async function beginTick(runId: string, token: string): Promise<TickBegin> {
  const meta = await readJson<RunMeta>(metaPath(runId), true);
  if (!meta || meta.runId !== runId) return { kind: "missing" };
  if (!tokenMatches(meta.token, token)) return { kind: "forbidden" };

  if (meta.status === "stop-requested") {
    await finalizeStop(meta);
    return { kind: "final", status: "stopped" };
  }
  if (meta.status === "stopped" || meta.status === "done") {
    return { kind: "final", status: meta.status };
  }

  const state = await readJson<RunState>(statePath(runId), true);
  if (!state) return { kind: "missing" };
  if (state.leaseUntil > Date.now()) return { kind: "busy" };

  state.leaseUntil = Date.now() + TICK_BUDGET_MS + LEASE_MARGIN_MS;
  state.version += 1;
  state.seq += 1;
  state.updatedAt = Date.now();
  await writeJson(statePath(runId), state, `psa: tick ${runId}`);
  return { kind: "step", state };
}

async function finalizeStop(meta: RunMeta): Promise<void> {
  meta.status = "stopped";
  meta.reason = null;
  meta.message = "Stopped.";
  meta.updatedAt = Date.now();
  await writeJson(metaPath(meta.runId), meta, `psa: stopped ${meta.runId}`);
}

async function writeMetaStatus(
  runId: string,
  status: RunStatus,
  reason: DoneReason | null,
  message: string | null,
): Promise<void> {
  const meta = await readJson<RunMeta>(metaPath(runId), true);
  if (!meta) return;
  if (status !== "stopped" && meta.status === "stop-requested") {
    // A Stop arrived while the step was finishing. The step is over now, so
    // there is nobody left to observe the flag — complete the stop instead of
    // letting the run sit in `stop-requested` forever.
    await finalizeStop(meta);
    return;
  }
  if (meta.status === "stopped" && status !== "stopped") return;
  meta.status = status;
  meta.reason = reason;
  meta.message = message;
  meta.updatedAt = Date.now();
  await writeJson(metaPath(runId), meta, `psa: ${status} ${runId}`);
}

/**
 * One step + bookkeeping + chain. Runs inside the route's `after()` window:
 * the tick's response (202) is already on the wire when this starts, and the
 * chained fetch at the end returns as soon as the next tick's headers arrive.
 */
export async function executeTick(
  origin: string,
  runId: string,
  token: string,
  state: RunState,
): Promise<void> {
  let stopSeen = false;
  let leadsDirty = false;
  let leads: Lead[] = [];
  let checkpointWrites: Promise<unknown> = Promise.resolve();
  // Holder object: the done message is assigned inside emit(), which TS's
  // control-flow analysis cannot see when we read it after the step.
  const lastDone: { value: { reason: DoneReason; message: string } | null } = {
    value: null,
  };

  const checkpoint = async (): Promise<void> => {
    try {
      const meta = await readJson<RunMeta>(metaPath(runId), true);
      if (meta?.status === "stop-requested") stopSeen = true;
      const lastT = state.log[state.log.length - 1]?.t ?? 0;
      if (Date.now() - lastT > HEARTBEAT_MS) appendLog(state, "phase", heartbeat(state));
      if (leadsDirty) {
        state.leadsVersion += 1;
        await writeJson(leadsPath(runId), leads, `psa: leads ${runId}`);
        leadsDirty = false;
      }
      state.version += 1;
      state.seq += 1;
      state.updatedAt = Date.now();
      await writeJson(statePath(runId), state, `psa: checkpoint ${runId}`);
    } catch {
      // Store hiccup mid-step: the next checkpoint (or the final write) retries.
    }
  };

  let checkpointTimer: ReturnType<typeof setInterval> | null = null;

  try {
    // Read the leads file inside the try: a storage blip here must take the
    // failure path below (log + release the lease), not reject the after()
    // callback and leave the lease stuck until it expires.
    leads = (await readJson<Lead[]>(leadsPath(runId), true)) ?? [];

    // Start checkpointing before the Groq prime call: it is not abortable, so
    // it needs keepalive writes (and Stop visibility) of its own.
    checkpointTimer = setInterval(() => {
      checkpointWrites = checkpointWrites.then(checkpoint);
    }, CHECKPOINT_MS);

    // Round one of the keyword-generation loop, once per run (the crawler
    // fires rounds 2..MAX itself whenever the plan runs dry mid-step).
    if (!state.cursor.secondaryTried) {
      appendLog(state, "phase", `Generating related search keywords for “${state.keyword}”…`);
      const prime = await primeRoundOne(state.cursor);
      if (prime.generated > 0) {
        appendLog(state, "phase", `Queued ${prime.generated} related keywords to search as well.`);
      } else {
        appendLog(
          state,
          "warn",
          "No related keywords generated — continuing with the main keyword.",
        );
      }
    }

    const emit = (event: GenerationEvent): void => {
      switch (event.type) {
        case "progress":
          state.stats = withElapsed(event.stats, state);
          appendLog(state, "info", event.message);
          break;
        case "lead": {
          const stripped = stripLead(event.lead);
          if (!leads.some((lead) => lead.packageName === stripped.packageName)) {
            leads.push(stripped);
          }
          leadsDirty = true;
          state.stats = withElapsed(event.stats, state);
          appendLog(
            state,
            "lead",
            `Found “${event.lead.title}” — ${event.stats.matched}/${event.stats.target} leads.`,
          );
          break;
        }
        case "lead-update": {
          const existing = leads.find((lead) => lead.packageName === event.app.packageName);
          if (existing) {
            Object.assign(existing, stripLead({ ...existing, ...event.app } as Lead));
            leadsDirty = true;
          }
          break;
        }
        case "lead-remove":
          leads = leads.filter((lead) => lead.packageName !== event.packageName);
          leadsDirty = true;
          break;
        case "warning":
          appendLog(state, "warn", event.message);
          break;
        case "done":
          lastDone.value = { reason: event.reason, message: event.message };
          state.stats = withElapsed(event.stats, state);
          appendLog(state, "done", event.message);
          break;
        case "error":
          appendLog(state, "error", event.message);
          break;
      }
    };

    const result = await runGenerationStep({
      filters: state.filters,
      cursor: state.cursor,
      budgetMs: TICK_BUDGET_MS,
      emit,
      generateSecondary: generateSecondaryKeywords,
      aborted: () => stopSeen,
      queryBudget: state.queryBudget ?? DEFAULT_QUERY_BUDGET,
    });

    if (checkpointTimer) clearInterval(checkpointTimer);
    checkpointTimer = null;
    await checkpointWrites;

    state.cursor = result.cursor ?? state.cursor;
    state.stats = withElapsed(result.stats, state);

    // Leads first, then state: the state file carries leadsVersion, so it has
    // to be written after the leads file it points at. The final state write
    // also releases the lease — before the chained tick's beginTick, which is
    // what lets that tick acquire the mutex.
    if (leadsDirty) {
      state.leadsVersion += 1;
      await writeJson(leadsPath(runId), leads, `psa: leads ${runId}`);
      leadsDirty = false;
    }
    state.version += 1;
    state.seq += 1;
    state.stepCount += 1;
    state.updatedAt = Date.now();
    state.leaseUntil = 0;
    await writeJson(statePath(runId), state, `psa: ${result.reason} ${runId}`);

    const finished = stopSeen || result.reason !== "budget-exhausted";
    if (finished) {
      if (stopSeen) {
        await writeMetaStatus(runId, "stopped", null, "Stopped.");
      } else {
        const message = lastDone.value?.message ?? result.message;
        await writeMetaStatus(runId, "done", result.reason, message);
      }
      return;
    }

    // Budget exhausted with no Stop pending: chain the next tick. Awaiting
    // headers keeps this invocation inside its own response lifecycle while
    // the next one starts its step in its after() window. If every attempt
    // fails the snapshot ages into `stalled` and the client's Resume re-kicks.
    await postTick(origin, runId, token);
  } catch (error) {
    if (checkpointTimer) clearInterval(checkpointTimer);
    const message = error instanceof Error ? error.message : "Unexpected server error.";
    try {
      appendLog(state, "error", message);
      state.updatedAt = Date.now();
      state.leaseUntil = 0;
      state.version += 1;
      await writeJson(statePath(runId), state, `psa: failed ${runId}`);
      await writeMetaStatus(runId, "done", "failed", message);
    } catch {
      // If even the failure record cannot be written the store is
      // unavailable/rate-limited: lease + updatedAt simply age out and the
      // run surfaces as `stalled`, resumable once the store recovers.
    }
  }
}

export interface SnapshotOptions {
  /** Skip the log payload when the caller already has entries up to this id. */
  logSince?: number;
  /** Skip the leads payload when the caller's leadsVersion matches. */
  leadsSince?: number;
}

export type SnapshotResult =
  | { ok: false; code: 401 | 404 }
  | {
      ok: true;
      runId: string;
      status: SnapshotStatus;
      reason: DoneReason | null;
      message: string | null;
      stats: GenerationStats;
      log: LogEntry[] | null;
      leads: Lead[] | null;
      versions: { state: number; leads: number; logLastId: number };
    };

export async function snapshotRun(
  runId: string,
  token: string,
  options: SnapshotOptions = {},
): Promise<SnapshotResult> {
  const meta = await readJson<RunMeta>(metaPath(runId), true);
  if (!meta || meta.runId !== runId) return { ok: false, code: 404 };
  if (!tokenMatches(meta.token, token)) return { ok: false, code: 401 };

  const state = await readJson<RunState>(statePath(runId), true);
  if (!state) return { ok: false, code: 404 };

  const stalled =
    meta.status === "running" && Date.now() - state.updatedAt > STALLED_MS;
  const status: SnapshotStatus = stalled ? "stalled" : meta.status;

  const logLastId = state.logSeq;
  const log =
    options.logSince !== undefined && options.logSince >= logLastId
      ? null
      : state.log;

  let leads: Lead[] | null = null;
  if (options.leadsSince === undefined || options.leadsSince < state.leadsVersion) {
    leads = (await readJson<Lead[]>(leadsPath(runId), true)) ?? [];
  }

  return {
    ok: true,
    runId,
    status,
    reason: meta.reason,
    message: meta.message,
    stats: withElapsed(state.stats, state),
    log,
    leads,
    versions: { state: state.version, leads: state.leadsVersion, logLastId },
  };
}

export type ActionResult =
  | { ok: false; code: 401 | 404 | 409; error: string }
  | { ok: true; status: SnapshotStatus };

/** Stop: flip the meta file; a live step sees it at its next checkpoint. */
export async function stopRun(runId: string, token: string): Promise<ActionResult> {
  const meta = await readJson<RunMeta>(metaPath(runId), true);
  if (!meta || meta.runId !== runId) return { ok: false, code: 404, error: "Unknown run." };
  if (!tokenMatches(meta.token, token)) return { ok: false, code: 401, error: "Bad token." };

  if (meta.status === "stopped" || meta.status === "done") {
    return { ok: true, status: meta.status };
  }

  if (meta.status === "running") {
    meta.status = "stop-requested";
    meta.updatedAt = Date.now();
    await writeJson(metaPath(runId), meta, `psa: stop ${runId}`);
  }

  const state = await readJson<RunState>(statePath(runId), true);
  if (state && state.leaseUntil < Date.now()) {
    // No live step to observe the flag (lease already released or the step
    // died) — finalize right now instead of waiting for a tick that may never
    // come. A chained tick in flight simply observes `stopped` and ends.
    const fresh = await readJson<RunMeta>(metaPath(runId), true);
    if (fresh && fresh.status === "stop-requested") await finalizeStop(fresh);
    return { ok: true, status: "stopped" };
  }
  return { ok: true, status: "stop-requested" };
}

/** Resume a stopped/done run, or a run whose step died (stalled chain). */
export async function resumeRun(
  runId: string,
  token: string,
  origin: string,
): Promise<ActionResult> {
  const meta = await readJson<RunMeta>(metaPath(runId), true);
  if (!meta || meta.runId !== runId) return { ok: false, code: 404, error: "Unknown run." };
  if (!tokenMatches(meta.token, token)) return { ok: false, code: 401, error: "Bad token." };

  if (meta.status === "stop-requested") {
    return { ok: false, code: 409, error: "The run is stopping — retry in a moment." };
  }

  if (meta.status === "running") {
    const state = await readJson<RunState>(statePath(runId), true);
    if (!state) return { ok: false, code: 404, error: "Run state is missing." };
    if (Date.now() - state.updatedAt <= STALLED_MS) {
      return { ok: false, code: 409, error: "The run is already working." };
    }
    // Chain died; kick it again below. A live step keeps updatedAt fresh, so
    // a lease that is still held belongs to a step that died mid-flight —
    // release it or the kicked tick would just read `busy` until expiry.
    if (state.leaseUntil > Date.now()) {
      state.leaseUntil = 0;
      state.version += 1;
      state.seq += 1;
      await writeJson(statePath(runId), state, `psa: resume ${runId}`);
    }
  } else {
    const priorReason = meta.reason;
    meta.status = "running";
    meta.reason = null;
    meta.message = null;
    meta.updatedAt = Date.now();
    await writeJson(metaPath(runId), meta, `psa: resume ${runId}`);
    // Refresh updatedAt on the state too: a second Resume click arriving
    // before the kicked tick acquires its lease must read "working", not
    // "stalled", or both would kick a tick and race for the step.
    const state = await readJson<RunState>(statePath(runId), true);
    if (state) {
      state.updatedAt = Date.now();
      state.version += 1;
      state.seq += 1;
      // Resuming a query-capped run is the explicit approval to keep going:
      // grant the next query tranche so the backstop never blocks a user.
      if (priorReason === "query-cap") {
        state.queryBudget = (state.queryBudget ?? DEFAULT_QUERY_BUDGET) + QUERY_BUDGET_GRANT;
      }
      await writeJson(statePath(runId), state, `psa: resume ${runId}`);
    }
  }

  try {
    if (!(await postTick(origin, runId, token, RESUME_POLICY))) {
      return { ok: false, code: 409, error: "Could not reach the runner — try again." };
    }
  } catch {
    return { ok: false, code: 409, error: "Could not reach the runner — try again." };
  }
  return { ok: true, status: "running" };
}

/**
 * Retry policies per call site — each must fit the window its caller runs in
 * (create's `after()` 60s, tick's 300s, a button click, the sweep's 60s).
 */
interface TickPolicy {
  attempts: number;
  backoffsMs: number[];
  timeoutMs: number;
}

/** executeTick's chain, inside the tick route's maxDuration window. */
const CHAIN_POLICY: TickPolicy = {
  attempts: 5,
  backoffsMs: [2_000, 5_000, 15_000, 30_000],
  timeoutMs: 12_000,
};
/** The create route's after() window (60s) — keep the first kick inside it. */
const KICK_POLICY: TickPolicy = { attempts: 3, backoffsMs: [2_000, 5_000], timeoutMs: 12_000 };
/** Resume answers a button click — fail fast; sweep and client retry anyway. */
const RESUME_POLICY: TickPolicy = { attempts: 2, backoffsMs: [2_000], timeoutMs: 8_000 };
/** The sweep's own 60s route budget. */
const SWEEP_POLICY: TickPolicy = { attempts: 2, backoffsMs: [3_000], timeoutMs: 10_000 };

/**
 * One self-chain hop: POST the tick route, retrying briefly on transient
 * failures (a single api.github.com connect timeout must not kill a run —
 * that is exactly how a live run used to die silently and surface as
 * `stalled`). 401/404 are permanent and return immediately; success is any
 * 2xx (202 = step scheduled or busy, 200 = run already final).
 */
async function postTick(
  origin: string,
  runId: string,
  token: string,
  policy: TickPolicy = CHAIN_POLICY,
): Promise<boolean> {
  for (let attempt = 0; attempt < policy.attempts; attempt += 1) {
    if (attempt > 0) {
      await new Promise((resolve) => setTimeout(resolve, policy.backoffsMs[attempt - 1] ?? 5_000));
    }
    try {
      const response = await fetch(`${origin}/api/runs/${runId}/tick`, {
        method: "POST",
        headers: { "x-run-token": token },
        cache: "no-store",
        signal: AbortSignal.timeout(policy.timeoutMs),
      });
      await response.body?.cancel();
      if (response.ok) return true;
      if (response.status === 401 || response.status === 404) {
        console.error(`tick chain rejected (${response.status}) for ${runId}`);
        return false;
      }
      console.error(`tick chain got ${response.status} for ${runId} (attempt ${attempt + 1})`);
    } catch (error) {
      console.error(`tick chain failed for ${runId} (attempt ${attempt + 1})`, error);
    }
  }
  return false;
}

/** First kick after createRun. */
export async function kickTick(origin: string, runId: string, token: string): Promise<void> {
  // Retries inside; if every attempt fails the external sweep (and the
  // client's auto-resume) re-kicks once the checkpoints age out.
  await postTick(origin, runId, token, KICK_POLICY);
}

export interface SweepResult {
  /** Runs examined (present in the index with a readable state file). */
  checked: number;
  /** Checkpoints still fresh — the chain is alive, nothing to do. */
  healthy: number;
  /** Quiet runs whose lease is still held: wait for expiry, then kick. */
  leaseHeld: number;
  /** Stalled runs whose tick was kicked this sweep. */
  kicked: number;
  /** Rate-limited runs revived this sweep. */
  revived: number;
  /** Index entries dropped (files gone or run finished). */
  pruned: number;
  store: "ok" | "rate-limited" | "error";
}

/**
 * The external watchdog (a GitHub Actions schedule hits `/api/cron/sweep`
 * every five minutes): for every watched run whose checkpoints went quiet,
 * restart the self-chain. This is what makes "the automation keeps going
 * until the target" hold across instance deaths, exhausted in-process
 * retries and storage rate limits — cases no in-process retry can outlive.
 * Healthy runs cost one conditional read (304 ⇒ free); finished runs are
 * pruned; a run that ended on a rate limit is revived once its window has
 * had ten minutes to move.
 */
export async function sweepStalledRuns(origin: string): Promise<SweepResult> {
  const result: SweepResult = {
    checked: 0,
    healthy: 0,
    leaseHeld: 0,
    kicked: 0,
    revived: 0,
    pruned: 0,
    store: "ok",
  };

  let kept: string[];
  try {
    const index = await readJson<ActiveIndex>(ACTIVE_INDEX_PATH, true);
    kept = Array.isArray(index?.ids) ? index.ids.filter((id) => isValidRunId(id)) : [];
  } catch (error) {
    result.store =
      error instanceof StoreError && error.kind === "rate-limit" ? "rate-limited" : "error";
    return result;
  }

  const remove = new Set<string>();
  for (const runId of kept) {
    try {
      const state = await readJson<RunState>(statePath(runId), true);
      if (!state) {
        remove.add(runId);
        continue;
      }
      result.checked += 1;
      if (Date.now() - state.updatedAt <= STALLED_MS) {
        result.healthy += 1;
        continue;
      }

      const meta = await readJson<RunMeta>(metaPath(runId), true);
      if (!meta || meta.runId !== runId) {
        remove.add(runId);
        continue;
      }

      if (meta.status !== "running") {
        if (meta.status === "done" && meta.reason === "rate-limited") {
          if (Date.now() - meta.updatedAt < RATE_LIMIT_REVIVE_MS) continue; // keep watching
          // Ten quiet minutes: restart unattended. If the limit is still on,
          // the run re-ends as rate-limited and this clock starts over — the
          // attempt loop is self-limiting.
          meta.status = "running";
          meta.reason = null;
          meta.message = null;
          meta.updatedAt = Date.now();
          await writeJson(metaPath(runId), meta, `psa: revive ${runId}`);
          state.updatedAt = Date.now();
          state.version += 1;
          state.seq += 1;
          await writeJson(statePath(runId), state, `psa: revive ${runId}`);
          if (await postTick(origin, runId, meta.token, SWEEP_POLICY)) result.revived += 1;
        } else {
          remove.add(runId); // stopped or finished for good
        }
        continue;
      }

      // Claimed `running` but quiet. A live step keeps updatedAt fresh AND
      // its lease held, so a held lease here means the step may still be
      // finishing (or just died) — wait for expiry instead of risking two
      // writers on one state file.
      if (state.leaseUntil > Date.now()) {
        result.leaseHeld += 1;
        continue;
      }

      if (await postTick(origin, runId, meta.token, SWEEP_POLICY)) result.kicked += 1;
    } catch (error) {
      // The store stopped answering (typically rate-limited): abort without
      // pruning — the next sweep retries everything from a healthy store.
      result.store =
        error instanceof StoreError && error.kind === "rate-limit" ? "rate-limited" : "error";
      return result;
    }
  }

  if (remove.size > 0) {
    const ids = kept.filter((id) => !remove.has(id));
    try {
      await mutateJson<ActiveIndex>(
        ACTIVE_INDEX_PATH,
        () => ({ ids, updatedAt: Date.now() }),
        "psa: index prune",
      );
      result.pruned = remove.size;
    } catch {
      // Best-effort: stale entries are re-pruned next sweep.
    }
  }
  return result;
}

/** Map storage failures onto HTTP responses. */
export function storeErrorResponse(error: unknown): Response | null {
  if (!(error instanceof StoreError)) return null;
  if (error.kind === "rate-limit") {
    return Response.json(
      { error: "Storage is rate-limited — try again shortly.", retryAt: error.retryAt },
      { status: 429 },
    );
  }
  if (error.kind === "config") {
    return Response.json({ error: "Storage is not configured." }, { status: 503 });
  }
  return Response.json({ error: "Storage is unavailable — try again." }, { status: 502 });
}
