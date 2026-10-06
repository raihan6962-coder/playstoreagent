/**
 * The exact source the "Copy script" button hands the user for their own
 * Google Apps Script project (script.google.com → new project → paste →
 * Deploy → Web app → Execute as: Me, Access: Anyone). Kept as a plain
 * string so it can never drift from what the sender expects:
 *   {to, subject, body, html?}        → GmailApp.sendEmail
 *   {action:"check", marker, minutes} → spam placement report
 *   {action:"replies", since, senders}→ inbound reply scan
 */
export const APPS_SCRIPT_SOURCE = `/**
 * Play Store Lead Generator — Gmail sender, reply detector + spam checker.
 *
 * Deploy: Deploy → New deployment → Type: Web app
 *   Execute as: Me     Who has access: Anyone
 * Copy the /exec URL into the dashboard's Email Settings → Add mailbox.
 *
 * Updating after an edit: Deploy → Manage deployments → Edit →
 *   Version: New version → Deploy (keeps the SAME /exec URL).
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
  if (d && d.action === "replies") {
    return listReplies(Number(d.since || 0), d.senders || []);
  }
  if (!d || !d.to) return out({ ok: false, error: "missing to" });
  var opts = {};
  if (d.html) opts.htmlBody = String(d.html);
  if (d.name) opts.name = String(d.name);
  GmailApp.sendEmail(String(d.to), String(d.subject || ""), String(d.body || ""), opts);
  return out({ ok: true, to: String(d.to) });
}

function doGet(e) {
  var p = (e && e.parameter) || {};
  if (!p.to) return out({ ok: false, error: "missing to" });
  GmailApp.sendEmail(String(p.to), String(p.subject || ""), String(p.body || ""));
  return out({ ok: true, to: String(p.to) });
}

/**
 * Reply scan: recent inbox threads whose latest message is an inbound reply
 * to something this account sent (thread contains our message, or the sender
 * is a recipient we mailed since "since"). Raw headers ride along so the
 * dashboard can tell a human from an autoresponder.
 */
function listReplies(since, senders) {
  var me = String(Session.getActiveUser().getEmail() || "").toLowerCase();
  var known = {};
  for (var s = 0; s < senders.length; s++) known[String(senders[s]).toLowerCase()] = true;
  var threads = GmailApp.search("in:inbox newer_than:7d", 0, 60);
  var found = [];
  for (var i = 0; i < threads.length; i++) {
    var msgs = threads[i].getMessages();
    if (msgs.length === 0) continue;
    var last = msgs[msgs.length - 1];
    var at = last.getDate().getTime();
    if (since && at < since) continue;
    if (isMine(last.getFrom(), me)) continue;
    var threaded = false;
    for (var j = 0; j < msgs.length - 1; j++) {
      if (isMine(msgs[j].getFrom(), me)) { threaded = true; break; }
    }
    var fromEmail = extractEmail(last.getFrom());
    if (!threaded && known[fromEmail] !== true) continue;
    found.push({
      id: String(last.getId()),
      threadId: String(threads[i].getId()),
      from: String(last.getFrom() || ""),
      to: String(last.getTo() || ""),
      subject: String(last.getSubject() || ""),
      date: at,
      body: String(last.getPlainBody() || "").slice(0, 4000),
      headers: {
        autoSubmitted: readHeader(last, "Auto-Submitted"),
        precedence: readHeader(last, "Precedence"),
        xAutoResponseSuppress: readHeader(last, "X-Auto-Response-Suppress"),
        feedbackId: readHeader(last, "Feedback-ID"),
        listUnsubscribe: readHeader(last, "List-Unsubscribe")
      }
    });
  }
  return out({ ok: true, messages: found, checkedAt: new Date().getTime() });
}

function isMine(from, me) {
  if (!me) return false;
  return String(from || "").toLowerCase().indexOf(me) >= 0;
}

function extractEmail(from) {
  var m = String(from || "").match(/<([^>]+)>/);
  return String(m ? m[1] : from || "").trim().toLowerCase();
}

function readHeader(msg, name) {
  try {
    if (typeof msg.getHeader === "function") return String(msg.getHeader(name) || "");
  } catch (err) {}
  return "";
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
  "After editing later: Deploy → Manage deployments → Edit → Version: New version (keeps the same URL).",
] as const;
