/**
 * The exact source the "Copy script" button hands the user for their own
 * Google Apps Script project (script.google.com → new project → paste →
 * Deploy → Web app → Execute as: Me, Access: Anyone). Kept as a plain
 * string so it can never drift from what the sender expects:
 *   {to, subject, body, html?, unsub?} → raw MIME send (List-Unsubscribe
 *      one-click headers) via the Gmail API, falling back to GmailApp
 *   {action:"version"}                → {ok:true, v:2} (stale-deploy probe)
 *   {action:"check", marker, minutes, subject?, to?, since?}
 *                                     → spam placement report
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
 * If Google asks to review permissions while deploying, approve once —
 * the raw-send path needs Gmail + external-request access.
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
  if (d && d.action === "version") return out({ ok: true, v: 2 });
  if (d && d.action === "check") {
    return checkMail(String(d.marker || ""), Number(d.minutes || 30), d);
  }
  if (d && d.action === "replies") {
    return listReplies(Number(d.since || 0), d.senders || []);
  }
  if (!d || !d.to) return out({ ok: false, error: "missing to" });
  // Preferred path: raw MIME through the Gmail API so the message carries the
  // List-Unsubscribe / List-Unsubscribe-Post headers that mailbox providers
  // look for on bulk mail (and one-click unsubscribes work from Gmail's UI).
  // Any failure falls back to GmailApp rather than losing the send — only
  // that fallback ships without the headers.
  try {
    sendRaw(d);
    return out({ ok: true, to: String(d.to), v: 2, mode: "raw" });
  } catch (err) {
    var opts = {};
    if (d.html) opts.htmlBody = String(d.html);
    if (d.name) opts.name = String(d.name);
    GmailApp.sendEmail(String(d.to), String(d.subject || ""), String(d.body || ""), opts);
    return out({ ok: true, to: String(d.to), v: 2, mode: "gmailapp" });
  }
}

function doGet(e) {
  var p = (e && e.parameter) || {};
  if (!p.to) return out({ ok: false, error: "missing to" });
  GmailApp.sendEmail(String(p.to), String(p.subject || ""), String(p.body || ""));
  return out({ ok: true, to: String(p.to) });
}

/**
 * One raw RFC 5322 message: multipart/alternative (or plain-only when no
 * HTML was supplied), subject/from RFC 2047-encoded when non-ASCII, and the
 * unsubscribe headers GmailApp cannot set.
 */
function sendRaw(d) {
  var lines = [];
  lines.push("MIME-Version: 1.0");
  lines.push("To: " + mimeWord(String(d.to)));
  lines.push("Subject: " + mimeWord(String(d.subject || "")));
  var sender = "";
  try {
    sender = String(Session.getActiveUser().getEmail() || "");
  } catch (err) {}
  if (d.name && sender) lines.push("From: " + mimeWord(String(d.name)) + " <" + sender + ">");
  if (d.unsub) {
    lines.push("List-Unsubscribe: <" + String(d.unsub) + ">");
    lines.push("List-Unsubscribe-Post: List-Unsubscribe=One-Click");
  }
  lines.push("Precedence: bulk");
  var boundary = "psa_" + Utilities.getUuid().replace(/-/g, "");
  if (d.html) {
    lines.push('Content-Type: multipart/alternative; boundary="' + boundary + '"');
    lines.push("");
    lines.push("--" + boundary);
    lines.push("Content-Type: text/plain; charset=UTF-8");
    lines.push("Content-Transfer-Encoding: base64");
    lines.push("");
    lines.push(b64Lines(String(d.body || "")));
    lines.push("--" + boundary);
    lines.push("Content-Type: text/html; charset=UTF-8");
    lines.push("Content-Transfer-Encoding: base64");
    lines.push("");
    lines.push(b64Lines(String(d.html)));
    lines.push("--" + boundary + "--");
  } else {
    lines.push("Content-Type: text/plain; charset=UTF-8");
    lines.push("Content-Transfer-Encoding: base64");
    lines.push("");
    lines.push(b64Lines(String(d.body || "")));
  }
  var mime = lines.join("\\r\\n");
  var resp = UrlFetchApp.fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "post",
    contentType: "application/json",
    headers: { Authorization: "Bearer " + ScriptApp.getOAuthToken() },
    payload: JSON.stringify({ raw: Utilities.base64EncodeWebSafe(Utilities.newBlob(mime).getBytes()).replace(/=+$/, "") }),
    muteHttpExceptions: true
  });
  var code = resp.getResponseCode();
  if (code < 200 || code >= 300) {
    throw new Error("gmail api " + code + ": " + String(resp.getContentText()).slice(0, 180));
  }
}

/** Base64 body in the 76-column lines MIME wants. */
function b64Lines(text) {
  var b64 = Utilities.base64Encode(Utilities.newBlob(String(text)).getBytes());
  var wrapped = "";
  for (var i = 0; i < b64.length; i += 76) wrapped += b64.slice(i, i + 76) + "\\r\\n";
  return wrapped.replace(/[\\r\\n]+$/, "");
}

/** RFC 2047 encoded-word for anything outside printable ASCII. */
function mimeWord(value) {
  var plain = String(value);
  for (var i = 0; i < plain.length; i++) {
    if (plain.charCodeAt(i) < 32 || plain.charCodeAt(i) > 126) {
      return "=?UTF-8?B?" + Utilities.base64Encode(Utilities.newBlob(plain).getBytes()) + "?=";
    }
  }
  return plain;
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
 * Spam placement: find the demo by its unique reference token and report
 * each hit's labels. When the marker search comes up empty (some clients
 * keep only one alternative of a multipart message), fall back to matching
 * the exact subject and recipient inside the same time window — both are
 * always in Gmail's index.
 */
function checkMail(marker, minutes, extra) {
  marker = String(marker || "").replace(/["\\\\]/g, "");
  if (!marker) return out({ ok: false, error: "missing marker" });
  var window = Math.max(5, Math.min(240, minutes || 30));
  var since = extra && extra.since ? Number(extra.since) - 60000 : 0;
  var matches = searchLabelled('"' + marker + '" newer_than:' + window + "m", since);
  if (matches.length === 0 && extra && extra.subject && extra.to) {
    var subject = String(extra.subject).replace(/["\\\\]/g, "");
    if (subject) {
      matches = searchLabelled(
        "to:" + String(extra.to) + ' subject:"' + subject + '" newer_than:' + window + "m",
        since
      );
    }
  }
  return out({ ok: true, marker: marker, matches: matches });
}

/** GmailApp query → label walks of every message it finds (after "since"). */
function searchLabelled(query, since) {
  var threads = GmailApp.search(query);
  var matches = [];
  for (var i = 0; i < threads.length; i++) {
    var messages = threads[i].getMessages();
    for (var j = 0; j < messages.length; j++) {
      var m = messages[j];
      if (since && m.getDate().getTime() < since) continue;
      var labels = m.getLabels();
      var names = [];
      for (var k = 0; k < labels.length; k++) names.push(labels[k].getName());
      matches.push({
        subject: m.getSubject(),
        from: m.getFrom(),
        date: String(m.getDate()),
        inbox: names.indexOf("INBOX") >= 0,
        spam: names.indexOf("SPAM") >= 0,
        labels: names.join(", ")
      });
    }
  }
  return matches;
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
  "If Google asks to review permissions while deploying, approve once — the send path needs Gmail + external-request access.",
] as const;
