import { storeErrorResponse, sweepStalledRuns } from "@/lib/server/runs";
import { checkReplies } from "@/lib/server/replies";
import { sweepTasks } from "@/lib/server/tasks";
import { validateCountry } from "@/lib/validation/input";

export const maxDuration = 120;

function jsonError(status: number, error: string): Response {
  return Response.json({ error }, { status });
}

/**
 * The hourly heartbeat (24 daily Vercel cron entries — Hobby allows one run
 * per day per entry, so one entry per hour covers the whole day):
 *  1. restart self-chains of runs whose checkpoints went quiet,
 *  2. revive runs that ended on a storage rate limit,
 *  3. claim due tasks (headless start of the day's automation), reconcile
 *     tasks whose runs finished, and restart quiet email chains,
 *  4. scan connected mailboxes for client replies and Telegram-notify the
 *     human ones (auto-replies are recorded, never notified).
 * Authenticated with the shared `CRON_SECRET` bearer token (Vercel attaches
 * it automatically from the env var of the same name).
 */
export async function GET(request: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  if (!secret) return jsonError(503, "CRON_SECRET is not configured.");
  const authorization = request.headers.get("authorization") ?? "";
  if (authorization !== `Bearer ${secret}`) return jsonError(401, "Unauthorized.");

  const origin = new URL(request.url).origin;
  const geo = validateCountry(request.headers.get("x-vercel-ip-country"));
  try {
    const runs = await sweepStalledRuns(origin);
    const tasks = await sweepTasks(origin, { country: geo.ok ? geo.value : undefined });
    let replies: Awaited<ReturnType<typeof checkReplies>> | { error: string };
    try {
      replies = await checkReplies();
    } catch (error) {
      replies = { error: error instanceof Error ? error.message.slice(0, 160) : "reply scan failed" };
    }
    return Response.json({
      ok: runs.store === "ok",
      ...runs,
      tasks,
      replies,
    });
  } catch (error) {
    return storeErrorResponse(error) ?? jsonError(500, "Sweep failed.");
  }
}
