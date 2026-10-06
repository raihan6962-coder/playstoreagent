import type { Lead } from "./lead";

/**
 * Scheduled automation: one task = one full pipeline run — lead generation at
 * its start time, then automatic email delivery to the collected leads, then
 * done. Tasks are created days in advance (up to ~30) and a daily/hourly cron
 * claims whichever are due.
 */
export type TaskStatus =
  /** Waiting for `startAt`. */
  | "scheduled"
  /** Claimed by a scheduler pass; createRun is in flight (stale → reschedule). */
  | "starting"
  /** Lead generation run is active (or being auto-resumed). */
  | "collecting"
  /** Leads done; the email chain is delivering. */
  | "sending"
  /** Every selected mailbox hit today's quota — resumes automatically tomorrow. */
  | "awaiting-quota"
  /** Leads + emails finished. */
  | "done"
  /** No leads, config error, consecutive send failures or manual stop. */
  | "failed";

export interface TaskEmailProgress {
  /** Leads already mailed (index into the run's email-bearing leads). */
  nextIndex: number;
  sent: number;
  failed: number;
  lastSentAt: number;
  /** Lease of the email tick currently inside its send loop. 0 = free. */
  leaseUntil: number;
  /** Consecutive delivery failures — five in a row abort the task. */
  consecutiveFailures: number;
  startedAt: number | null;
  finishedAt: number | null;
}

export interface AutomationTask {
  id: string;
  keyword: string;
  maxRating: number;
  maxInstalls: number;
  /** Lead target for the generation phase. */
  limit: number;
  /** Epoch ms when the task must start (the browser's picked instant). */
  startAt: number;
  /** Connected mailbox ids selected for this task. */
  mailboxIds: string[];
  templateSubject: string;
  templateBody: string;
  /** Seconds between individual emails. */
  intervalSeconds: number;
  status: TaskStatus;
  /** Lead-generation run (null until the task is claimed). */
  runId: string | null;
  /** Token of that run — lets the scheduler stop/resume it on the task's behalf. */
  runToken: string | null;
  /** Guards the email tick route — same role as a run token. */
  emailToken: string;
  /** Final lead count, recorded when the collection phase ends. */
  leadCount: number;
  error: string | null;
  email: TaskEmailProgress;
  createdAt: number;
  updatedAt: number;
}

export interface Mailbox {
  id: string;
  label: string;
  /** Apps Script web-app `/exec` URL the sends are POSTed to. */
  webAppUrl: string;
  /** Max sends per calendar day (UTC) from this mailbox. */
  dailyQuota: number;
  /** Today's usage; reset lazily when the UTC date rolls. */
  sent: { date: string; count: number };
  createdAt: number;
}

export interface EmailSettings {
  mailboxes: Mailbox[];
  updatedAt: number;
}

export interface EmailLogEntry {
  t: number;
  to: string;
  mailboxId: string;
  ok: boolean;
  error?: string;
  /** Recipient unsubscribed — index advanced, nothing delivered. */
  skipped?: boolean;
}

export interface EmailDayStats {
  sent: number;
  failed: number;
  byMailbox: Record<string, number>;
  /** Suppressed by the unsubscribe list (neither sent nor failed). */
  skipped?: number;
}

export interface EmailLog {
  taskId: string;
  /** Most recent entries first-capped for the analytics table. */
  entries: EmailLogEntry[];
  /** Accurate per-day counters (entries above are only a recent window). */
  days: Record<string, EmailDayStats>;
  updatedAt: number;
}

/** A lead ready for outreach: has a deliverable address. */
export type MailableLead = Pick<Lead, "email" | "title" | "developer" | "packageName">;

export interface TaskListResponse {
  ok: true;
  tasks: AutomationTask[];
}

export interface EmailSettingsResponse {
  ok: true;
  mailboxes: Mailbox[];
}
