/**
 * Browser side of the run API: create → poll → stop/resume. The browser
 * never drives the search itself (no SSE, no cursor round-trips) — it only
 * attaches to a run the server keeps executing, which is what lets a search
 * survive the tab closing.
 */

import { guardAuth } from "@/lib/client/guard";
import type {
  CreateRunResponse,
  RunActionResponse,
  RunSnapshotResponse,
} from "@/types/run";

export interface AttachedRun {
  runId: string;
  token: string;
}

const STORAGE_KEY = "psa.activeRun";

export class RunRequestError extends Error {
  constructor(message: string, readonly code: number) {
    super(message);
    this.name = "RunRequestError";
  }
}

export function loadAttachedRun(): AttachedRun | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<AttachedRun>;
    if (typeof parsed.runId !== "string" || typeof parsed.token !== "string") return null;
    return { runId: parsed.runId, token: parsed.token };
  } catch {
    return null;
  }
}

export function saveAttachedRun(run: AttachedRun): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(run));
  } catch {
    // Private mode / storage full: the run still works for this session.
  }
}

export function clearAttachedRun(): void {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing to clean up we can reach.
  }
}

export interface CreateRunInput {
  keyword: string;
  maxRating: number;
  maxInstalls: number;
  limit: number;
}

async function readError(response: Response): Promise<RunRequestError> {
  let message = `Request failed (${response.status}).`;
  try {
    const body = (await response.json()) as { error?: unknown };
    if (typeof body.error === "string") message = body.error;
  } catch {
    // Keep the status-line message.
  }
  return new RunRequestError(message, response.status);
}

export async function createRun(input: CreateRunInput): Promise<AttachedRun> {
  const response = await fetch("/api/runs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  guardAuth(response);
  if (!response.ok) throw await readError(response);
  const payload = (await response.json()) as CreateRunResponse;
  const run = { runId: payload.runId, token: payload.token };
  saveAttachedRun(run);
  return run;
}

export interface SnapshotRequest {
  logSince?: number;
  leadsSince?: number;
}

export async function fetchSnapshot(
  run: AttachedRun,
  request: SnapshotRequest = {},
): Promise<RunSnapshotResponse> {
  const url = new URL(`/api/runs/${run.runId}`, window.location.origin);
  if (request.logSince !== undefined) url.searchParams.set("logSince", String(request.logSince));
  if (request.leadsSince !== undefined) {
    url.searchParams.set("leadsSince", String(request.leadsSince));
  }
  const response = await fetch(url, {
    headers: { "x-run-token": run.token },
    cache: "no-store",
  });
  guardAuth(response);
  if (!response.ok) throw await readError(response);
  return (await response.json()) as RunSnapshotResponse;
}

export async function runAction(
  run: AttachedRun,
  action: "stop" | "resume",
): Promise<RunActionResponse> {
  const response = await fetch(`/api/runs/${run.runId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-run-token": run.token },
    body: JSON.stringify({ action }),
  });
  guardAuth(response);
  if (!response.ok) throw await readError(response);
  return (await response.json()) as RunActionResponse;
}
