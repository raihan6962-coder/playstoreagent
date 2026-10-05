import { after } from "next/server";
import { beginTick, executeTick, isValidRunId } from "@/lib/server/runs";

export const maxDuration = 300;

function jsonError(status: number, error: string): Response {
  return Response.json({ error }, { status });
}

/**
 * One unit of server-side progress, self-chained: the handler acquires the
 * run's lease (or reports busy/final), registers the step in `after()`, and
 * returns 202 immediately — so awaiting this fetch's headers costs the caller
 * nothing while the step runs for up to TICK_BUDGET_MS inside this
 * invocation's own response lifecycle. At the end of its step the caller
 * fetches this route again, which is how a run continues after the browser
 * tab (and even this invocation) is gone.
 *
 * No IP rate limit: it is authenticated by the per-run token and only our own
 * chain or an authorized client can call it.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  if (!isValidRunId(id)) return jsonError(404, "Unknown run.");

  const token = request.headers.get("x-run-token") ?? "";
  let begin: Awaited<ReturnType<typeof beginTick>>;
  try {
    begin = await beginTick(id, token);
  } catch (error) {
    // Storage unavailable: leave the run as-is (it ages into `stalled`).
    console.error("tick begin failed", error);
    return jsonError(503, "Runner storage unavailable.");
  }

  switch (begin.kind) {
    case "step": {
      const { state } = begin;
      const origin = new URL(request.url).origin;
      after(() => executeTick(origin, id, token, state));
      return Response.json({ ok: true, kind: "step" }, { status: 202 });
    }
    case "busy":
      return Response.json({ ok: true, kind: "busy" }, { status: 202 });
    case "final":
      return Response.json({ ok: true, kind: "final", status: begin.status }, { status: 200 });
    case "missing":
      return jsonError(404, "Unknown run.");
    case "forbidden":
      return jsonError(401, "Bad run token.");
  }
}
