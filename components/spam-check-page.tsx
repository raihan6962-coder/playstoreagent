"use client";

import { useCallback, useEffect, useState } from "react";
import { APPS_SCRIPT_SOURCE, APPS_SCRIPT_STEPS } from "@/components/apps-script";
import type { Mailbox } from "@/types/automation";
import type { SpamCheckRecord, SpamCheckResult } from "@/types/spam-check";

const fieldClass =
  "w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2.5 text-sm text-zinc-100 outline-none transition placeholder:text-zinc-500 focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/20";

function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs font-medium uppercase tracking-wide text-zinc-400">{label}</span>
      {children}
      {error ? (
        <span className="text-xs text-rose-400">{error}</span>
      ) : hint ? (
        <span className="text-xs text-zinc-500">{hint}</span>
      ) : null}
    </label>
  );
}

const BADGES: Record<SpamCheckResult, { label: string; className: string }> = {
  inbox: { label: "Inbox ✓", className: "bg-emerald-500/15 text-emerald-400 border-emerald-500/40" },
  spam: { label: "Spam ✗", className: "bg-rose-500/15 text-rose-400 border-rose-500/40" },
  other: { label: "Elsewhere", className: "bg-amber-500/15 text-amber-400 border-amber-500/40" },
  "not-found": { label: "Not found yet", className: "bg-zinc-700/40 text-zinc-300 border-zinc-600" },
  error: { label: "Check failed", className: "bg-rose-500/10 text-rose-400 border-rose-500/30" },
};

function ResultBadge({ record }: { record: SpamCheckRecord }) {
  if (!record.sendOk) {
    return (
      <span className="rounded-full border border-rose-500/40 bg-rose-500/15 px-2.5 py-0.5 text-xs font-medium text-rose-400">
        Send failed
      </span>
    );
  }
  if (!record.result) {
    return (
      <span className="rounded-full border border-zinc-600 bg-zinc-700/40 px-2.5 py-0.5 text-xs font-medium text-zinc-300">
        Sent — not checked
      </span>
    );
  }
  const badge = BADGES[record.result];
  return (
    <span className={`rounded-full border px-2.5 py-0.5 text-xs font-medium ${badge.className}`}>
      {badge.label}
    </span>
  );
}

