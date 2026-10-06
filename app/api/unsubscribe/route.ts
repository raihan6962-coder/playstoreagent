import { allowRequest, clientIp } from "@/lib/server/rateLimit";
import { decodeRecipient, encodeRecipient } from "@/lib/server/emailFooter";
import { addUnsubscribe } from "@/lib/server/unsubscribes";

export const maxDuration = 15;

/** The page an email's Unsubscribe button lands on. Scanner-safe: the GET
 * only confirms — the actual opt-out requires the user's POST click. */
function page(title: string, lines: string[], action?: { token: string; email: string }): string {
  const body = action
    ? `<h1>Unsubscribe from outreach emails?</h1>
       <p>We'll stop sending messages to:</p>
       <p><strong style="color:#fafafa;">${action.email}</strong></p>
       <form method="POST" action="/api/unsubscribe">
         <input type="hidden" name="to" value="${action.token}" />
         <button type="submit" class="go">Yes, unsubscribe me</button>
       </form>
       <p class="muted">Changed your mind? Just close this page.</p>`
    : lines.map((line) => `<p>${line}</p>`).join("");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title}</title>
<style>
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
         padding:24px; background:#09090b; color:#fafafa;
         font-family:system-ui,-apple-system,"Segoe UI",sans-serif; }
  .card { max-width:420px; width:100%; background:#18181b; border:1px solid #27272a;
          border-radius:16px; padding:32px; }
  .eyebrow { font-size:11px; letter-spacing:.2em; text-transform:uppercase;
             color:#34d399; margin:0 0 14px; }
  h1 { font-size:20px; margin:0 0 10px; }
  p { font-size:14px; line-height:1.6; color:#a1a1aa; margin:0 0 12px; word-break:break-word; }
  .muted { font-size:12px; color:#52525b; margin:16px 0 0; }
  .go { width:100%; background:#10b981; color:#052e16; border:0; border-radius:8px;
        padding:12px 16px; font-size:14px; font-weight:600; cursor:pointer; margin-top:6px; }
  .go:hover { background:#34d399; }
  .ok { color:#34d399; font-size:32px; margin:0 0 12px; display:block; }
</style></head>
<body><main class="card">
  <p class="eyebrow">Play Store Agent</p>
  ${body}
</main></body></html>`;
}

function htmlResponse(markup: string, status = 200): Response {
  return new Response(markup, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}

/** GET /api/unsubscribe?to=<base64url> — the confirm step. */
export async function GET(request: Request): Promise<Response> {
  if (!allowRequest(clientIp(request))) {
    return htmlResponse(page("Too many requests", ["Please wait a moment and try again."]), 429);
  }
  const token = new URL(request.url).searchParams.get("to") ?? "";
  const email = decodeRecipient(token);
  if (!email) {
    return htmlResponse(
      page("Invalid link", ["This unsubscribe link isn't valid. Reply to the email instead and we'll sort it out."]),
      400,
    );
  }
  return htmlResponse(page("Unsubscribe", [], { token: encodeRecipient(email), email }));
}

/** POST — the user's actual click (form-encoded `to`, or JSON). Mail
 * providers' one-click unsubscribes POST `List-Unsubscribe=One-Click` with
 * the token only in the query string (RFC 8058), so an empty body field
 * falls back to the URL's `to`. */
export async function POST(request: Request): Promise<Response> {
  if (!allowRequest(clientIp(request))) {
    return htmlResponse(page("Too many requests", ["Please wait a moment and try again."]), 429);
  }
  let token = "";
  let oneClick = false;
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    try {
      const body = (await request.json()) as { to?: unknown };
      token = typeof body.to === "string" ? body.to : "";
    } catch {
      token = "";
    }
  } else {
    const form = new URLSearchParams(await request.text());
    token = form.get("to") ?? "";
  }
  if (!token) {
    token = new URL(request.url).searchParams.get("to") ?? "";
    oneClick = token.length > 0;
  }
  const email = decodeRecipient(token);
  if (!email) {
    return htmlResponse(
      page("Invalid link", ["This unsubscribe link isn't valid."]),
      400,
    );
  }
  await addUnsubscribe(email, oneClick ? "one-click" : "footer-link");
  return htmlResponse(
    page(
      "You're unsubscribed",
      [
        `<span class="ok">✓</span>`,
        `${email} will no longer receive outreach emails from this tool.`,
        "Existing scheduled messages to this address are skipped automatically.",
      ],
    ),
  );
}
