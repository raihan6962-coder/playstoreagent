import { deleteTask, isValidTaskId, updateTask, validateTask } from "@/lib/server/tasks";
import { storeErrorResponse } from "@/lib/server/runs";
import { allowRequest, clientIp } from "@/lib/server/rateLimit";

export const maxDuration = 60;

function jsonError(status: number, error: string): Response {
  return Response.json({ error }, { status });
}

/** Edit a scheduled task (start time, filters, template, mailboxes, interval). */
export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  if (!isValidTaskId(id)) return jsonError(404, "Unknown task.");
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
    const result = await updateTask(id, validated.value);
    if (!result.ok) return jsonError(result.code, result.error);
    return Response.json({ ok: true });
  } catch (error) {
    return storeErrorResponse(error) ?? jsonError(500, "Could not update the task.");
  }
}

/** Delete a task (asks a live attached run to stop, fire-and-forget). */
export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  if (!isValidTaskId(id)) return jsonError(404, "Unknown task.");
  try {
    const removed = await deleteTask(id);
    if (!removed) return jsonError(404, "Unknown task.");
    return Response.json({ ok: true });
  } catch (error) {
    return storeErrorResponse(error) ?? jsonError(500, "Could not delete the task.");
  }
}
