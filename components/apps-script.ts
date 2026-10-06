/**
 * The exact source the "Copy script" button hands the user for their own
 * Google Apps Script project (script.google.com → new project → paste →
 * Deploy → Web app → Execute as: Me, Access: Anyone). Kept as a plain
 * string so it can never drift from what the sender expects: POST JSON
 * {to, subject, body} → GmailApp.sendEmail → {ok: true}.
 */
export const APPS_SCRIPT_SOURCE = `/**
 * Play Store Lead Generator — Gmail sender + spam checker (Apps Script web app).
 *
 * Deploy: Deploy → New deployment → Type: Web app
 *   Execute as: Me     Who has access: Anyone
 * Copy the /exec URL into the dashboard's Email Settings → Add mailbox.
 *
 * For Spam Check, deploy this SAME script inside the Gmail account you want
 * to inspect and paste its /exec URL there.
 */
function doPost(e) {
  var d = {};
  try {
    d = JSON.parse(e.postData.contents);
  } catch (err) {
    return out({ ok: false, error: "invalid json" });
  }
  if (d && d.action === "check") {
    return checkMail(String(d.marker || ""), Number(d.minutes || 30));
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

/**
 * Spam placement: find messages carrying the demo's unique reference and
 * report their labels so the dashboard can say Inbox / Spam / elsewhere.
 */
function checkMail(marker, minutes) {
  if (!marker) return out({ ok: false, error: "missing marker" });
  marker = String(marker).replace(/["\\\\]/g, "");
  var window = Math.max(5, Math.min(240, minutes || 30));
  var threads = GmailApp.search('"' + marker + '" newer_than:' + window + "m");
  var matches = [];
  for (var i = 0; i < threads.length; i++) {
    var messages = threads[i].getMessages();
    for (var j = 0; j < messages.length; j++) {
      var m = messages[j];
      var labels = m.getLabels();
      var names = [];
      for (var k = 0; k < labels.length; k++) names.push(labels[k].getName());
      matches.push({
        subject: m.getSubject(),
        from: m.getFrom(),
        date: String(m.getDate()),
        inbox: names.indexOf("INBOX") >= 0,
        spam: names.indexOf("SPAM") >= 0,
        labels: names.join(", "),
      });
    }
  }
  return out({ ok: true, marker: marker, matches: matches });
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
