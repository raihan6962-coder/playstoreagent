import { after } from "next/server";
import { beginEmailTick, executeEmailTick } from "@/lib/server/emailSender";
import { isValidTaskId } from "@/lib/server/tasks";

export const maxDuration = 300;

function jsonError(status: number, error: string): Response {
  return Response.json({ error }, { status });
}

/**
 * One email-send slice, self-chained exactly like the lead tick: acquire the
 * task's email lease (or report busy/final), register the send loop in
 * `after()`, return 202 — the loop then walks leads at the configured
 * interval and fetches this route again at the end. Authenticated by the
 * per-task email token (server chain, sweep, nothing else).
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  if (!isValidTaskId(id)) return jsonError(404, "Unknown task.");

  const token = request.headers.get("x-task-token") ?? "";
  let begin: Awaited<ReturnType<typeof beginEmailTick>>;
  try {
    begin = await beginEmailTick(id, token);
  } catch (error) {
    console.error("email tick begin failed", error);
    return jsonError(503, "Email storage unavailable.");
  }

  switch (begin.kind) {
    case "step": {
      const origin = new URL(request.url).origin;
      after(() => executeEmailTick(origin, id, begin.task));
      return Response.json({ ok: true, kind: "step" }, { status: 202 });
    }
    case "busy":
      return Response.json({ ok: true, kind: "busy" }, { status: 202 });
    case "final":
      return Response.json({ ok: true, kind: "final", status: begin.status }, { status: 200 });
    case "missing":
      return jsonError(404, "Unknown task.");
    case "forbidden":
      return jsonError(401, "Bad task token.");
  }
}
