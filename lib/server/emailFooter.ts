/**
 * The footer every outreach email carries: a one-line reason, an Unsubscribe
 * button (HTML) / link (plain text), configurable from Email Settings. The
 * plain-text copy always ships — it works even on old Apps Script
 * deployments that don't know about `html` — while the styled button rides
 * along as `htmlBody` once the script is redeployed.
 */

import { mutateJson, readJson } from "@/lib/server/stateStore";

export const FOOTER_PATH = "config/emailFooter.json";
export const MAX_NOTE = 400;
const DEFAULT_ORIGIN = "https://playstoreagent.vercel.app";

export interface FooterSettings {
  enabled: boolean;
  note: string;
  updatedAt: number;
}

export function defaultFooter(): FooterSettings {
  return {
    enabled: true,
    note: "You received this email because your app's contact address is listed publicly on Google Play.",
    updatedAt: 0,
  };
}

/** Link targets must outlive any single deployment — never the request host. */
export function siteOrigin(): string {
  const raw = process.env.SITE_URL;
  if (raw) {
    try {
      return new URL(raw).origin;
    } catch {
      /* fall through to the canonical origin */
    }
  }
  return DEFAULT_ORIGIN;
}

export function encodeRecipient(email: string): string {
  return Buffer.from(email.trim().toLowerCase(), "utf8").toString("base64url");
}

export function decodeRecipient(token: string): string | null {
  try {
    const decoded = Buffer.from(token, "base64url").toString("utf8");
    return decoded.includes("@") ? decoded : null;
  } catch {
    return null;
  }
}

export function unsubscribeUrl(to: string): string {
  return `${siteOrigin()}/api/unsubscribe?to=${encodeRecipient(to)}`;
}

/** Plain-text footer — separator, the reason, then the link on its own line. */
export function buildPlainFooter(note: string, url: string): string {
  const reason = note.trim() || defaultFooter().note;
  return `\n\n————————————\n${reason}\nNo longer interested? Unsubscribe: ${url}`;
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** Render an HTML copy of a plain-text body: escaped, paragraphs preserved. */
export function plainToHtml(body: string): string {
  const paragraphs = body.split(/\n{2,}/).map((block) => escapeHtml(block).replaceAll("\n", "<br>"));
  return paragraphs.map((block) => `<p style="margin:0 0 14px;">${block}</p>`).join("");
}

/** Styled footer: hairline rule, muted reason line, a real button. */
export function buildFooterHtml(note: string, url: string): string {
  const reason = escapeHtml(note.trim() || defaultFooter().note);
  const href = escapeHtml(url);
  return (
    `<div style="margin-top:26px;padding-top:16px;border-top:1px solid #e4e4e7;` +
    `font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:1.7;color:#71717a;">` +
    `<p style="margin:0 0 10px;">${reason}</p>` +
    `<p style="margin:0;">` +
    `<a href="${href}" ` +
    `style="display:inline-block;background:#10b981;color:#052e16;text-decoration:none;` +
    `padding:8px 18px;border-radius:6px;font-weight:bold;font-size:12px;">Unsubscribe</a>` +
    `</p></div>`
  );
}

export async function getFooterSettings(): Promise<FooterSettings> {
  const stored = await readJson<FooterSettings>(FOOTER_PATH, true);
  if (!stored) return defaultFooter();
  return {
    enabled: stored.enabled !== false,
    note: typeof stored.note === "string" ? stored.note : defaultFooter().note,
    updatedAt: stored.updatedAt ?? 0,
  };
}

export type FooterValidation = { ok: true; value: { enabled: boolean; note: string } } | { ok: false; error: string };

export function validateFooter(raw: unknown): FooterValidation {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, error: "Footer settings must be a JSON object." };
  }
  const input = raw as Record<string, unknown>;
  const value: { enabled: boolean; note: string } = { enabled: true, note: "" };
  if ("enabled" in input) {
    if (typeof input.enabled !== "boolean") return { ok: false, error: "enabled must be true or false." };
    value.enabled = input.enabled;
  }
  if ("note" in input) {
    if (typeof input.note !== "string") return { ok: false, error: "Footer note must be text." };
    if (input.note.length > MAX_NOTE) {
      return { ok: false, error: `Footer note must be at most ${MAX_NOTE} characters.` };
    }
    value.note = input.note.trim();
  } else {
    value.note = defaultFooter().note;
  }
  return { ok: true, value };
}

export async function saveFooterSettings(value: { enabled: boolean; note: string }): Promise<FooterSettings> {
  await mutateJson<FooterSettings>(
    FOOTER_PATH,
    () => ({ enabled: value.enabled, note: value.note, updatedAt: Date.now() }),
    "psa: email footer",
  );
  return getFooterSettings();
}
