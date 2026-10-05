import { removeMailbox } from "@/lib/server/mailboxes";
import { storeErrorResponse } from "@/lib/server/runs";
import { allowRequest, clientIp } from "@/lib/server/rateLimit";
import { isValidTaskId, listTasks } from "@/lib/server/tasks";

export const maxDuration = 60;

function jsonError(status: number, error: string): Response {
  return Response.json({ error }, { status });
}

/**
 * Disconnect a mailbox. Blocked while a non-finished task still selects it —
 * removing it from under a pipeline in flight would strand that task's
 * remaining sends.
 */
export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  if (!isValidTaskId(id)) return jsonError(404, "Unknown mailbox.");
  if (!allowRequest(clientIp(request))) {
    return jsonError(429, "Too many requests. Please wait a moment and try again.");
  }

  try {
    const tasks = await listTasks();
    const inUse = tasks.filter(
      (task) =>
        task.mailboxIds.includes(id) &&
        task.status !== "done" &&
        task.status !== "failed",
    );
    if (inUse.length > 0) {
      return jsonError(
        409,
        `This mailbox is used by ${inUse.length} unfinished task${inUse.length === 1 ? "" : "s"} — delete those first.`,
      );
    }
    const removed = await removeMailbox(id);
    if (!removed) return jsonError(404, "Unknown mailbox.");
    return Response.json({ ok: true });
  } catch (error) {
    return storeErrorResponse(error) ?? jsonError(500, "Could not remove the mailbox.");
  }
}
