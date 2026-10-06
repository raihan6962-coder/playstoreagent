/**
 * Spam Check: send a demo mail from a connected mailbox and then ask the
 * *recipient's* Gmail (through an Apps Script deployed there) whether the
 * message landed in Inbox or Spam.
 */

export type SpamCheckResult =
  /** Found with the INBOX label — placement is healthy. */
  | "inbox"
  /** Found with the SPAM label — the mail went to spam. */
  | "spam"
  /** Found, but neither in Inbox nor Spam (e.g. only archived / All Mail). */
  | "other"
  /** The checker Gmail has no message with that reference yet. */
  | "not-found"
  /** The checker call itself failed (bad URL, old script, network). */
  | "error";

export interface SpamCheckRecord {
  id: string;
  /** Epoch ms the demo was sent. */
  at: number;
  /** Recipient the demo was sent to (the mailbox being checked). */
  to: string;
  mailboxId: string;
  /** Label snapshot so history stays readable after a mailbox is removed. */
  mailboxLabel: string;
  /** Rendered subject that actually went out. */
  subject: string;
  /** Unique token embedded in the demo body — the checker searches for it. */
  marker: string;
  sendOk: boolean;
  sendError: string | null;
  checkedAt: number | null;
  result: SpamCheckResult | null;
  /** Human-readable finding (labels / why the check failed). */
  detail: string | null;
}

export interface SpamCheckConfig {
  /** Apps Script /exec URL deployed in the Gmail account being checked. */
  checkerWebAppUrl: string;
  /** Saved demo template — pre-fills the send form. */
  subject: string;
  body: string;
}

export interface SpamCheckState extends SpamCheckConfig {
  history: SpamCheckRecord[];
  updatedAt: number;
}
