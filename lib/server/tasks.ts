/**
 * Scheduled tasks: CRUD + the scheduler that turns a due task into a full
 * automation pipeline (claim → lead run → on completion → email chain → done).
 *
 * Every mutation goes through the store's per-path queue on `config/tasks.json`,
 * so the hourly cron, the dashboard's start-due trigger and the lead tick's
 * completion hook can never clobber each other's transitions — each transition
 * re-checks the status inside the queued mutation.
 *
 * Notifications: lifecycle events fan out to Telegram (bot token + admin chat
 * from env) so a fully headless day is observable without the dashboard.
 */

import { randomUUID } from "node:crypto";
import { kickEmailTick, sweepEmailChains } from "@/lib/server/emailSender";
import { listMailboxes } from "@/lib/server/mailboxes";
import { TASKS_PATH } from "@/lib/server/paths";
import {
  createRun,
  kickTick,
  resumeRun,
  runLeadsPath,
  snapshotRun,
  stopRun,
} from "@/lib/server/runs";
import { mutateJson, readJson } from "@/lib/server/stateStore";
import { notifyTelegram, notifyTime } from "@/lib/server/telegram";
import { parseInstallInput, validateKeyword, validateLimit, validateMaxRating } from "@/lib/validation/input";
import type { DoneReason, Lead } from "@/types/lead";
import type { AutomationTask } from "@/types/automation";

/** A claim stuck longer than this lost its createRun — reschedule it. */
const CLAIM_TIMEOUT_MS = 120_000;
const TASK_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Task ids are storage path segments (email log files) — strict shape check. */
export function isValidTaskId(id: string): boolean {
  return TASK_ID_RE.test(id);
}
const MAX_TEMPLATE_SUBJECT = 200;
const MAX_TEMPLATE_BODY = 5_000;
/** Lead schedules may be booked up to ~45 days out (the 30-day planning use). */
const MAX_START_AHEAD_MS = 45 * 24 * 60 * 60 * 1_000;

export type TaskValidation =
  | {
      ok: true;
      value: Omit<
        AutomationTask,
        | "id"
        | "emailToken"
        | "status"
        | "runId"
        | "runToken"
        | "leadCount"
        | "error"
        | "email"
        | "createdAt"
        | "updatedAt"
      >;
    }
  | { ok: false; error: string };

/** Validate a create/edit payload; mailbox ids are checked against the store. */
export async function validateTask(raw: Record<string, unknown>): Promise<TaskValidation> {
  const keyword = validateKeyword(raw.keyword);
  if (!keyword.ok) return { ok: false, error: keyword.error };
  const maxRating = validateMaxRating(raw.maxRating);
  if (!maxRating.ok) return { ok: false, error: maxRating.error };
  const maxInstalls = parseInstallInput(raw.maxInstalls);
  if (!maxInstalls.ok) return { ok: false, error: maxInstalls.error };
  const limit = validateLimit(raw.limit);
  if (!limit.ok) return { ok: false, error: limit.error };

  const startAt = typeof raw.startAt === "string" ? Number(raw.startAt) : raw.startAt;
  if (typeof startAt !== "number" || !Number.isFinite(startAt)) {
    return { ok: false, error: "Starting time is required." };
  }
  const now = Date.now();
  if (startAt < now - 5 * 60_000) return { ok: false, error: "Starting time must be in the future." };
  if (startAt > now + MAX_START_AHEAD_MS) {
    return { ok: false, error: "Starting time must be within the next 45 days." };
  }

  if (!Array.isArray(raw.mailboxIds) || raw.mailboxIds.length === 0) {
    return { ok: false, error: "Select at least one connected mailbox." };
  }
  const mailboxIds = raw.mailboxIds.filter((id): id is string => typeof id === "string");
  if (mailboxIds.length === 0) return { ok: false, error: "Select at least one connected mailbox." };
  const known = new Set((await listMailboxes()).map((mailbox) => mailbox.id));
  if (mailboxIds.some((id) => !known.has(id))) {
    return { ok: false, error: "One of the selected mailboxes no longer exists." };
  }

  const templateSubject = typeof raw.templateSubject === "string" ? raw.templateSubject.trim() : "";
  if (templateSubject.length < 1 || templateSubject.length > MAX_TEMPLATE_SUBJECT) {
    return { ok: false, error: `Subject must be 1–${MAX_TEMPLATE_SUBJECT} characters.` };
  }
  const templateBody = typeof raw.templateBody === "string" ? raw.templateBody.trim() : "";
  if (templateBody.length < 1 || templateBody.length > MAX_TEMPLATE_BODY) {
    return { ok: false, error: `Body must be 1–${MAX_TEMPLATE_BODY} characters.` };
  }

  const intervalRaw = typeof raw.intervalSeconds === "string" ? Number(raw.intervalSeconds) : raw.intervalSeconds;
  if (typeof intervalRaw !== "number" || !Number.isFinite(intervalRaw)) {
    return { ok: false, error: "Send interval must be a number of seconds." };
  }
  const intervalSeconds = Math.round(intervalRaw);
  if (intervalSeconds < 1 || intervalSeconds > 3_600) {
    return { ok: false, error: "Send interval must be between 1 and 3600 seconds." };
  }

  return {
    ok: true,
    value: {
      keyword: keyword.value,
      maxRating: maxRating.value,
      maxInstalls: maxInstalls.value,
      limit: limit.value,
      startAt,
      mailboxIds,
      templateSubject,
      templateBody,
      intervalSeconds,
    },
  };
}

