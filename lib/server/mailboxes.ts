/**
 * Connected Gmail mailboxes (Apps Script web-app endpoints) with per-day
 * send quotas. One file in the state store, all mutations serialized through
 * the store's per-path queue — the email chain bumps counters while the
 * settings page adds/removes boxes, and neither can lose the other.
 */

import { randomUUID } from "node:crypto";
import { mutateJson, readJson } from "@/lib/server/stateStore";
import type { EmailSettings, Mailbox } from "@/types/automation";

const SETTINGS_PATH = "config/mailboxes.json";

/** Gmail free accounts send ~500/day; Workspace allows 2000 — cap there. */
export const MAX_DAILY_QUOTA = 2_000;

export interface MailboxInput {
  label: string;
  webAppUrl: string;
  dailyQuota: number;
}

export type MailboxValidation =
  | { ok: true; value: MailboxInput }
  | { ok: false; error: string };

/**
 * Apps Script web apps end in `/exec` on script.google.com (or its googleusercontent
 * host). Plain http is allowed only for loopback hosts so a local e2e can mock
 * the mailer — a public endpoint must always be https.
 */
export function validateWebAppUrl(input: unknown): { ok: boolean; error?: string } {
  if (typeof input !== "string" || input.trim().length === 0) {
    return { ok: false, error: "Web app URL is required." };
  }
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return { ok: false, error: "Web app URL must be a valid URL." };
  }
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    return { ok: false, error: "Web app URL must use https." };
  }
  if (!url.pathname.endsWith("/exec")) {
    return { ok: false, error: "Use the Apps Script web-app URL — it ends with /exec." };
  }
  return { ok: true };
}

export function validateMailbox(raw: Record<string, unknown>): MailboxValidation {
  const label = typeof raw.label === "string" ? raw.label.trim() : "";
  if (label.length < 1 || label.length > 60) {
    return { ok: false, error: "Label must be 1–60 characters." };
  }
  const url = validateWebAppUrl(raw.webAppUrl);
  if (!url.ok) return { ok: false, error: url.error! };
  const quota = typeof raw.dailyQuota === "string" ? Number(raw.dailyQuota) : raw.dailyQuota;
  if (typeof quota !== "number" || !Number.isFinite(quota)) {
    return { ok: false, error: "Daily quota must be a number." };
  }
  const rounded = Math.round(quota);
  if (rounded < 1 || rounded > MAX_DAILY_QUOTA) {
    return { ok: false, error: `Daily quota must be between 1 and ${MAX_DAILY_QUOTA}.` };
  }
  return {
    ok: true,
    value: { label, webAppUrl: String(raw.webAppUrl).trim(), dailyQuota: rounded },
  };
}

function emptySettings(): EmailSettings {
  return { mailboxes: [], updatedAt: Date.now() };
}

export async function listMailboxes(): Promise<Mailbox[]> {
  const settings = await readJson<EmailSettings>(SETTINGS_PATH, true);
  return Array.isArray(settings?.mailboxes) ? settings.mailboxes : [];
}

export async function addMailbox(input: MailboxInput): Promise<Mailbox> {
  const mailbox: Mailbox = {
    id: randomUUID(),
    label: input.label,
    webAppUrl: input.webAppUrl,
    dailyQuota: input.dailyQuota,
    sent: { date: utcDate(), count: 0 },
    createdAt: Date.now(),
  };
  await mutateJson<EmailSettings>(
    SETTINGS_PATH,
    (current) => {
      const settings = current ?? emptySettings();
      settings.mailboxes.push(mailbox);
      settings.updatedAt = Date.now();
      return settings;
    },
    "psa: add mailbox",
  );
  return mailbox;
}

export async function removeMailbox(id: string): Promise<boolean> {
  let removed = false;
  await mutateJson<EmailSettings>(
    SETTINGS_PATH,
    (current) => {
      if (!current) return null;
      const before = current.mailboxes.length;
      current.mailboxes = current.mailboxes.filter((mailbox) => mailbox.id !== id);
      removed = current.mailboxes.length < before;
      if (!removed) return null;
      current.updatedAt = Date.now();
      return current;
    },
    "psa: remove mailbox",
  );
  return removed;
}

export function utcDate(at: number = Date.now()): string {
  return new Date(at).toISOString().slice(0, 10);
}

/**
 * Today's usage for a mailbox — lazily reset when the UTC date rolled. The
 * count only ever grows inside one day (single email chain holds the lease),
 * so this read-modify-write runs through the path queue.
 */
export async function consumeQuota(id: string): Promise<Mailbox | null> {
  let result: Mailbox | null = null;
  await mutateJson<EmailSettings>(
    SETTINGS_PATH,
    (current) => {
      if (!current) return null;
      const mailbox = current.mailboxes.find((entry) => entry.id === id);
      if (!mailbox) return null;
      if (mailbox.sent.date !== utcDate()) mailbox.sent = { date: utcDate(), count: 0 };
      result = mailbox;
      return current;
    },
    "psa: read quota",
  );
  return result;
}

/**
 * Round-robin pick of the next mailbox with quota left for a task's selection.
 * Returns null when every selected box is spent for the day.
 */
export async function pickMailbox(
  mailboxIds: string[],
  cursor: number,
): Promise<{ mailbox: Mailbox; cursor: number } | null> {
  if (mailboxIds.length === 0) return null;
  const settings = await readJson<EmailSettings>(SETTINGS_PATH, true);
  const today = utcDate();
  for (let step = 0; step < mailboxIds.length; step += 1) {
    const index = (cursor + step) % mailboxIds.length;
    const mailbox = settings?.mailboxes.find((entry) => entry.id === mailboxIds[index]);
    if (!mailbox) continue;
    const used = mailbox.sent.date === today ? mailbox.sent.count : 0;
    if (used < mailbox.dailyQuota) return { mailbox, cursor: (index + 1) % mailboxIds.length };
  }
  return null;
}

/** Record one successful send against a mailbox's daily quota. */
export async function recordSend(id: string): Promise<void> {
  await mutateJson<EmailSettings>(
    SETTINGS_PATH,
    (current) => {
      if (!current) return null;
      const mailbox = current.mailboxes.find((entry) => entry.id === id);
      if (!mailbox) return null;
      if (mailbox.sent.date !== utcDate()) mailbox.sent = { date: utcDate(), count: 0 };
      mailbox.sent.count += 1;
      return current;
    },
    "psa: quota use",
  );
}
