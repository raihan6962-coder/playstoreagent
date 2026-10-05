import { storeErrorResponse, sweepStalledRuns } from "@/lib/server/runs";

export const maxDuration = 60;

function jsonError(status: number, error: string): Response {
  return Response.json({ error }, { status });
}

/**
 * External watchdog hit by the repo's GitHub Actions schedule every five
 * minutes (Vercel Hobby only allows daily crons, so the timer lives in
 * Actions): restart the self-chain of any run whose checkpoints went quiet,
 * revive runs that ended on a storage rate limit, prune finished runs from
 * the watch list. Authenticated with the shared `CRON_SECRET` bearer token —
 * an unauthenticated sweep could kick ticks for arbitrary run ids.
 */
export async function GET(request: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  if (!secret) return jsonError(503, "CRON_SECRET is not configured.");
  const authorization = request.headers.get("authorization") ?? "";
  if (authorization !== `Bearer ${secret}`) return jsonError(401, "Unauthorized.");

  try {
    const result = await sweepStalledRuns(new URL(request.url).origin);
    return Response.json({ ok: result.store === "ok", ...result });
  } catch (error) {
    return storeErrorResponse(error) ?? jsonError(500, "Sweep failed.");
  }
}
