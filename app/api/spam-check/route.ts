import { allowRequest, clientIp } from "@/lib/server/rateLimit";
import { storeErrorResponse } from "@/lib/server/runs";
import {
  SpamCheckError,
  getSpamCheckConfig,
  getSpamHistory,
  runCheck,
  saveSpamConfig,
  sendDemo,
  validateSpamConfig,
  validateSpamSend,
} from "@/lib/server/spamCheck";

export const maxDuration = 60;

function jsonError(status: number, error: string): Response {
  return Response.json({ error }, { status });
}

function errorResponse(error: unknown): Response {
  if (error instanceof SpamCheckError) return jsonError(error.status, error.message);
  return storeErrorResponse(error) ?? jsonError(500, "Spam check failed.");
}

/** Saved config (checker URL masked) + the demo history. */
export async function GET(): Promise<Response> {
  try {
    const [config, history] = await Promise.all([getSpamCheckConfig(), getSpamHistory()]);
    return Response.json(
      { ok: true, config, history },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return errorResponse(error);
  }
}

/** Save the checker URL and/or the demo template. */
export async function PUT(request: Request): Promise<Response> {
  if (!allowRequest(clientIp(request))) {
    return jsonError(429, "Too many requests. Please wait a moment and try again.");
  }
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return jsonError(400, "Request body must be valid JSON.");
  }
  const validated = validateSpamConfig(raw);
  if (!validated.ok) return jsonError(400, validated.error);
  try {
    const config = await saveSpamConfig(validated.value);
    return Response.json({ ok: true, config });
  } catch (error) {
    return errorResponse(error);
  }
}

/**
 * Two actions in one endpoint:
 *  `{action:"send"}` — deliver the demo from a connected mailbox.
 *  `{action:"check"}` — ask the checker Gmail where a demo landed.
 */
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
  const action = (raw as Record<string, unknown>).action;

  try {
    if (action === "send") {
      const validated = validateSpamSend(raw);
      if (!validated.ok) return jsonError(400, validated.error);
      const record = await sendDemo(validated.value);
      return Response.json({ ok: true, record }, { status: 201 });
    }
    if (action === "check") {
      const id = (raw as Record<string, unknown>).id;
      if (typeof id !== "string" || id.length === 0) {
        return jsonError(400, "Which demo should be checked? Provide its id.");
      }
      const record = await runCheck(id);
      return Response.json({ ok: true, record });
    }
    return jsonError(400, "action must be \"send\" or \"check\".");
  } catch (error) {
    return errorResponse(error);
  }
}
