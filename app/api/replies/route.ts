import { allowRequest, clientIp } from "@/lib/server/rateLimit";
import { storeErrorResponse } from "@/lib/server/runs";
import { checkReplies, getRepliesState, telegramConfigured } from "@/lib/server/replies";

export const maxDuration = 60;

function jsonError(status: number, error: string): Response {
  return Response.json({ error }, { status });
}

/**
 * Reply inbox: GET the stored history (+ whether Telegram alerts are armed),
 * POST to run a check right now (the hourly cron runs the same code path).
 */
export async function GET(): Promise<Response> {
  try {
    const state = await getRepliesState();
    return Response.json(
      { ok: true, ...state, telegramConfigured: telegramConfigured() },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return storeErrorResponse(error) ?? jsonError(500, "Could not load replies.");
  }
}

export async function POST(request: Request): Promise<Response> {
  if (!allowRequest(clientIp(request))) {
    return jsonError(429, "Too many requests. Please wait a moment and try again.");
  }
  try {
    const summary = await checkReplies();
    const state = await getRepliesState();
    return Response.json({ ok: true, summary, ...state, telegramConfigured: telegramConfigured() });
  } catch (error) {
    return storeErrorResponse(error) ?? jsonError(500, "Reply check failed.");
  }
}
