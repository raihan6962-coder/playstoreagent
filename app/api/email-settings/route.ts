import { addMailbox, listMailboxes, validateMailbox } from "@/lib/server/mailboxes";
import { getFooterSettings, saveFooterSettings, validateFooter } from "@/lib/server/emailFooter";
import { storeErrorResponse } from "@/lib/server/runs";
import { allowRequest, clientIp } from "@/lib/server/rateLimit";
import type { Mailbox } from "@/types/automation";

export const maxDuration = 60;

function jsonError(status: number, error: string): Response {
  return Response.json({ error }, { status });
}

/** The /exec URL is a send-as-you capability — never echo it back. */
function maskUrl(webAppUrl: string): string {
  try {
    const url = new URL(webAppUrl);
    return `${url.origin}/…/exec`;
  } catch {
    return "…/exec";
  }
}

export type PublicMailbox = Omit<Mailbox, "webAppUrl"> & { webAppUrl: string };

function publicMailbox(mailbox: Mailbox): PublicMailbox {
  return { ...mailbox, webAppUrl: maskUrl(mailbox.webAppUrl) };
}

/**
 * Connected mailboxes + the outreach footer settings. The web-app URL is
 * write-only: you paste it once on add, and every later read shows only the
 * masked origin — so the list endpoint never hands out a send-as-you
 * capability.
 */
export async function GET(): Promise<Response> {
  try {
    const [mailboxes, footer] = await Promise.all([listMailboxes(), getFooterSettings()]);
    return Response.json(
      { ok: true, mailboxes: mailboxes.map(publicMailbox), footer },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return storeErrorResponse(error) ?? jsonError(500, "Could not list mailboxes.");
  }
}

/** Connect a mailbox (Apps Script web-app URL + its daily send quota). */
export async function POST(request: Request): Promise<Response> {
  if (!allowRequest(clientIp(request))) {
    return jsonError(429, "Too many requests. Please wait a moment and try again.");
  }
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return jsonError(400, "Request body must be valid JSON.");
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return jsonError(400, "Request body must be a JSON object.");
  }

  const validated = validateMailbox(raw as Record<string, unknown>);
  if (!validated.ok) return jsonError(400, validated.error);

  try {
    const mailbox = await addMailbox(validated.value);
    return Response.json({ ok: true, mailbox: publicMailbox(mailbox) }, { status: 201 });
  } catch (error) {
    return storeErrorResponse(error) ?? jsonError(500, "Could not save the mailbox.");
  }
}

/** Save the footer + unsubscribe settings ({footer: {enabled, note}}). */
export async function PUT(request: Request): Promise<Response> {
  if (!allowRequest(clientIp(request))) {
    return jsonError(429, "Too many requests. Please wait a moment and try again.");
  }
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return jsonError(400, "Request body must be valid JSON.");
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return jsonError(400, "Request body must be a JSON object.");
  }
  const input = (raw as { footer?: unknown }).footer;
  if (input === undefined) {
    return jsonError(400, 'Provide {footer: {enabled, note}}.');
  }
  const validated = validateFooter(input);
  if (!validated.ok) return jsonError(400, validated.error);
  try {
    const footer = await saveFooterSettings(validated.value);
    return Response.json({ ok: true, footer });
  } catch (error) {
    return storeErrorResponse(error) ?? jsonError(500, "Could not save the footer settings.");
  }
}
