import { isValidRunId, resumeRun, snapshotRun, stopRun, storeErrorResponse } from "@/lib/server/runs";
import { allowRequest, clientIp } from "@/lib/server/rateLimit";
import type { RunActionResponse, RunSnapshotResponse } from "@/types/run";

function jsonError(status: number, error: string): Response {
  return Response.json({ error }, { status });
}

function tokenOf(request: Request): string {
  return request.headers.get("x-run-token") ?? "";
}

function numberParam(url: URL, name: string): number | undefined {
  const raw = url.searchParams.get(name);
  if (raw === null) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * Snapshot for the polling client. Log and leads ship only when the caller's
 * versions say something changed, so a 3s poll that sees nothing new costs a
 * few hundred bytes. The reads are conditional on GitHub ETags server-side,
 * so polling does not eat the storage rate budget.
 *
 * No IP rate limit here: polling at 3s would trip the create-route limiter;
 * the payload is token-gated instead.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  // The id is also a storage path segment — strict shape check first.
  if (!isValidRunId(id)) return jsonError(404, "Unknown run.");
  const url = new URL(request.url);
  try {
    const snapshot = await snapshotRun(id, tokenOf(request), {
      logSince: numberParam(url, "logSince"),
      leadsSince: numberParam(url, "leadsSince"),
    });
    if (!snapshot.ok) return jsonError(snapshot.code, "Unknown run.");
    const body: RunSnapshotResponse = { ...snapshot };
    return Response.json(body, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return storeErrorResponse(error) ?? jsonError(500, "Snapshot failed.");
  }
}

/** Stop or resume the run. */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  if (!isValidRunId(id)) return jsonError(404, "Unknown run.");
  if (!allowRequest(clientIp(request))) {
    return jsonError(429, "Too many requests. Please wait a moment and try again.");
  }

  let action: unknown;
  try {
    const body = (await request.json()) as { action?: unknown };
    action = body.action;
  } catch {
    return jsonError(400, "Request body must be valid JSON.");
  }
  if (action !== "stop" && action !== "resume") {
    return jsonError(400, "Action must be \"stop\" or \"resume\".");
  }

  const origin = new URL(request.url).origin;
  const token = tokenOf(request);
  try {
    const result =
      action === "stop" ? await stopRun(id, token) : await resumeRun(id, token, origin);
    if (!result.ok) return jsonError(result.code, result.error);
    const body: RunActionResponse = { ok: true, status: result.status };
    return Response.json(body);
  } catch (error) {
    return storeErrorResponse(error) ?? jsonError(500, "Run action failed.");
  }
}
