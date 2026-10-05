import { startDueTasks } from "@/lib/server/tasks";
import { storeErrorResponse } from "@/lib/server/runs";
import { allowRequest, clientIp } from "@/lib/server/rateLimit";
import { validateCountry } from "@/lib/validation/input";

export const maxDuration = 60;

function jsonError(status: number, error: string): Response {
  return Response.json({ error }, { status });
}

/**
 * The dashboard's precise trigger: claim whichever tasks are due *right
 * now* (the hourly cron is the tab-closed backstop). Schedule-respecting —
 * it never starts a future task. Geo header picks the storefront, same as
 * the run-create route.
 */
export async function POST(request: Request): Promise<Response> {
  if (!allowRequest(clientIp(request))) {
    return jsonError(429, "Too many requests. Please wait a moment and try again.");
  }
  const geo = validateCountry(request.headers.get("x-vercel-ip-country"));
  const origin = new URL(request.url).origin;
  try {
    const result = await startDueTasks(origin, { country: geo.ok ? geo.value : undefined });
    return Response.json({ ok: true, ...result }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return storeErrorResponse(error) ?? jsonError(500, "Could not check tasks.");
  }
}
