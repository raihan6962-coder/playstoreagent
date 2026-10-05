/**
 * The exact source the "Copy script" button hands the user for their own
 * Google Apps Script project (script.google.com → new project → paste →
 * Deploy → Web app → Execute as: Me, Access: Anyone). Kept as a plain
 * string so it can never drift from what the sender expects: POST JSON
 * {to, subject, body} → GmailApp.sendEmail → {ok: true}.
 */
export const APPS_SCRIPT_SOURCE = `/**
 * Play Store Lead Generator — Gmail sender (Apps Script web app).
 *
 * Deploy: Deploy → New deployment → Type: Web app
 *   Execute as: Me     Who has access: Anyone
 * Copy the /exec URL into the dashboard's Email Settings → Add mailbox.
 */
function doPost(e) {
  var d = {};
  try {
    d = JSON.parse(e.postData.contents);
  } catch (err) {
    return out({ ok: false, error: "invalid json" });
  }
  if (!d || !d.to) return out({ ok: false, error: "missing to" });
  GmailApp.sendEmail(String(d.to), String(d.subject || ""), String(d.body || ""));
  return out({ ok: true, to: String(d.to) });
}

function doGet(e) {
  var p = (e && e.parameter) || {};
  if (!p.to) return out({ ok: false, error: "missing to" });
  GmailApp.sendEmail(String(p.to), String(p.subject || ""), String(p.body || ""));
  return out({ ok: true, to: String(p.to) });
}

function out(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
`;

export const APPS_SCRIPT_STEPS = [
  "Open script.google.com → New project.",
  'Click the editor, select everything, and paste the copied script.',
  "Deploy → New deployment → Type: Web app.",
  'Execute as: Me — Who has access: Anyone → Deploy.',
  "Copy the web app URL (ends with /exec) and add it below.",
] as const;
