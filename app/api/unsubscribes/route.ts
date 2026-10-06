import { allowRequest, clientIp } from "@/lib/server/rateLimit";
import { storeErrorResponse } from "@/lib/server/runs";
import { listUnsubscribes, removeUnsubscribe } from "@/lib/server/unsubscribes";

export const maxDuration = 15;

function jsonError(status: number, error: string): Response {
  return Response.json({ error }, { status });
}

/** Who opted out — the Inbox page renders and manages this list. */
export async function GET(): Promise<Response> {
  try {
    const entries = await listUnsubscribes();
    return Response.json(
      { ok: true, entries },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return storeErrorResponse(error) ?? jsonError(500, "Could not list unsubscribes.");
  }
}

/** Opt an address back in (management action). */
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
  const { action, email } = raw as { action?: unknown; email?: unknown };
  if (action !== "remove" || typeof email !== "string") {
    return jsonError(400, 'Provide {action: "remove", email}.');
  }
  try {
    const removed = await removeUnsubscribe(email);
    if (!removed) return jsonError(404, "That address is not on the unsubscribe list.");
    return Response.json({ ok: true });
  } catch (error) {
    return storeErrorResponse(error) ?? jsonError(500, "Could not update the list.");
  }
}
