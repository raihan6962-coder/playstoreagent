import type { DoneReason, GenerationStats, Lead } from "./lead";

/** Persisted lifecycle of a server-driven run (meta file is authoritative). */
export type RunStatus = "running" | "stop-requested" | "stopped" | "done";

/**
 * Snapshot status = meta status plus one derived state: `stalled` means the
 * run claims to be running but nothing has been written for a while (its
 * serverless step died without updating anything) — the client offers Resume.
 */
export type SnapshotStatus = RunStatus | "stalled";

export type LogKind = "info" | "warn" | "error" | "lead" | "phase" | "done";

/** One line of the live log panel. `id` is monotonic and never reused. */
export interface LogEntry {
  id: number;
  t: number;
  kind: LogKind;
  message: string;
}

export interface RunVersions {
  state: number;
  leads: number;
  logLastId: number;
}

/** GET /api/runs/[id] success body. */
export interface RunSnapshotResponse {
  ok: true;
  runId: string;
  status: SnapshotStatus;
  reason: DoneReason | null;
  message: string | null;
  stats: GenerationStats;
  /** null = nothing new since the caller's `logSince`. */
  log: LogEntry[] | null;
  /** null = nothing new since the caller's `leadsSince`. */
  leads: Lead[] | null;
  versions: RunVersions;
}

/** POST /api/runs success body. */
export interface CreateRunResponse {
  ok: true;
  runId: string;
  token: string;
}

/** POST /api/runs/[id] ({action}) success body. */
export interface RunActionResponse {
  ok: true;
  status: SnapshotStatus;
}
