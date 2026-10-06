/**
 * Reply detection: ask each connected mailbox's Apps Script what landed in
 * its Gmail inbox, keep a deduped history, and Telegram-notify every *human*
 * reply. Auto-replies (out-of-office, bounces, auto-responders) are recorded
 * but never notify — deciding that is `classifyReply`'s job, from the raw
 * headers/subject/body the script reports.
 */

import { taskEmailLogPath, TASKS_PATH } from "@/lib/server/paths";
import { listMailboxes } from "@/lib/server/mailboxes";
import { mutateJson, readJson } from "@/lib/server/stateStore";
import { notifyTelegram, notifyTime } from "@/lib/server/telegram";
import type { AutomationTask, EmailLog } from "@/types/automation";

const REPLIES_PATH = "config/replies.json";
const HISTORY_MAX = 100;
const BODY_STORE_MAX = 1_200;
const TELEGRAM_BODY_MAX = 600;
const REQUEST_TIMEOUT_MS = 25_000;
/** Overlap on re-checks so a borderline message can't slip between runs. */
const RECHECK_OVERLAP_MS = 2 * 60 * 60 * 1_000;
/** First-ever check looks back this far (not to the dawn of the mailbox). */
const FIRST_CHECK_LOOKBACK_MS = 48 * 60 * 60 * 1_000;
/** Recipients passed to the script so threading breaks can't hide a reply. */
const SENDERS_CAP = 800;

export type ReplyKind = "human" | "auto";

export interface ReplyRaw {
  id: string;
  threadId?: string;
  from: string;
  to?: string;
  subject: string;
  /** Epoch ms of the inbound message. */
  date: number;
  body?: string;
  headers?: {
    autoSubmitted?: string;
    precedence?: string;
    xAutoResponseSuppress?: string;
    feedbackId?: string;
    listUnsubscribe?: string;
  };
}

export interface ReplyRecord {
  id: string;
  kind: ReplyKind;
  mailboxId: string;
  mailboxLabel: string;
  from: string;
  fromEmail: string;
  to: string;
  subject: string;
  /** Preview of the reply text — what the notification shows too. */
  body: string;
  receivedAt: number;
  detectedAt: number;
  notified: boolean;
}

export interface RepliesCheckSummary {
  at: number;
  checkedMailboxes: number;
  newHuman: number;
  newAuto: number;
  /** Mailboxes still running the pre-replies script (need redeploy). */
  outdated: string[];
  errors: string[];
}

export interface RepliesState {
  history: ReplyRecord[];
  lastCheckedAt: number;
  lastCheck: RepliesCheckSummary | null;
  updatedAt: number;
}

export function telegramConfigured(): boolean {
  return Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID);
}

/** `Ada Lovelace <ada@example.com>` → `ada@example.com` (always lowercased). */
export function parseFromEmail(from: string): string {
  const angle = from.match(/<([^>]+)>/);
  return (angle ? angle[1] : from).trim().toLowerCase();
}

