/**
 * The email half of the pipeline: a self-chaining send loop (mirrors the
 * lead tick) that walks a task's collected leads, waits `intervalSeconds`
 * between individual sends, round-robins the task's connected mailboxes
 * against their daily quotas, and checkpoints `nextIndex` after every single
 * delivery so a crash can never double-mail a lead.
 *
 * Delivery target: the user's own Gmail via a Google Apps Script web app
 * (POSTed JSON {to, subject, body}). Nothing here stores Gmail credentials —
 * the Apps Script deployment is the mailer.
 */

import { timingSafeEqual } from "node:crypto";
import type { Lead } from "@/types/lead";
import {
  pickMailbox,
  recordSend,
  utcDate,
} from "@/lib/server/mailboxes";
import {
  buildFooterHtml,
  buildPlainFooter,
  getFooterSettings,
  plainToHtml,
  unsubscribeUrl,
} from "@/lib/server/emailFooter";
import { listUnsubscribes } from "@/lib/server/unsubscribes";
import { TASKS_PATH, taskEmailLogPath } from "@/lib/server/paths";
import { mutateJson, readJson, writeJson } from "@/lib/server/stateStore";
import { notifyTelegram } from "@/lib/server/telegram";
import type { AutomationTask, EmailLog, EmailLogEntry } from "@/types/automation";
import { runLeadsPath } from "@/lib/server/runs";

/** One email tick's send window — headroom under the route's maxDuration. */
const EMAIL_BUDGET_MS = 240_000;
const EMAIL_LEASE_MS = 285_000;
const EMAIL_LOG_MAX = 300;
/** Systemic failures (bad deployment, revoked access) — abort after this run of reds. */
const MAX_CONSECUTIVE_FAILURES = 5;
/** No writes for this long while `sending` ⇒ the chain died; the sweep re-kicks. */
const EMAIL_STALLED_MS = 60_000;

interface EmailPolicy {
  attempts: number;
  backoffsMs: number[];
  timeoutMs: number;
}
const EMAIL_CHAIN_POLICY: EmailPolicy = { attempts: 5, backoffsMs: [2_000, 5_000, 15_000, 30_000], timeoutMs: 12_000 };
const EMAIL_KICK_POLICY: EmailPolicy = { attempts: 3, backoffsMs: [2_000, 5_000], timeoutMs: 12_000 };
const EMAIL_SWEEP_POLICY: EmailPolicy = { attempts: 2, backoffsMs: [3_000], timeoutMs: 10_000 };

