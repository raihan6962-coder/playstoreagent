/**
 * Spam Check backend: a demo send through a connected mailbox, then a
 * placement query against the *recipient* Gmail.
 *
 * How the check works without any mailbox credentials: the user deploys the
 * shared Apps Script (send + `action:"check"`) inside the Gmail account they
 * want to inspect. `check` runs `GmailApp.search` for the unique reference
 * token the demo carried and reports each hit's labels, so we can say
 * Inbox / Spam / elsewhere without ever touching the recipient's password.
 */

import { randomBytes, randomUUID } from "node:crypto";
import { deliver, renderTemplate } from "@/lib/server/emailSender";
import {
  buildFooterHtml,
  buildPlainFooter,
  getFooterSettings,
  plainToHtml,
  unsubscribeUrl,
} from "@/lib/server/emailFooter";
import { listMailboxes, recordSend, validateWebAppUrl } from "@/lib/server/mailboxes";
import { mutateJson, readJson } from "@/lib/server/stateStore";
import type { Lead } from "@/types/lead";
import type {
  SpamCheckConfig,
  SpamCheckRecord,
  SpamCheckResult,
  SpamCheckState,
} from "@/types/spam-check";

const SPAM_CHECK_PATH = "config/spam-check.json";
const HISTORY_MAX = 20;
const MAX_SUBJECT = 200;
const MAX_BODY = 6_000;
const CHECK_TIMEOUT_MS = 20_000;
/** Search window asked of Gmail — grows with the demo's age, capped at 4 h. */
const CHECK_WINDOW_MAX_MINUTES = 240;

/** Uniform error the route layer maps onto a status code. */
export class SpamCheckError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "SpamCheckError";
  }
}

/**
 * Sample values for `{{placeholders}}` — the demo goes out through the exact
 * renderer the real pipeline uses, so what the checker receives is what a
 * lead would receive (modulo the fake data).
 */
function demoLead(to: string): Lead {
  return {
    packageName: "com.example.demoapp",
    title: "Sample Demo App",
    developer: "Sample Studio",
    rating: 3.4,
    ratingRaw: "3.4",
    ratingsCount: 128,
    installsRaw: "10,000",
    installs: 10_000,
    installsUpper: 10_000,
    category: "Tools",
    summary: "Demo listing used by the spam checker.",
    description: null,
    icon: null,
    urlPath: "/store/apps/details?id=com.example.demoapp",
    email: to,
    playStoreUrl: "https://play.google.com/store/apps/details?id=com.example.demoapp",
    keyword: "demo",
    relevanceScore: 1,
    relevanceTerms: [],
    installCertainty: "exact",
  };
}

function emptyState(): SpamCheckState {
  return { checkerWebAppUrl: "", subject: "", body: "", history: [], updatedAt: Date.now() };
}

/** The /exec URL is a capability — show only its origin, like mailboxes do. */
export function maskCheckerUrl(webAppUrl: string): string {
  if (!webAppUrl) return "";
  try {
    const url = new URL(webAppUrl);
    return `${url.origin}/…/exec`;
  } catch {
    return "…/exec";
  }
}

export type PublicSpamCheckConfig = SpamCheckConfig & { checkerWebAppUrl: string };

export async function getSpamCheckConfig(): Promise<PublicSpamCheckConfig> {
  const state = await readJson<SpamCheckState>(SPAM_CHECK_PATH, true);
  return {
    checkerWebAppUrl: maskCheckerUrl(state?.checkerWebAppUrl ?? ""),
    subject: state?.subject ?? "",
    body: state?.body ?? "",
  };
}

export async function getSpamHistory(): Promise<SpamCheckRecord[]> {
  const state = await readJson<SpamCheckState>(SPAM_CHECK_PATH, true);
  return Array.isArray(state?.history) ? state.history : [];
}

export interface SpamConfigInput {
  checkerWebAppUrl?: string;
  subject?: string;
  body?: string;
}

export type SpamConfigValidation =
  | { ok: true; value: SpamConfigInput }
  | { ok: false; error: string };

/** PUT payload: any subset of checker URL + saved template. */
export function validateSpamConfig(raw: unknown): SpamConfigValidation {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, error: "Request body must be a JSON object." };
  }
  const input = raw as Record<string, unknown>;
  const value: SpamConfigInput = {};
  if ("checkerWebAppUrl" in input) {
    if (typeof input.checkerWebAppUrl !== "string") {
      return { ok: false, error: "Checker URL must be text." };
    }
    const url = input.checkerWebAppUrl.trim();
    if (url.length > 0) {
      const valid = validateWebAppUrl(url);
      if (!valid.ok) return { ok: false, error: valid.error! };
      value.checkerWebAppUrl = url;
    } else {
      value.checkerWebAppUrl = ""; // explicit clear
    }
  }
  if ("subject" in input) {
    if (typeof input.subject !== "string") return { ok: false, error: "Template subject must be text." };
    const subject = input.subject.trim();
    if (subject.length > MAX_SUBJECT) {
      return { ok: false, error: `Template subject must be at most ${MAX_SUBJECT} characters.` };
    }
    value.subject = subject;
  }
  if ("body" in input) {
    if (typeof input.body !== "string") return { ok: false, error: "Template body must be text." };
    if (input.body.length > MAX_BODY) {
      return { ok: false, error: `Template body must be at most ${MAX_BODY} characters.` };
    }
    value.body = input.body;
  }
  if (Object.keys(value).length === 0) {
    return { ok: false, error: "Nothing to save — provide checkerWebAppUrl, subject or body." };
  }
  return { ok: true, value };
}