function normalizeHeader(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

/**
 * Human vs automation. Confidence order: machine headers first (the
 * auto-responder sets them itself), then sender/subject/body patterns. A
 * false "auto" only silences a notification — a false "human" spams one —
 * so every pattern here stays conservative.
 */
export function classifyReply(raw: ReplyRaw): ReplyKind {
  const headers = raw.headers ?? {};

  const autoSubmitted = normalizeHeader(headers.autoSubmitted);
  if (autoSubmitted.length > 0 && autoSubmitted !== "no") return "auto";

  const precedence = normalizeHeader(headers.precedence);
  if (["bulk", "auto_reply", "auto-reply", "list", "junk"].includes(precedence)) return "auto";

  const suppress = normalizeHeader(headers.xAutoResponseSuppress);
  if (/\b(oof|dr|rn|auto-?reply|autorespond)\b/.test(suppress)) return "auto";

  const from = normalizeHeader(raw.from);
  if (/mailer-daemon|postmaster@|bounce|undeliverable|quarantine@|no-?reply@|donotreply@/.test(from)) {
    return "auto";
  }

  const subject = (raw.subject ?? "").trim();
  if (
    /^(re|fwd?)\s*:\s*(automatic|auto\s*-?\s*reply|autoresponder|out of|ooo\b|away)/i.test(subject) ||
    /^(automatic reply|auto[- ]reply|automatic response|out of (the )?office|ooo\b|away from|on vacation|on holiday)/i.test(
      subject,
    ) ||
    /(undeliverable|delivery (status|failure|problem)|returned mail|mail delivery (failed|problem))/i.test(
      subject,
    )
  ) {
    return "auto";
  }

  const body = (raw.body ?? "").slice(0, 800).toLowerCase();
  if (
    /(this is an (automatic|automated) (reply|response)|auto[- ]reply|automatic reply|out of (the )?office|i['\s]?m (currently )?(out of (the )?office|on (vacation|leave)|away)|i am (currently )?(out of|on (vacation|leave)|away)|will be back (on|until|after)|on leave until|do not (reply|send)|replies? (to this (email|message) )?(are|is) not (monitored|checked))/.test(
      body,
    )
  ) {
    return "auto";
  }

  if (headers.listUnsubscribe && body.length < 200 && /(unsubscribe|email preferences)/i.test(body)) {
    return "auto";
  }

  return "human";
}

async function loadState(): Promise<RepliesState> {
  const state = await readJson<RepliesState>(REPLIES_PATH, true);
  return state ?? { history: [], lastCheckedAt: 0, lastCheck: null, updatedAt: 0 };
}

export async function getRepliesState(): Promise<{
  history: ReplyRecord[];
  lastCheck: RepliesCheckSummary | null;
  lastCheckedAt: number;
}> {
  const state = await loadState();
  return { history: state.history, lastCheck: state.lastCheck, lastCheckedAt: state.lastCheckedAt };
}

/**
 * Recipients we actually mailed since `since` — passed to the script so a
 * reply that Gmail failed to thread (subject rewritten by the client) is
 * still recognised as ours.
 */
async function recentRecipients(since: number): Promise<string[]> {
  const tasks = await readJson<AutomationTask[]>(TASKS_PATH, true);
  if (!Array.isArray(tasks)) return [];
  const seen = new Set<string>();
  for (const task of tasks) {
    const log = await readJson<EmailLog>(taskEmailLogPath(task.id), true);
    for (const entry of log?.entries ?? []) {
      if (entry.t < since || !entry.ok || entry.skipped) continue;
      seen.add(entry.to.toLowerCase());
      if (seen.size >= SENDERS_CAP) return [...seen];
    }
  }
  return [...seen];
}

interface MailboxReplyResult {
  label: string;
  messages: ReplyRaw[];
  outdated: boolean;
  error: string | null;
}

async function fetchMailboxReplies(
  mailbox: { id: string; label: string; webAppUrl: string },
  since: number,
  senders: string[],
): Promise<MailboxReplyResult> {
  try {
    const response = await fetch(mailbox.webAppUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "replies", since, senders }),
      cache: "no-store",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const text = await response.text();
    if (/<!doctype html|<html/i.test(text)) {
      return { label: mailbox.label, messages: [], outdated: false, error: "sign-in page (access: Anyone?)" };
    }
    let data: { ok?: unknown; error?: unknown; messages?: unknown } | null = null;
    try {
      data = JSON.parse(text) as { ok?: unknown; error?: unknown; messages?: unknown };
    } catch {
      data = null;
    }
    if (!data) {
      return { label: mailbox.label, messages: [], outdated: false, error: `HTTP ${response.status}` };
    }
    if (data.ok === false) {
      const apiError = typeof data.error === "string" ? data.error : `HTTP ${response.status}`;
      // Pre-replies script deployments answer every unknown action this way.
      if (apiError === "missing to") {
        return { label: mailbox.label, messages: [], outdated: true, error: null };
      }
      return { label: mailbox.label, messages: [], outdated: false, error: apiError };
    }
    const messages = Array.isArray(data.messages) ? (data.messages as ReplyRaw[]) : [];
    return { label: mailbox.label, messages, outdated: false, error: null };
  } catch (error) {
    return {
      label: mailbox.label,
      messages: [],
      outdated: false,
      error: error instanceof Error ? error.message.slice(0, 120) : "network error",
    };
  }
}

async function notifyReply(record: ReplyRecord): Promise<void> {
  const preview = record.body
    ? `“${record.body.slice(0, TELEGRAM_BODY_MAX)}${record.body.length > TELEGRAM_BODY_MAX ? "…" : ""}”`
    : "(no text body)";
  await notifyTelegram(
    `📩 Client replied (human)\n` +
      `From: ${record.from}\n` +
      `Mailbox: ${record.mailboxLabel}\n` +
      `Subject: ${record.subject || "(no subject)"}\n` +
      `At: ${notifyTime(record.receivedAt)}\n\n` +
      preview,
  );
}

/**
 * One check across every connected mailbox: fetch, classify, dedupe against
 * the stored history, notify Telegram for each *new human* reply, persist.
 * Never throws — a broken mailbox becomes an `errors` entry so the hourly
 * cron (and the manual button) still report progress.
 */
export async function checkReplies(): Promise<RepliesCheckSummary> {
  const state = await loadState();
  const now = Date.now();
  const since = state.lastCheckedAt
    ? state.lastCheckedAt - RECHECK_OVERLAP_MS
    : now - FIRST_CHECK_LOOKBACK_MS;
  const senders = await recentRecipients(since);

  const mailboxes = await listMailboxes();
  const results = await Promise.all(
    mailboxes.map((mailbox) => fetchMailboxReplies(mailbox, since, senders)),
  );

  const knownIds = new Set(state.history.map((record) => record.id));
  const summary: RepliesCheckSummary = {
    at: now,
    checkedMailboxes: results.length,
    newHuman: 0,
    newAuto: 0,
    outdated: results.filter((result) => result.outdated).map((result) => result.label),
    errors: results
      .filter((result) => !result.outdated && result.error)
      .map((result) => `${result.label}: ${result.error!}`),
  };

  const fresh: ReplyRecord[] = [];
  for (const result of results) {
    if (result.outdated) continue;
    const mailbox = mailboxes.find((entry) => entry.label === result.label);
    for (const raw of result.messages) {
      if (!raw?.id || knownIds.has(raw.id)) continue;
      knownIds.add(raw.id);
      const kind = classifyReply(raw);
      const record: ReplyRecord = {
        id: raw.id,
        kind,
        mailboxId: mailbox?.id ?? "",
        mailboxLabel: result.label,
        from: raw.from ?? "",
        fromEmail: parseFromEmail(raw.from ?? ""),
        to: raw.to ?? "",
        subject: raw.subject ?? "",
        body: (raw.body ?? "").slice(0, BODY_STORE_MAX),
        receivedAt: Number(raw.date) || now,
        detectedAt: now,
        notified: false,
      };
      fresh.push(record);
      if (kind === "human") summary.newHuman += 1;
      else summary.newAuto += 1;
    }
  }

  // Newest first, then notify each new human reply.
  fresh.sort((a, b) => b.receivedAt - a.receivedAt);
  if (telegramConfigured()) {
    for (const record of fresh) {
      if (record.kind !== "human") continue;
      await notifyReply(record);
      record.notified = true;
    }
  }

  await mutateJson<RepliesState>(
    REPLIES_PATH,
    (current) => {
      const next: RepliesState = current ?? {
        history: [],
        lastCheckedAt: 0,
        lastCheck: null,
        updatedAt: 0,
      };
      next.history = [...fresh, ...next.history].slice(0, HISTORY_MAX);
      next.lastCheckedAt = now;
      next.lastCheck = summary;
      next.updatedAt = now;
      return next;
    },
    "psa: replies check",
  );
  return summary;
}