function tokenMatches(expected: string, got: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(got, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readTask(taskId: string): Promise<AutomationTask | null> {
  const tasks = await readJson<AutomationTask[]>(TASKS_PATH, true);
  return tasks?.find((task) => task.id === taskId) ?? null;
}

export type EmailTickBegin =
  | { kind: "step"; task: AutomationTask }
  | { kind: "busy" }
  | { kind: "final"; status: AutomationTask["status"] }
  | { kind: "missing" }
  | { kind: "forbidden" };

/**
 * The email tick mutex — same contract as the run's beginTick: acquire the
 * per-task lease or report busy/final, so a chained tick, the sweep and a
 * dashboard kick can never send concurrently.
 */
export async function beginEmailTick(taskId: string, token: string): Promise<EmailTickBegin> {
  const existing = await readTask(taskId);
  if (!existing) return { kind: "missing" };
  if (!tokenMatches(existing.emailToken, token)) return { kind: "forbidden" };
  if (existing.status !== "sending" && existing.status !== "awaiting-quota") {
    return { kind: "final", status: existing.status };
  }

  let acquired: AutomationTask | null = null;
  await mutateJson<AutomationTask[]>(
    TASKS_PATH,
    (tasks) => {
      const task = tasks?.find((entry) => entry.id === taskId);
      if (!task) return null;
      if (task.status !== "sending" && task.status !== "awaiting-quota") return null;
      if (task.email.leaseUntil > Date.now()) return null;
      task.email.leaseUntil = Date.now() + EMAIL_LEASE_MS;
      task.updatedAt = Date.now();
      acquired = JSON.parse(JSON.stringify(task)) as AutomationTask;
      return tasks;
    },
    "psa: email lease",
  );
  if (!acquired) {
    const now = await readTask(taskId);
    if (!now) return { kind: "missing" };
    if (now.status !== "sending" && now.status !== "awaiting-quota") {
      return { kind: "final", status: now.status };
    }
    return { kind: "busy" };
  }
  return { kind: "step", task: acquired };
}

/**
 * Replace `{{placeholders}}` from the lead + task. Unknown placeholders stay
 * verbatim so a typo is visible instead of silently blank.
 */
export function renderTemplate(template: string, lead: Lead, keyword: string): string {
  const values: Record<string, string> = {
    email: lead.email ?? "",
    app: lead.title ?? "",
    developer: lead.developer ?? "",
    package: lead.packageName,
    keyword,
    rating: lead.rating === null ? "" : String(lead.rating),
    installs: lead.installsRaw ?? "",
    url: lead.playStoreUrl ?? "",
  };
  return template.replace(/\{\{\s*([a-zA-Z]+)\s*\}\}/g, (whole, key: string) => values[key] ?? whole);
}

export interface DeliverResult {
  ok: boolean;
  error?: string;
  /** Recipient opted out — nothing was sent (neither ok-count nor failure). */
  skipped?: boolean;
}

/**
 * One delivery through the user's Apps Script web app. Success requires a
 * 2xx *and* a JSON body — a 200 that is actually Google's sign-in page
 * (web app not shared as "Anyone") counts as a failure with a hint, never as
 * a sent mail. `html` is optional: deployments that predate it simply send
 * the plain body (which already carries the text footer).
 */
export async function deliver(
  webAppUrl: string,
  to: string,
  subject: string,
  body: string,
  html?: string,
): Promise<DeliverResult> {
  try {
    const response = await fetch(webAppUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(html ? { to, subject, body, html } : { to, subject, body }),
      cache: "no-store",
      signal: AbortSignal.timeout(20_000),
    });
    const text = await response.text();
    let data: unknown = null;
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
    const isObject = typeof data === "object" && data !== null;
    if (response.ok && isObject && (data as { ok?: unknown }).ok !== false) return { ok: true };
    if (/<!doctype html|<html/i.test(text)) {
      return {
        ok: false,
        error: "Got a Google sign-in page — redeploy the Apps Script web app with access: Anyone.",
      };
    }
    const apiError = isObject ? (data as { error?: unknown }).error : undefined;
    return {
      ok: false,
      error:
        typeof apiError === "string" && apiError.length > 0
          ? apiError.slice(0, 160)
          : text.slice(0, 160) || `HTTP ${response.status}`,
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message.slice(0, 160) : "Delivery failed." };
  }
}

async function appendEmailLog(taskId: string, entry: EmailLogEntry): Promise<void> {
  const path = taskEmailLogPath(taskId);
  const log =
    (await readJson<EmailLog>(path, true)) ??
    ({ taskId, entries: [], days: {}, updatedAt: 0 } as EmailLog);
  const date = utcDate(entry.t);
  const day = log.days[date] ?? { sent: 0, failed: 0, byMailbox: {} };
  if (entry.skipped) {
    day.skipped = (day.skipped ?? 0) + 1;
  } else if (entry.ok) {
    day.sent += 1;
    day.byMailbox[entry.mailboxId] = (day.byMailbox[entry.mailboxId] ?? 0) + 1;
  } else {
    day.failed += 1;
  }
  log.days[date] = day;
  log.entries.unshift(entry);
  while (log.entries.length > EMAIL_LOG_MAX) log.entries.pop();
  log.updatedAt = Date.now();
  await writeJson(path, log, `psa: email ${taskId}`);
}

async function releaseLease(taskId: string): Promise<void> {
  await mutateJson<AutomationTask[]>(
    TASKS_PATH,
    (tasks) => {
      const task = tasks?.find((entry) => entry.id === taskId);
      if (!task) return null;
      task.email.leaseUntil = 0;
      task.updatedAt = Date.now();
      return tasks;
    },
    "psa: email release",
  );
}

/** One self-chain hop to the email tick route (mirrors the run's postTick). */
export async function postEmailTick(
  origin: string,
  task: { id: string; emailToken: string },
  policy: EmailPolicy = EMAIL_CHAIN_POLICY,
): Promise<boolean> {
  for (let attempt = 0; attempt < policy.attempts; attempt += 1) {
    if (attempt > 0) {
      await new Promise((resolve) => setTimeout(resolve, policy.backoffsMs[attempt - 1] ?? 5_000));
    }
    try {
      const response = await fetch(`${origin}/api/tasks/${task.id}/email-tick`, {
        method: "POST",
        headers: { "x-task-token": task.emailToken },
        cache: "no-store",
        signal: AbortSignal.timeout(policy.timeoutMs),
      });
      await response.body?.cancel();
      if (response.ok) return true;
      if (response.status === 401 || response.status === 404) return false;
      console.error(`email chain got ${response.status} for ${task.id} (attempt ${attempt + 1})`);
    } catch (error) {
      console.error(`email chain failed for ${task.id} (attempt ${attempt + 1})`, error);
    }
  }
  return false;
}

/** First kick after the lead phase finishes (or the sweep revives a task). */
export async function kickEmailTick(origin: string, task: { id: string; emailToken: string }): Promise<void> {
  await postEmailTick(origin, task, EMAIL_KICK_POLICY);
}

/**
 * One send-loop slice: walk leads at the configured interval until the
 * budget, the leads or the quota run out, then release the lease and chain
 * the next tick (or stop — the sweep restarts a quiet `sending` task).
 */
export async function executeEmailTick(
  origin: string,
  taskId: string,
  leasedTask: AutomationTask,
): Promise<void> {
  const intervalMs = Math.max(1, leasedTask.intervalSeconds) * 1_000;
  try {
    const deadline = Date.now() + EMAIL_BUDGET_MS;
    const leads = leasedTask.runId
      ? ((await readJson<Lead[]>(runLeadsPath(leasedTask.runId), true)) ?? [])
      : [];
    const mailable = leads.filter((lead) => typeof lead.email === "string" && lead.email.includes("@"));
    let consecutive = leasedTask.email.consecutiveFailures;
    // Read once per slice — the footer and the opt-out list only change
    // between ticks, and this saves two store reads per individual send.
    const footer = await getFooterSettings();
    const optedOut = new Set((await listUnsubscribes()).map((entry) => entry.email));

    while (Date.now() < deadline) {
      const task = await readTask(taskId);
      if (!task) return; // deleted mid-flight — nothing to chain
      if (task.status !== "sending") return; // failed/done/quota by another writer

      if (task.email.nextIndex >= mailable.length) {
        await finishSending(task, mailable.length);
        return;
      }

      const waitMs = task.email.lastSentAt + intervalMs - Date.now();
      if (waitMs > 0) {
        if (Date.now() + waitMs >= deadline) break; // interval outlives this slice
        await sleep(waitMs);
        continue;
      }

      const mailboxCount = Math.max(1, task.mailboxIds.length);
      const picked = await pickMailbox(task.mailboxIds, task.email.nextIndex % mailboxCount);
      if (!picked) {
        await goAwaitingQuota(task);
        return;
      }

      const lead = mailable[task.email.nextIndex];
      let outcome: DeliverResult;
      if (optedOut.has(lead.email!.toLowerCase())) {
        // Suppressed by the unsubscribe list: advance the index without
        // touching Gmail, quota or the send interval.
        outcome = { ok: true, skipped: true };
      } else {
        const renderedSubject = renderTemplate(task.templateSubject, lead, task.keyword);
        const plainBody = renderTemplate(task.templateBody, lead, task.keyword);
        let bodyText = plainBody;
        let html: string | undefined;
        if (footer.enabled) {
          const url = unsubscribeUrl(lead.email!);
          bodyText = plainBody + buildPlainFooter(footer.note, url);
          html = plainToHtml(plainBody) + buildFooterHtml(footer.note, url);
        }
        outcome = await deliver(picked.mailbox.webAppUrl, lead.email!, renderedSubject, bodyText, html);
      }
      if (!outcome.skipped) consecutive = outcome.ok ? 0 : consecutive + 1;

      // Checkpoint the index BEFORE anything else: the next tick resumes at
      // nextIndex, so this ordering is what makes delivery exactly-once.
      await mutateJson<AutomationTask[]>(
        TASKS_PATH,
        (tasks) => {
          const fresh = tasks?.find((entry) => entry.id === taskId);
          if (!fresh) return null;
          fresh.email.nextIndex += 1;
          // A skip preserves lastSentAt so a block of opt-outs never slows
          // the real sends around them.
          if (!outcome.skipped) {
            if (outcome.ok) fresh.email.sent += 1;
            else fresh.email.failed += 1;
            fresh.email.lastSentAt = Date.now();
          }
          fresh.email.consecutiveFailures = consecutive;
          fresh.updatedAt = Date.now();
          return tasks;
        },
        "psa: email sent",
      );
      if (outcome.ok && !outcome.skipped) await recordSend(picked.mailbox.id);
      await appendEmailLog(taskId, {
        t: Date.now(),
        to: lead.email!,
        mailboxId: picked.mailbox.id,
        ok: outcome.ok,
        ...(outcome.skipped ? { skipped: true } : outcome.ok ? {} : { error: outcome.error }),
      });

      if (!outcome.ok && consecutive >= MAX_CONSECUTIVE_FAILURES) {
        await failTask(
          taskId,
          `Delivery failed ${MAX_CONSECUTIVE_FAILURES}× in a row — last error: ${outcome.error}`,
        );
        return;
      }
    }

    // Budget slice over: free the lease, then chain — the next slice picks
    // up at nextIndex and honours the interval from lastSentAt.
    await releaseLease(taskId);
    await postEmailTick(origin, leasedTask, EMAIL_CHAIN_POLICY);
  } catch (error) {
    console.error("email tick failed", error);
    // Lease release lets the sweep re-kick once the task goes quiet — but a
    // transient store hiccup should not park the task for up to an hour, so
    // chain one best-effort hop immediately (bounded by the sweep policy; a
    // persistent failure still falls back to the hourly cron).
    await releaseLease(taskId).catch(() => undefined);
    await postEmailTick(origin, leasedTask, EMAIL_SWEEP_POLICY).catch(() => undefined);
  }
}

async function finishSending(task: AutomationTask, total: number): Promise<void> {
  const summary = `sent ${task.email.sent}, failed ${task.email.failed}`;
  const transitioned = await mutateTaskOnce(task.id, (fresh) => {
    if (fresh.status !== "sending") return null;
    fresh.status = "done";
    fresh.error = null;
    fresh.email.leaseUntil = 0;
    fresh.email.finishedAt = Date.now();
    fresh.updatedAt = Date.now();
    return true;
  });
  if (transitioned) {
    await notifyTelegram(
      `🏁 Emails finished for "${task.keyword}" — ${summary} (of ${total} leads).\nAutomation is done for today.`,
    );
  }
}

async function goAwaitingQuota(task: AutomationTask): Promise<void> {
  const transitioned = await mutateTaskOnce(task.id, (fresh) => {
    if (fresh.status !== "sending") return null;
    fresh.status = "awaiting-quota";
    fresh.email.leaseUntil = 0;
    fresh.updatedAt = Date.now();
    return true;
  });
  if (transitioned) {
    await notifyTelegram(
      `⏸ All mailboxes hit today's send quota for "${task.keyword}" — resumes automatically tomorrow.`,
    );
  }
}

async function failTask(taskId: string, error: string): Promise<void> {
  const task = await readTask(taskId);
  const failed = await mutateTaskOnce(taskId, (fresh) => {
    if (fresh.status !== "sending" && fresh.status !== "awaiting-quota") return null;
    fresh.status = "failed";
    fresh.error = error;
    fresh.email.leaseUntil = 0;
    fresh.email.finishedAt = Date.now();
    fresh.updatedAt = Date.now();
    return true;
  });
  if (failed) {
    await notifyTelegram(`❌ Email sending failed for "${task?.keyword ?? taskId}" — ${error}`);
  }
}

/** Single guarded mutation; returns true when the transition happened. */
async function mutateTaskOnce(
  taskId: string,
  change: (task: AutomationTask) => boolean | null,
): Promise<boolean> {
  let changed = false;
  await mutateJson<AutomationTask[]>(
    TASKS_PATH,
    (tasks) => {
      const task = tasks?.find((entry) => entry.id === taskId);
      if (!task) return null;
      const result = change(task);
      if (result !== true) return null;
      changed = true;
      return tasks;
    },
    "psa: email transition",
  );
  return changed;
}

export interface EmailSweepResult {
  sending: number;
  healthy: number;
  leaseHeld: number;
  kicked: number;
  quotaReady: number;
}

/**
 * Restart quiet email chains and lift tasks out of `awaiting-quota` once the
 * day (and their mailboxes' counters) rolled over. Called by the hourly cron
 * alongside the run sweep.
 */
export async function sweepEmailChains(origin: string): Promise<EmailSweepResult> {
  const result: EmailSweepResult = { sending: 0, healthy: 0, leaseHeld: 0, kicked: 0, quotaReady: 0 };
  const tasks = await readJson<AutomationTask[]>(TASKS_PATH, true);
  if (!Array.isArray(tasks)) return result;

  for (const task of tasks) {
    if (task.status === "sending") {
      result.sending += 1;
      if (task.email.leaseUntil > Date.now()) {
        result.leaseHeld += 1;
      } else if (Date.now() - task.updatedAt > EMAIL_STALLED_MS) {
        if (await postEmailTick(origin, task, EMAIL_SWEEP_POLICY)) result.kicked += 1;
      } else {
        result.healthy += 1;
      }
    } else if (task.status === "awaiting-quota") {
      const picked = await pickMailbox(task.mailboxIds, 0);
      if (!picked) continue;
      const resumed = await mutateTaskOnce(task.id, (fresh) => {
        if (fresh.status !== "awaiting-quota") return null;
        fresh.status = "sending";
        fresh.updatedAt = Date.now();
        return true;
      });
      if (resumed) {
        result.quotaReady += 1;
        await notifyTelegram(`▶️ Quota refreshed — resuming emails for "${task.keyword}".`);
        if (await postEmailTick(origin, task, EMAIL_SWEEP_POLICY)) result.kicked += 1;
      }
    }
  }
  return result;
}