export async function saveSpamConfig(value: SpamConfigInput): Promise<PublicSpamCheckConfig> {
  await mutateJson<SpamCheckState>(
    SPAM_CHECK_PATH,
    (current) => {
      const state = current ?? emptyState();
      if (value.checkerWebAppUrl !== undefined) state.checkerWebAppUrl = value.checkerWebAppUrl;
      if (value.subject !== undefined) state.subject = value.subject;
      if (value.body !== undefined) state.body = value.body;
      state.updatedAt = Date.now();
      return state;
    },
    "psa: spam check config",
  );
  return getSpamCheckConfig();
}

export interface SpamSendInput {
  mailboxId: string;
  to: string;
  subject: string;
  body: string;
}

export type SpamSendValidation = { ok: true; value: SpamSendInput } | { ok: false; error: string };

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** POST payload for `action:"send"` — the manual demo template. */
export function validateSpamSend(raw: unknown): SpamSendValidation {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, error: "Request body must be a JSON object." };
  }
  const input = raw as Record<string, unknown>;
  const mailboxId = typeof input.mailboxId === "string" ? input.mailboxId.trim() : "";
  if (mailboxId.length === 0 || mailboxId.length > 100) {
    return { ok: false, error: "Pick the mailbox to send the demo from." };
  }
  const to = typeof input.to === "string" ? input.to.trim() : "";
  if (!EMAIL_PATTERN.test(to)) {
    return { ok: false, error: "Enter a valid recipient email to check." };
  }
  const subject = typeof input.subject === "string" ? input.subject.trim() : "";
  if (subject.length < 1 || subject.length > MAX_SUBJECT) {
    return { ok: false, error: `Subject must be 1–${MAX_SUBJECT} characters.` };
  }
  const body = typeof input.body === "string" ? input.body : "";
  if (body.trim().length < 1 || body.length > MAX_BODY) {
    return { ok: false, error: `Body must be 1–${MAX_BODY} characters.` };
  }
  return { ok: true, value: { mailboxId, to, subject, body } };
}

/**
 * Send the demo through the selected mailbox's Apps Script with a unique
 * reference token in the body, then persist the record (and the template, so
 * the form survives a reload). A failed send is still recorded — its error is
 * exactly what the user needs to see.
 */
export async function sendDemo(input: SpamSendInput): Promise<SpamCheckRecord> {
  const mailboxes = await listMailboxes();
  const mailbox = mailboxes.find((entry) => entry.id === input.mailboxId);
  if (!mailbox) throw new SpamCheckError(404, "That mailbox is not connected anymore.");

  const marker = `PSAchk${randomBytes(8).toString("hex")}`;
  const lead = demoLead(input.to);
  const subject = renderTemplate(input.subject, lead, "demo");
  const rendered = renderTemplate(input.body, lead, "demo");
  // The reference token rides the plain-text copy only: the checker finds it
  // in the text part (with a subject fallback if a client drops it), while
  // the HTML copy the reader actually sees stays clean.
  let bodyText = `${rendered}\n\n[ref ${marker}]`;
  let html: string | undefined;
  let unsub: string | undefined;
  const footer = await getFooterSettings();
  if (footer.enabled) {
    const url = unsubscribeUrl(input.to);
    unsub = url;
    bodyText += buildPlainFooter(footer.note, url);
    html = plainToHtml(rendered) + buildFooterHtml(footer.note, url);
  }

  const outcome = await deliver(mailbox.webAppUrl, input.to, subject, bodyText, html, unsub);
  if (outcome.ok) await recordSend(mailbox.id);

  const record: SpamCheckRecord = {
    id: randomUUID(),
    at: Date.now(),
    to: input.to,
    mailboxId: mailbox.id,
    mailboxLabel: mailbox.label,
    subject,
    marker,
    sendOk: outcome.ok,
    sendError: outcome.ok ? null : outcome.error ?? "Delivery failed.",
    checkedAt: null,
    result: null,
    detail: null,
  };

  await mutateJson<SpamCheckState>(
    SPAM_CHECK_PATH,
    (current) => {
      const state = current ?? emptyState();
      state.history.unshift(record);
      state.history = state.history.slice(0, HISTORY_MAX);
      state.subject = input.subject;
      state.body = input.body;
      state.updatedAt = Date.now();
      return state;
    },
    "psa: spam demo send",
  );
  return record;
}

