import { listMailboxes, utcDate } from "@/lib/server/mailboxes";
import { taskEmailLogPath } from "@/lib/server/paths";
import { storeErrorResponse } from "@/lib/server/runs";
import { readJson } from "@/lib/server/stateStore";
import { listTasks } from "@/lib/server/tasks";
import type { EmailLog } from "@/types/automation";

export const maxDuration = 60;

function jsonError(status: number, error: string): Response {
  return Response.json({ error }, { status });
}

/** How many task logs the dashboard merges per request (newest first). */
const LOG_TASK_CAP = 20;

export interface AnalyticsResponse {
  ok: true;
  totals: { sent: number; failed: number; tasksDone: number; tasksActive: number };
  byDay: { date: string; sent: number; failed: number }[];
  byMailbox: {
    id: string;
    label: string;
    usedToday: number;
    dailyQuota: number;
    totalSent: number;
  }[];
  recent: {
    t: number;
    to: string;
    ok: boolean;
    error?: string;
    taskId: string;
    keyword: string;
    mailboxId: string;
  }[];
}

/**
 * Email Analytics: lifetime totals, a per-day bar for the last fortnight,
 * per-mailbox quota usage, and the most recent deliveries. Counts come from
 * the task records (authoritative, cheap); day/mailbox/entry detail from
 * the per-task send logs.
 */
export async function GET(): Promise<Response> {
  try {
    const [tasks, mailboxes] = await Promise.all([listTasks(), listMailboxes()]);

    let sent = 0;
    let failed = 0;
    let tasksDone = 0;
    let tasksActive = 0;
    const withEmails = tasks
      .filter((task) => task.email.startedAt !== null || task.email.sent + task.email.failed > 0)
      .sort((a, b) => b.updatedAt - a.updatedAt);
    for (const task of tasks) {
      sent += task.email.sent;
      failed += task.email.failed;
      if (task.status === "done") tasksDone += 1;
      if (task.status === "sending" || task.status === "awaiting-quota" || task.status === "collecting") {
        tasksActive += 1;
      }
    }

    const days = new Map<string, { sent: number; failed: number }>();
    const mailboxTotals = new Map<string, number>();
    const recent: AnalyticsResponse["recent"] = [];

    for (const task of withEmails.slice(0, LOG_TASK_CAP)) {
      const log = await readJson<EmailLog>(taskEmailLogPath(task.id), true);
      if (!log) continue;
      for (const [date, stats] of Object.entries(log.days)) {
        const current = days.get(date) ?? { sent: 0, failed: 0 };
        current.sent += stats.sent;
        current.failed += stats.failed;
        days.set(date, current);
        for (const [mailboxId, count] of Object.entries(stats.byMailbox)) {
          mailboxTotals.set(mailboxId, (mailboxTotals.get(mailboxId) ?? 0) + count);
        }
      }
      for (const entry of log.entries) {
        recent.push({
          t: entry.t,
          to: entry.to,
          ok: entry.ok,
          ...(entry.error ? { error: entry.error } : {}),
          taskId: task.id,
          keyword: task.keyword,
          mailboxId: entry.mailboxId,
        });
      }
    }

    const today = utcDate();
    const byDay = [...days.entries()]
      .sort((a, b) => (a[0] < b[0] ? 1 : -1))
      .slice(0, 14)
      .map(([date, stats]) => ({ date, ...stats }));

    recent.sort((a, b) => b.t - a.t);

    const byMailbox = mailboxes.map((mailbox) => ({
      id: mailbox.id,
      label: mailbox.label,
      usedToday: mailbox.sent.date === today ? mailbox.sent.count : 0,
      dailyQuota: mailbox.dailyQuota,
      totalSent: mailboxTotals.get(mailbox.id) ?? 0,
    }));

    const payload: AnalyticsResponse = {
      ok: true,
      totals: { sent, failed, tasksDone, tasksActive },
      byDay,
      byMailbox,
      recent: recent.slice(0, 50),
    };
    return Response.json(payload, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return storeErrorResponse(error) ?? jsonError(500, "Could not load analytics.");
  }
}