function emptyEmail(): AutomationTask["email"] {
  return {
    nextIndex: 0,
    sent: 0,
    failed: 0,
    lastSentAt: 0,
    leaseUntil: 0,
    consecutiveFailures: 0,
    startedAt: null,
    finishedAt: null,
  };
}

export async function listTasks(): Promise<AutomationTask[]> {
  const tasks = await readJson<AutomationTask[]>(TASKS_PATH, true);
  return Array.isArray(tasks) ? tasks : [];
}

export async function createTask(
  value: Extract<TaskValidation, { ok: true }>["value"],
): Promise<AutomationTask> {
  const now = Date.now();
  const task: AutomationTask = {
    id: randomUUID(),
    ...value,
    status: "scheduled",
    runId: null,
    runToken: null,
    emailToken: randomUUID(),
    leadCount: 0,
    error: null,
    email: emptyEmail(),
    createdAt: now,
    updatedAt: now,
  } as AutomationTask;
  await mutateJson<AutomationTask[]>(
    TASKS_PATH,
    (tasks) => [...(tasks ?? []), task],
    "psa: add task",
  );
  return task;
}

export type TaskMutationResult =
  | { ok: true }
  | { ok: false; code: 404 | 409; error: string };

/** Edit a task — only while it is still waiting for its start time. */
export async function updateTask(
  id: string,
  value: Extract<TaskValidation, { ok: true }>["value"],
): Promise<TaskMutationResult> {
  let result: TaskMutationResult = { ok: false, code: 404, error: "Task not found." };
  await mutateJson<AutomationTask[]>(
    TASKS_PATH,
    (tasks) => {
      const task = tasks?.find((entry) => entry.id === id);
      if (!task) return null;
      if (task.status !== "scheduled") {
        result = { ok: false, code: 409, error: "Only scheduled tasks can be edited." };
        return null;
      }
      Object.assign(task, value);
      task.updatedAt = Date.now();
      result = { ok: true };
      return tasks;
    },
    "psa: edit task",
  );
  return result;
}

/** Delete a task; a live lead run attached to it is asked to stop. */
export async function deleteTask(id: string): Promise<boolean> {
  // Accumulator instead of a closure-assigned variable: TS flow analysis
  // cannot see writes that happen inside the queued mutation callback.
  const removedTasks: AutomationTask[] = [];
  await mutateJson<AutomationTask[]>(
    TASKS_PATH,
    (tasks) => {
      if (!tasks) return null;
      const index = tasks.findIndex((entry) => entry.id === id);
      if (index < 0) return null;
      removedTasks.push(tasks[index]);
      tasks.splice(index, 1);
      return tasks;
    },
    "psa: delete task",
  );
  const removed = removedTasks[0];
  if (removed?.runId && removed.runToken) {
    if (removed.status === "collecting" || removed.status === "starting") {
      await stopRun(removed.runId, removed.runToken).catch(() => undefined);
    }
  }
  return removedTasks.length > 0;
}

export interface StartDueOptions {
  /** Vercel geo header — the storefront the lead run scrapes. */
  country?: string;
  /** Client trigger: start this task now regardless of its schedule. */
  onlyId?: string;
}

export interface StartDueResult {
  due: number;
  started: number;
  failed: number;
}

/**
 * Claim every task whose time has come and launch its lead run. Runs from
 * the hourly cron (headless) and from the dashboard when a due task's time
 * passes with the tab open (precise). Safe to call concurrently: the claim
 * is a queued, status-guarded mutation.
 */