interface CheckerMatch {
  subject?: string;
  from?: string;
  date?: string;
  inbox?: boolean;
  spam?: boolean;
  labels?: string;
}

/** Label walk: inbox beats spam only when SPAM is absent (Gmail never sets both). */
export function classifyMatches(matches: CheckerMatch[]): SpamCheckResult {
  if (matches.length === 0) return "not-found";
  if (matches.some((match) => match.inbox && !match.spam)) return "inbox";
  if (matches.some((match) => match.spam)) return "spam";
  return "other";
}

function describeMatches(matches: CheckerMatch[]): string {
  if (matches.length === 0) return "No message with that reference found yet.";
  return matches
    .slice(0, 3)
    .map((match) => {
      const labels = match.labels && match.labels.length > 0 ? match.labels : "no labels";
      const subject = match.subject ?? "(no subject)";
      return `${subject} — ${labels}`;
    })
    .join(" | ");
}

/**
 * Ask the checker Gmail where the demo landed. The record must have been
 * sent successfully; the checker URL comes from the saved config. On any
 * upstream problem the record is stamped `error` (so history explains
 * itself) and the same message is thrown for the HTTP layer.
 */
export async function runCheck(id: string): Promise<SpamCheckRecord> {
  const state = await readJson<SpamCheckState>(SPAM_CHECK_PATH, true);
  const record = state?.history?.find((entry) => entry.id === id);
  if (!state || !record) throw new SpamCheckError(404, "Demo record not found.");
  if (!state.checkerWebAppUrl) {
    throw new SpamCheckError(400, "Save the checker's Apps Script URL first (section 1).");
  }
  if (!record.sendOk) {
    throw new SpamCheckError(400, "That demo never went out — send it again first.");
  }

  const ageMinutes = (Date.now() - record.at) / 60_000;
  const minutes = Math.min(CHECK_WINDOW_MAX_MINUTES, Math.max(15, Math.ceil(ageMinutes) + 15));

  let result: SpamCheckResult;
  let detail: string;
  try {
    const response = await fetch(state.checkerWebAppUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // subject/to/since let a current checker fall back to matching the
      // demo by recipient + subject when the plain-text marker isn't indexed.
      body: JSON.stringify({
        action: "check",
        marker: record.marker,
        minutes,
        subject: record.subject,
        to: record.to,
        since: record.at,
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    });
    const text = await response.text();
    if (/<!doctype html|<html/i.test(text)) {
      throw new SpamCheckError(
        502,
        "Checker returned a Google sign-in page — redeploy its Apps Script with access: Anyone.",
      );
    }
    let data: { ok?: unknown; error?: unknown; matches?: unknown } | null = null;
    try {
      data = JSON.parse(text) as { ok?: unknown; error?: unknown; matches?: unknown };
    } catch {
      data = null;
    }
    if (!data) {
      throw new SpamCheckError(502, `Checker returned a non-JSON response (HTTP ${response.status}).`);
    }
    if (!response.ok || data.ok === false) {
      const apiError = typeof data.error === "string" ? data.error : `HTTP ${response.status}`;
      const hint =
        apiError === "missing to"
          ? " — the checker Gmail is running the old send-only script; paste the updated script there."
          : "";
      throw new SpamCheckError(502, `Checker refused the query: ${apiError}${hint}`);
    }
    const matches: CheckerMatch[] = Array.isArray(data.matches)
      ? (data.matches as CheckerMatch[])
      : [];
    result = classifyMatches(matches);
    detail = describeMatches(matches);
  } catch (error) {
    if (error instanceof SpamCheckError) {
      result = "error";
      detail = error.message;
      await stampCheck(id, result, detail);
      throw error;
    }
    result = "error";
    detail = `Checker unreachable: ${error instanceof Error ? error.message.slice(0, 160) : "network error"}`;
    await stampCheck(id, result, detail);
    throw new SpamCheckError(502, detail);
  }

  return stampCheck(id, result, detail);
}

async function stampCheck(
  id: string,
  result: SpamCheckResult,
  detail: string,
): Promise<SpamCheckRecord> {
  const checkedAt = Date.now();
  // Accumulator instead of a closure-assigned variable: TS flow analysis
  // cannot see writes that happen inside the queued mutation callback.
  const stamped: SpamCheckRecord[] = [];
  await mutateJson<SpamCheckState>(
    SPAM_CHECK_PATH,
    (current) => {
      const record = current?.history?.find((entry) => entry.id === id);
      if (!record) return null;
      record.checkedAt = checkedAt;
      record.result = result;
      record.detail = detail;
      stamped.push(record);
      return current;
    },
    "psa: spam check result",
  );
  if (stamped.length === 0) throw new SpamCheckError(404, "Demo record not found.");
  return stamped[0];
}