function formatTime(at: number): string {
  return new Date(at).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

interface SpamCheckView {
  config: { checkerWebAppUrl: string; subject: string; body: string };
  history: SpamCheckRecord[];
}

/**
 * Spam Check: pick the sending mailbox, write the demo template by hand,
 * send it to the inbox you want to inspect, then ask that inbox's own Apps
 * Script whether the message landed in Inbox or Spam.
 */
export function SpamCheckPage() {
  const [loading, setLoading] = useState(true);
  const [mailboxes, setMailboxes] = useState<Mailbox[]>([]);
  const [history, setHistory] = useState<SpamCheckRecord[]>([]);
  const [checkerSaved, setCheckerSaved] = useState("");
  const [copied, setCopied] = useState(false);

  const [mailboxId, setMailboxId] = useState("");
  const [to, setTo] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [checkerUrl, setCheckerUrl] = useState("");

  const [activeId, setActiveId] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [checkingId, setCheckingId] = useState<string | null>(null);
  const [savingChecker, setSavingChecker] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [checkerError, setCheckerError] = useState("");
  const [checkerNotice, setCheckerNotice] = useState("");

  const refresh = useCallback(async () => {
    try {
      const [spamResponse, mailResponse] = await Promise.all([
        fetch("/api/spam-check", { cache: "no-store" }),
        fetch("/api/email-settings", { cache: "no-store" }),
      ]);
      const spam = (await spamResponse.json()) as {
        config?: SpamCheckView["config"];
        history?: SpamCheckRecord[];
      };
      if (spamResponse.ok && spam.config) {
        setCheckerSaved(spam.config.checkerWebAppUrl);
        setSubject((current) => current || spam.config!.subject);
        setBody((current) => current || spam.config!.body);
        setHistory(spam.history ?? []);
        setActiveId((current) => current ?? spam.history?.[0]?.id ?? null);
      }
      const mail = (await mailResponse.json()) as { mailboxes?: Mailbox[] };
      if (mailResponse.ok) {
        const boxes = mail.mailboxes ?? [];
        setMailboxes(boxes);
        setMailboxId((current) => current || boxes[0]?.id || "");
      }
    } catch {
      // Keep the last snapshot; the next refresh retries.
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Deferred a tick so the effect body stays free of synchronous setState.
    const timer = window.setTimeout(() => void refresh(), 0);
    return () => window.clearTimeout(timer);
  }, [refresh]);

  async function copyScript(): Promise<void> {
    try {
      await navigator.clipboard.writeText(APPS_SCRIPT_SOURCE);
      setCopied(true);
      setTimeout(() => setCopied(false), 2_500);
    } catch {
      setError("Clipboard blocked by the browser — expand “Show script source” and copy manually.");
    }
  }

  async function saveChecker(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (savingChecker) return;
    setCheckerError("");
    const url = checkerUrl.trim();
    if (url.length === 0) {
      setCheckerError("Paste the checker's /exec URL first.");
      return;
    }
    setSavingChecker(true);
    try {
      const response = await fetch("/api/spam-check", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ checkerWebAppUrl: url }),
      });
      const parsed = (await response.json()) as { error?: string; config?: SpamCheckView["config"] };
      if (!response.ok) {
        setCheckerError(parsed.error ?? "Could not save the checker URL.");
        return;
      }
      setCheckerSaved(parsed.config?.checkerWebAppUrl ?? "");
      setCheckerUrl("");
      setCheckerNotice("Checker saved.");
      setTimeout(() => setCheckerNotice(""), 4_000);
    } catch {
      setCheckerError("Connection failed — try again.");
    } finally {
      setSavingChecker(false);
    }
  }

  async function sendDemo(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (sending) return;
    setError("");
    setSending(true);
    try {
      const response = await fetch("/api/spam-check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "send", mailboxId, to, subject, body }),
      });
      const parsed = (await response.json()) as { error?: string; record?: SpamCheckRecord };
      if (!response.ok || !parsed.record) {
        setError(parsed.error ?? "Could not send the demo.");
        return;
      }
      setHistory((current) => [parsed.record!, ...current.filter((entry) => entry.id !== parsed.record!.id)]);
      setActiveId(parsed.record.id);
      setNotice(
        parsed.record.sendOk
          ? `Demo sent to ${parsed.record.to} — give it ~15 seconds, then check.`
          : "The demo failed to send.",
      );
      setTimeout(() => setNotice(""), 6_000);
    } catch {
      setError("Connection failed — try again.");
    } finally {
      setSending(false);
    }
  }

  async function check(id: string): Promise<void> {
    if (checkingId) return;
    setError("");
    setCheckingId(id);
    setActiveId(id);
    try {
      const response = await fetch("/api/spam-check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "check", id }),
      });
      const parsed = (await response.json()) as { error?: string; record?: SpamCheckRecord };
      if (!response.ok || !parsed.record) {
        // Still refresh the row — the server stamps `error` details on it.
        if (parsed.error) setError(parsed.error);
        await refresh();
        return;
      }
      const record = parsed.record;
      setHistory((current) => current.map((entry) => (entry.id === record.id ? record : entry)));
      setActiveId(record.id);
    } catch {
      setError("Connection failed — try again.");
    } finally {
      setCheckingId(null);
    }
  }

  const active = history.find((entry) => entry.id === activeId) ?? history[0] ?? null;
  const selectedMailbox = mailboxes.find((entry) => entry.id === mailboxId);

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-8 sm:px-6 lg:py-12">
      <header className="flex flex-col gap-2">
        <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-[0.2em] text-emerald-400">
          <span className="h-px w-6 bg-emerald-500/60" />
          Spam check
        </div>
        <h1 className="text-3xl font-semibold tracking-tight text-zinc-50">See where your emails land</h1>
        <p className="max-w-2xl text-sm leading-relaxed text-zinc-400">
          Send a demo through any connected mailbox, then ask the receiving Gmail — via a tiny Apps
          Script deployed inside it — whether the message showed up in Inbox or Spam. No passwords,
          no forwarding: the checker searches its own mailbox for the demo&apos;s reference token.
        </p>
      </header>

      <section className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-5 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-zinc-100">1. Checker setup</h2>
            <p className="text-xs text-zinc-500">
              Deploy the same script inside the Gmail you want to <em>check</em> (a different account
              than the sender), then paste its /exec URL here.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void copyScript()}
            className="rounded-lg bg-emerald-500 px-4 py-2 text-sm font-semibold text-emerald-950 transition hover:bg-emerald-400"
          >
            {copied ? "Copied ✓" : "Copy script"}
          </button>
        </div>
        <ol className="mt-4 flex flex-col gap-1.5 text-sm text-zinc-400">
          {APPS_SCRIPT_STEPS.map((step) => (
            <li key={step} className="flex gap-2">
              <span className="text-emerald-500">→</span>
              {step}
            </li>
          ))}
          <li className="flex gap-2">
            <span className="text-emerald-500">→</span>
            Repeat for the checking Gmail — the script searches that account&apos;s Inbox and Spam.
          </li>
        </ol>
        <details className="mt-4">
          <summary className="cursor-pointer text-xs text-zinc-500 hover:text-zinc-300">Show script source</summary>
          <pre className="mt-3 max-h-72 overflow-auto rounded-xl border border-zinc-800 bg-zinc-950 p-4 text-[11px] leading-relaxed text-zinc-400">
            {APPS_SCRIPT_SOURCE}
          </pre>
        </details>
        <form className="mt-4 grid gap-4 sm:grid-cols-3" onSubmit={(event) => void saveChecker(event)}>
          <Field
            label="Checker web app URL"
            hint={checkerSaved ? `Saved: ${checkerSaved}` : "The /exec URL deployed in the checking Gmail"}
          >
            <input
              className={fieldClass}
              value={checkerUrl}
              onChange={(event) => setCheckerUrl(event.target.value)}
              placeholder="https://script.google.com/macros/s/…/exec"
            />
          </Field>
          <div className="flex items-end gap-3">
            <button
              type="submit"
              disabled={savingChecker}
              className="rounded-lg bg-zinc-700 px-5 py-2.5 text-sm font-semibold text-zinc-100 transition hover:bg-zinc-600 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {savingChecker ? "Saving…" : "Save checker"}
            </button>
          </div>
        </form>
        {checkerError && <p className="mt-2 text-sm text-rose-400">{checkerError}</p>}
        {checkerNotice && <p className="mt-2 text-sm text-emerald-400">{checkerNotice}</p>}
      </section>

      <section className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-5 sm:p-6">
        <h2 className="text-sm font-semibold text-zinc-100">2. Send a demo</h2>
        <p className="text-xs text-zinc-500">
          The template is yours to write — placeholders use sample values in the demo:
          {" "}{"{{app}}, {{developer}}, {{package}}, {{rating}}, {{installs}}, {{url}}, {{keyword}}"} — and{" "}
          {"{{email}}"} becomes the recipient address.
        </p>
        {loading ? (
          <p className="mt-4 text-sm text-zinc-500">Loading…</p>
        ) : mailboxes.length === 0 ? (
          <p className="mt-4 text-sm text-zinc-500">
            No mailboxes yet — connect one in Email Settings first.
          </p>
        ) : (
          <form className="mt-4 flex flex-col gap-4" onSubmit={(event) => void sendDemo(event)}>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Send from" hint={selectedMailbox ? `${selectedMailbox.label} — ${selectedMailbox.sent.count}/${selectedMailbox.dailyQuota} today` : undefined}>
                <select className={fieldClass} value={mailboxId} onChange={(event) => setMailboxId(event.target.value)}>
                  {mailboxes.map((mailbox) => (
                    <option key={mailbox.id} value={mailbox.id}>
                      {mailbox.label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Send to (the inbox you check)" hint="Use a different Gmail than the sender">
                <input
                  className={fieldClass}
                  value={to}
                  onChange={(event) => setTo(event.target.value)}
                  placeholder="you@gmail.com"
                  inputMode="email"
                />
              </Field>
            </div>
            <Field label="Subject">
              <input
                className={fieldClass}
                value={subject}
                onChange={(event) => setSubject(event.target.value)}
                placeholder="About {{app}} — quick question"
                maxLength={200}
              />
            </Field>
            <Field label="Body" hint="Saved automatically with every send">
              <textarea
                className={`${fieldClass} min-h-40 font-mono`}
                value={body}
                onChange={(event) => setBody(event.target.value)}
                placeholder={"Hi {{developer}},\n\nLoved {{app}} ({{package}}) — rating {{rating}}, installs {{installs}}.\n\n— sent for {{keyword}}"}
              />
            </Field>
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="submit"
                disabled={sending}
                className="rounded-lg bg-emerald-500 px-5 py-2.5 text-sm font-semibold text-emerald-950 transition hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {sending ? "Sending…" : "Send demo mail"}
              </button>
              {notice && <span className="text-sm text-emerald-400">{notice}</span>}
            </div>
          </form>
        )}
        {error && !sending && <p className="mt-3 text-sm text-rose-400">{error}</p>}
      </section>

      <section className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-5 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-zinc-100">3. Inbox or spam?</h2>
            <p className="text-xs text-zinc-500">
              Delivery takes a few seconds — if it says “Not found yet”, wait ~15s and check again.
            </p>
          </div>
          {active && (
            <button
              type="button"
              onClick={() => void check(active.id)}
              disabled={checkingId !== null || !active.sendOk}
              className="rounded-lg bg-emerald-500 px-4 py-2 text-sm font-semibold text-emerald-950 transition hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {checkingId === active.id ? "Checking…" : active.result ? "Check again" : "Check now"}
            </button>
          )}
        </div>
        {active ? (
          <div className="mt-4 rounded-xl border border-zinc-800 bg-zinc-950/60 p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-zinc-200">
                  {active.subject} <span className="text-zinc-500">→ {active.to}</span>
                </p>
                <p className="mt-0.5 text-xs text-zinc-500">
                  {formatTime(active.at)} · via {active.mailboxLabel}
                </p>
              </div>
              <ResultBadge record={active} />
            </div>
            {active.sendError && <p className="mt-2 text-xs text-rose-400">{active.sendError}</p>}
            {active.detail && !active.sendError && (
              <p className="mt-2 break-words font-mono text-xs text-zinc-400">{active.detail}</p>
            )}
          </div>
        ) : (
          <p className="mt-4 text-sm text-zinc-500">No demo sent yet — send one above, then check it here.</p>
        )}
      </section>

      <section className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-5 sm:p-6">
        <h2 className="text-sm font-semibold text-zinc-100">History</h2>
        {history.length === 0 ? (
          <p className="mt-4 text-sm text-zinc-500">Nothing yet — the last 20 demos show up here.</p>
        ) : (
          <ul className="mt-4 flex flex-col divide-y divide-zinc-800">
            {history.map((record) => (
              <li key={record.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div className="min-w-0">
                  <p className="truncate text-sm text-zinc-200">
                    <span className="text-zinc-500">{formatTime(record.at)}</span> · {record.subject} →{" "}
                    {record.to}
                  </p>
                  <p className="truncate text-xs text-zinc-500">
                    via {record.mailboxLabel}
                    {record.detail ? ` · ${record.detail}` : ""}
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <ResultBadge record={record} />
                  <button
                    type="button"
                    onClick={() => void check(record.id)}
                    disabled={checkingId !== null || !record.sendOk}
                    className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-400 transition hover:border-emerald-500/60 hover:text-emerald-400 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {checkingId === record.id ? "Checking…" : "Check"}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <footer className="border-t border-zinc-800 pt-6 text-xs leading-relaxed text-zinc-500">
        The checker URL and demo history live server-side only. Placement depends on your sender
        reputation, SPF/DKIM/DMARC alignment and content — a single Inbox result here is a good
        signal, not a guarantee, so keep volumes low and content honest.
      </footer>
    </div>
  );
}