export async function startDueTasks(origin: string, options: StartDueOptions = {}): Promise<StartDueResult> {
  const now = Date.now();
  const tasks = await listTasks();
  const due = tasks.filter(
    (task) =>
      (options.onlyId ? task.id === options.onlyId : true) &&
      ((task.status === "scheduled" && task.startAt <= now) ||
        (task.status === "starting" && now - task.updatedAt > CLAIM_TIMEOUT_MS)),
  );
  const result: StartDueResult = { due: due.length, started: 0, failed: 0 };
  for (const task of due) {
    if (await claimAndStart(origin, task, options.country)) result.started += 1;
    else result.failed += 1;
  }
  return result;
}

async function claimAndStart(
  origin: string,
  planned: AutomationTask,
  country: string | undefined,
): Promise<boolean> {
  let claimed = false;
  let wasErrored = false;
  await mutateJson<AutomationTask[]>(
    TASKS_PATH,
    (tasks) => {
      const task = tasks?.find((entry) => entry.id === planned.id);
      if (!task) return null;
      if (task.status === "starting" && Date.now() - task.updatedAt <= CLAIM_TIMEOUT_MS) return null;
      if (task.status !== "scheduled" && task.status !== "starting") return null;
      wasErrored = task.error !== null;
      task.status = "starting";
      task.error = null;
      task.updatedAt = Date.now();
      claimed = true;
      return tasks;
    },
    "psa: claim task",
  );
  if (!claimed) return false;

  // A scheduled task can outlive a mailbox deletion — check before spending
  // a whole lead generation on a task that could never send.
  const knownMailboxes = new Set((await listMailboxes()).map((mailbox) => mailbox.id));
  if (planned.mailboxIds.some((id) => !knownMailboxes.has(id))) {
    const message = "A selected mailbox was removed — reconnect it and recreate the task.";
    await mutateJson<AutomationTask[]>(
      TASKS_PATH,
      (tasks) => {
        const task = tasks?.find((entry) => entry.id === planned.id);
        if (!task) return null;
        task.status = "failed";
        task.error = message;
        task.updatedAt = Date.now();
        return tasks;
      },
      "psa: task mailbox gone",
    );
    await notifyTelegram(`❌ Task failed — "${planned.keyword}": ${message}`);
    return false;
  }

  try {
    const created = await createRun({
      keyword: planned.keyword,
      maxRating: planned.maxRating,
      maxInstalls: planned.maxInstalls,
      limit: planned.limit,
      country: country && /^[A-Z]{2}$/.test(country) ? country : "BD",
    });
    await mutateJson<AutomationTask[]>(
      TASKS_PATH,
      (tasks) => {
        const task = tasks?.find((entry) => entry.id === planned.id);
        if (!task) return null;
        task.status = "collecting";
        task.runId = created.runId;
        task.runToken = created.token;
        task.updatedAt = Date.now();
        return tasks;
      },
      "psa: task collecting",
    );
    await kickTick(origin, created.runId, created.token);
    await notifyTelegram(
      `🚀 Automation started — "${planned.keyword}"\n` +
        `Target ${planned.limit} leads · rating ≤ ${planned.maxRating} · installs ≤ ${planned.maxInstalls}\n` +
        `Started ${notifyTime(Date.now())}`,
    );
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not create the lead run.";
    await mutateJson<AutomationTask[]>(
      TASKS_PATH,
      (tasks) => {
        const task = tasks?.find((entry) => entry.id === planned.id);
        if (!task) return null;
        task.status = "scheduled";
        task.error = message;
        task.updatedAt = Date.now();
        return tasks;
      },
      "psa: claim failed",
    );
    // First failure only: a persistently broken store must not spam hourly.
    if (!wasErrored) await notifyTelegram(`❌ Could not start "${planned.keyword}" — ${message}`);
    return false;
  }
}

/**
 * The lead run finished — move its task on: terminal reasons either fail the
 * task (stop / no leads / no mailbox) or flip it into `sending` and kick the
 * email chain. Auto-resumable reasons (rate limit, query cap) leave the task
 * collecting so the run's own recovery keeps the pipeline moving.
 * Called from executeTick after the run's meta is finalized.
 */
