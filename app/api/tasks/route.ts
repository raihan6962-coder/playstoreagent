import {
  createTask,
  listTasks,
  validateTask,
} from "@/lib/server/tasks";
import { storeErrorResponse, snapshotRun } from "@/lib/server/runs";
import { allowRequest, clientIp } from "@/lib/server/rateLimit";
import type { AutomationTask } from "@/types/automation";

export const maxDuration = 60;

function jsonError(status: number, error: string): Response {
  return Response.json({ error }, { status });
}

/** What the browser is allowed to see: no run/email tokens on the wire. */
export type PublicTask = Omit<AutomationTask, "runToken" | "emailToken">;

function publicTask(task: AutomationTask): PublicTask {
  return {
    id: task.id,
    keyword: task.keyword,
    maxRating: task.maxRating,
    maxInstalls: task.maxInstalls,
    limit: task.limit,
    startAt: task.startAt,
    mailboxIds: task.mailboxIds,
    templateSubject: task.templateSubject,
    templateBody: task.templateBody,
    intervalSeconds: task.intervalSeconds,
    status: task.status,
    runId: task.runId,
    leadCount: task.leadCount,
    error: task.error,
    email: task.email,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}

/**
 * Task list for the Automation Settings page. A collecting task reports its
 * live lead count (only ever one or two of those — the pipeline runs
 * serially); everything else reads the recorded final count, so a month of
 * history costs no extra store reads.
 */
export async function GET(): Promise<Response> {
  try {
    const tasks = await listTasks();
    const payload: PublicTask[] = [];
    for (const task of tasks) {
      const item = publicTask(task);
      if (task.status === "collecting" && task.runId && task.runToken) {
        const snapshot = await snapshotRun(task.runId, task.runToken, {
          leadsSince: Number.MAX_SAFE_INTEGER,
          logSince: Number.MAX_SAFE_INTEGER,
        });
        if (snapshot.ok) item.leadCount = snapshot.stats.matched;
      }
      payload.push(item);
    }
    return Response.json(
      { ok: true, tasks: payload },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return storeErrorResponse(error) ?? jsonError(500, "Could not list tasks.");
  }
}

/** Create a scheduled task. */
export async function POST(request: Request): Promise<Response> {
  if (!allowRequest(clientIp(request))) {
    return jsonError(429, "Too many requests. Please wait a moment and try again.");
  }
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return jsonError(400, "Request body must be valid JSON.");
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return jsonError(400, "Request body must be a JSON object.");
  }

  try {
    const validated = await validateTask(raw as Record<string, unknown>);
    if (!validated.ok) return jsonError(400, validated.error);
    const task = await createTask(validated.value);
    return Response.json({ ok: true, task: publicTask(task) }, { status: 201 });
  } catch (error) {
    return storeErrorResponse(error) ?? jsonError(500, "Could not create the task.");
  }
}
