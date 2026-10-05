import { runLeadsPath, storeErrorResponse } from "@/lib/server/runs";
import { readJson } from "@/lib/server/stateStore";
import { listTasks } from "@/lib/server/tasks";
import type { Lead } from "@/types/lead";

export const maxDuration = 60;

function jsonError(status: number, error: string): Response {
  return Response.json({ error }, { status });
}

/** Most recently touched task runs whose leads the page shows. */
const RUN_CAP = 10;

export interface LeadGroup {
  runId: string;
  taskId: string | null;
  keyword: string;
  leads: Lead[];
}

/**
 * Leads collected by the automation (per task run), plus — with `?runId=` —
 * an attached manual run. Run ids are unguessable uuids, and the leads are
 * already stored without the heavy free text, so this is a straight read.
 */
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const runId = url.searchParams.get("runId");

  try {
    if (runId) {
      if (!/^[0-9a-f-]{36}$/.test(runId)) return jsonError(404, "Unknown run.");
      const leads = (await readJson<Lead[]>(runLeadsPath(runId), true)) ?? [];
      const group: LeadGroup = {
        runId,
        taskId: null,
        keyword: leads[0]?.keyword ?? "",
        leads,
      };
      return Response.json({ ok: true, runs: [group] }, { headers: { "Cache-Control": "no-store" } });
    }

    const tasks = (await listTasks())
      .filter((task) => task.runId !== null)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, RUN_CAP);

    const runs: LeadGroup[] = [];
    for (const task of tasks) {
      const leads = (await readJson<Lead[]>(runLeadsPath(task.runId!), true)) ?? [];
      runs.push({ runId: task.runId!, taskId: task.id, keyword: task.keyword, leads });
    }
    return Response.json({ ok: true, runs }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return storeErrorResponse(error) ?? jsonError(500, "Could not load leads.");
  }
}