export async function handleTaskRunFinished(
  origin: string,
  runId: string,
  reason: DoneReason | "stopped",
): Promise<void> {
  const tasks = await listTasks();
  const task = tasks.find((entry) => entry.runId === runId && entry.status === "collecting");
  if (!task) return;

  if (reason === "rate-limited" || reason === "budget-exhausted") return;
  if (reason === "query-cap") {
    // Unattended approval: grant the next tranche and keep collecting.
    if (task.runToken) {
      await resumeRun(runId, task.runToken, origin).catch((error) =>
        console.error("task query-cap resume failed", error),
      );
    }
    return;
  }

  const leads = (await readJson<Lead[]>(runLeadsPath(runId), true)) ?? [];
  const mailable = leads.filter((lead) => typeof lead.email === "string" && lead.email.includes("@"));

  let outcome: { kind: "failed"; error: string } | { kind: "sending" };
  if (reason === "stopped") outcome = { kind: "failed", error: "The lead run was stopped." };
  else if (reason === "failed") outcome = { kind: "failed", error: "Lead generation failed." };
  else if (leads.length === 0) outcome = { kind: "failed", error: "No leads were collected for this keyword." };
  else if (mailable.length === 0) outcome = { kind: "failed", error: "No collected lead has an email address." };
  else if (task.mailboxIds.length === 0) outcome = { kind: "failed", error: "No mailbox is selected." };
  else outcome = { kind: "sending" };

  let transitioned = false;
  await mutateJson<AutomationTask[]>(
    TASKS_PATH,
    (tasksList) => {
      const current = tasksList?.find((entry) => entry.id === task.id);
      if (!current || current.status !== "collecting") return null;
      current.leadCount = leads.length;
      if (outcome.kind === "failed") {
        current.status = "failed";
        current.error = outcome.error;
        current.email.finishedAt = Date.now();
      } else {
        current.status = "sending";
        current.email.startedAt = current.email.startedAt ?? Date.now();
        current.error = null;
      }
      current.updatedAt = Date.now();
      transitioned = true;
      return tasksList;
    },
    "psa: task leads done",
  );
  if (!transitioned) return;

  if (outcome.kind === "failed") {
    await notifyTelegram(`❌ Task failed — "${task.keyword}": ${outcome.error}`);
    return;
  }

  await notifyTelegram(
    `✅ Lead collection complete — ${leads.length} leads for "${task.keyword}" (${mailable.length} with emails).`,
  );
  await notifyTelegram(
    `📤 Email sending started — ${mailable.length} emails, one every ${task.intervalSeconds}s, ` +
      `from ${task.mailboxIds.length} mailbox${task.mailboxIds.length === 1 ? "" : "es"}.`,
  );
  await kickEmailTick(origin, task);
}

export interface TaskSweepResult extends StartDueResult {
  /** Tasks whose finished/lost run was reconciled back onto the task. */
  reconciled: number;
  /** Email-chain outcomes folded in from sweepEmailChains. */
  emails: number;
}

/**
 * One scheduler pass: claim due tasks, reconcile tasks whose runs ended
 * (including the window where the instance died between "run done" and the
 * task transition), then sweep quiet email chains. Mirrors sweepStalledRuns'
 * store-error contract — errors propagate to the route, which maps them.
 */
export async function sweepTasks(
  origin: string,
  options: StartDueOptions = {},
): Promise<TaskSweepResult> {
  const started = await startDueTasks(origin, options);
  const result: TaskSweepResult = { ...started, reconciled: 0, emails: 0 };

  const tasks = await listTasks();
  for (const task of tasks) {
    if (task.status !== "collecting" || !task.runId || !task.runToken) continue;
    // Status-only reconciliation: skip the log/leads payloads.
    const snapshot = await snapshotRun(task.runId, task.runToken, {
      leadsSince: Number.MAX_SAFE_INTEGER,
      logSince: Number.MAX_SAFE_INTEGER,
    });
    if (!snapshot.ok) {
      if (snapshot.code === 404) {
        const lost = await failCollecting(task.id, "The lead run disappeared from storage.");
        if (lost) result.reconciled += 1;
      }
      continue;
    }
    if (snapshot.status === "done") {
      if (snapshot.reason === "rate-limited") continue; // run sweep revives it
      await handleTaskRunFinished(origin, task.runId, snapshot.reason ?? "failed");
      result.reconciled += 1;
    } else if (snapshot.status === "stopped") {
      await handleTaskRunFinished(origin, task.runId, "stopped");
      result.reconciled += 1;
    }
  }

  try {
    const emails = await sweepEmailChains(origin);
    result.emails = emails.kicked + emails.quotaReady;
  } catch (error) {
    // Store hiccup: the next pass retries the email sweep.
    console.error("email sweep failed", error);
  }
  return result;
}

async function failCollecting(taskId: string, error: string): Promise<boolean> {
  let failed = false;
  await mutateJson<AutomationTask[]>(
    TASKS_PATH,
    (tasks) => {
      const task = tasks?.find((entry) => entry.id === taskId);
      if (!task || task.status !== "collecting") return null;
      task.status = "failed";
      task.error = error;
      task.updatedAt = Date.now();
      failed = true;
      return tasks;
    },
    "psa: task lost",
  );
  if (failed) await notifyTelegram(`❌ Task failed — ${error}`);
  return failed;
}
