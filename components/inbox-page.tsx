"use client";

import { useCallback, useEffect, useState } from "react";
import type { ReplyKind, ReplyRecord, RepliesCheckSummary } from "@/lib/server/replies";
import type { UnsubscribeEntry } from "@/lib/server/unsubscribes";

interface RepliesView {
  history: ReplyRecord[];
  lastCheck: RepliesCheckSummary | null;
  lastCheckedAt: number;
  telegramConfigured: boolean;
}

const KIND_BADGE: Record<ReplyKind, { label: string; className: string }> = {
  human: { label: "Human", className: "border-emerald-500/40 bg-emerald-500/15 text-emerald-400" },
  auto: { label: "Auto", className: "border-amber-500/40 bg-amber-500/15 text-amber-400" },
};

function formatTime(at: number): string {
  return new Date(at).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Inbox: every reply the scan found (human ones also fired a Telegram
 * alert), the notification status, and the unsubscribe list with re-subscribe.
 */
export function InboxPage() {
  const [view, setView] = useState<RepliesView | null>(null);
  const [entries, setEntries] = useState<UnsubscribeEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [checking, setChecking] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const refresh = useCallback(async () => {
    try {
      const [repliesRes, unsubRes] = await Promise.all([
        fetch("/api/replies", { cache: "no-store" }),
        fetch("/api/unsubscribes", { cache: "no-store" }),
      ]);
      const replies = (await repliesRes.json()) as RepliesView & { error?: string };
      if (repliesRes.ok) setView(replies);
      else setError(replies.error ?? "Could not load replies.");
      const unsub = (await unsubRes.json()) as { entries?: UnsubscribeEntry[] };
      if (unsubRes.ok) setEntries(unsub.entries ?? []);
    } catch {
      // Keep the last snapshot; Check now retries.
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Deferred a tick so the effect body stays free of synchronous setState.
    const timer = window.setTimeout(() => void refresh(), 0);
    return () => window.clearTimeout(timer);
  }, [refresh]);

  async function checkNow(): Promise<void> {
    if (checking) return;
    setError("");
    setChecking(true);
    try {
      const response = await fetch("/api/replies", { method: "POST" });
      const body = (await response.json()) as RepliesView & {
        error?: string;
        summary?: RepliesCheckSummary;
      };
      if (!response.ok || !body.summary) {
        setError(body.error ?? "Reply check failed.");
        return;
      }
      setView(body);
      const summary = body.summary;
      const parts: string[] = [];
      if (summary.newHuman > 0) parts.push(`${summary.newHuman} new human ${summary.newHuman === 1 ? "reply" : "replies"}`);
      if (summary.newAuto > 0) parts.push(`${summary.newAuto} auto ${summary.newAuto === 1 ? "reply" : "replies"} ignored`);
      if (summary.errors.length > 0) parts.push(`${summary.errors.length} mailbox error(s)`);
      setNotice(parts.length > 0 ? `Checked — ${parts.join(", ")}.` : "Checked — nothing new.");
      setTimeout(() => setNotice(""), 6_000);
    } catch {
      setError("Connection failed — try again.");
    } finally {
      setChecking(false);
    }
  }

  async function resubscribe(email: string): Promise<void> {
    setError("");
    try {
      const response = await fetch("/api/unsubscribes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "remove", email }),
      });
      const body = (await response.json()) as { error?: string };
      if (!response.ok) {
        setError(body.error ?? "Could not update the list.");
        return;
      }
      setEntries((current) => current.filter((entry) => entry.email !== email));
      setNotice(`${email} can receive mail again.`);
      setTimeout(() => setNotice(""), 5_000);
    } catch {
      setError("Connection failed — try again.");
    }
  }

  const humanCount = view?.history.filter((record) => record.kind === "human").length ?? 0;
  const autoCount = view?.history.filter((record) => record.kind === "auto").length ?? 0;

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-8 sm:px-6 lg:py-12">
      <header className="flex flex-col gap-2">
        <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-[0.2em] text-emerald-400">
          <span className="h-px w-6 bg-emerald-500/60" />
          Inbox
        </div>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-3xl font-semibold tracking-tight text-zinc-50">Client replies</h1>
            <p className="mt-1 max-w-2xl text-sm leading-relaxed text-zinc-400">
              Connected mailboxes are scanned every hour (and on demand) for replies to our outreach.
              Real human replies push a Telegram notification with the address and the text;
              out-of-office and auto-responders are listed here but never notify.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void checkNow()}
            disabled={checking}
            className="rounded-lg bg-emerald-500 px-5 py-2.5 text-sm font-semibold text-emerald-950 transition hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {checking ? "Checking…" : "Check now"}
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-3 text-xs">
          <span
            className={`rounded-full border px-2.5 py-0.5 font-medium ${
              view?.telegramConfigured
                ? "border-emerald-500/40 bg-emerald-500/15 text-emerald-400"
                : "border-amber-500/40 bg-amber-500/15 text-amber-400"
            }`}
          >
            {view?.telegramConfigured ? "Telegram alerts: on" : "Telegram alerts: off"}
          </span>
          {view?.lastCheckedAt ? (
            <span className="text-zinc-500">Last check {formatTime(view.lastCheckedAt)}</span>
          ) : (
            <span className="text-zinc-500">Never checked</span>
          )}
          <span className="text-zinc-500">
            {humanCount} human · {autoCount} auto
          </span>
        </div>
        {notice && <p className="text-sm text-emerald-400">{notice}</p>}
        {error && <p className="text-sm text-rose-400">{error}</p>}
        {!loading && view?.telegramConfigured === false && (
          <p className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-300">
            Set <code className="font-mono">TELEGRAM_BOT_TOKEN</code> and{" "}
            <code className="font-mono">TELEGRAM_CHAT_ID</code> in the deployment env to arm reply
            notifications — replies are still listed here either way.
          </p>
        )}
        {view?.lastCheck && view.lastCheck.outdated.length > 0 && (
          <p className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-300">
            {view.lastCheck.outdated.join(", ")} still run the old script — redeploy the updated
            version (Manage deployments → New version) to enable reply scanning there.
          </p>
        )}
        {view?.lastCheck && view.lastCheck.errors.length > 0 && (
          <p className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-300">
            {view.lastCheck.errors.join(" · ")}
          </p>
        )}
      </header>

      <section className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-5 sm:p-6">
        <h2 className="text-sm font-semibold text-zinc-100">Replies</h2>
        {loading ? (
          <p className="mt-4 text-sm text-zinc-500">Loading…</p>
        ) : !view || view.history.length === 0 ? (
          <p className="mt-4 text-sm text-zinc-500">
            No replies yet — run a campaign, then hit “Check now” (or wait for the hourly scan).
          </p>
        ) : (
          <ul className="mt-4 flex flex-col divide-y divide-zinc-800">
            {view.history.map((record) => (
              <li key={record.id} className="py-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${KIND_BADGE[record.kind].className}`}
                      >
                        {KIND_BADGE[record.kind].label}
                      </span>
                      <span className="truncate text-sm font-medium text-zinc-100">
                        {record.subject || "(no subject)"}
                      </span>
                    </div>
                    <p className="mt-1 truncate text-xs text-zinc-400">
                      {record.from || "(unknown sender)"} → {record.mailboxLabel}
                    </p>
                    <p className="mt-0.5 text-xs text-zinc-500">
                      {formatTime(record.receivedAt)}
                      {record.kind === "human" &&
                        (record.notified ? " · 🔔 Telegram sent" : " · no notification")}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setExpanded(expanded === record.id ? null : record.id)}
                    className="shrink-0 rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-400 transition hover:border-emerald-500/60 hover:text-emerald-400"
                  >
                    {expanded === record.id ? "Hide" : "Read"}
                  </button>
                </div>
                {expanded === record.id && (
                  <pre className="mt-3 max-h-72 overflow-auto whitespace-pre-wrap rounded-xl border border-zinc-800 bg-zinc-950 p-4 text-xs leading-relaxed text-zinc-300">
                    {record.body || "(empty body)"}
                  </pre>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-5 sm:p-6">
        <h2 className="text-sm font-semibold text-zinc-100">Unsubscribed addresses</h2>
        <p className="text-xs text-zinc-500">
          These are skipped automatically during sending. Re-subscribe to let outreach resume.
        </p>
        {entries.length === 0 ? (
          <p className="mt-4 text-sm text-zinc-500">Nobody has opted out — good.</p>
        ) : (
          <ul className="mt-4 flex flex-col divide-y divide-zinc-800">
            {entries.map((entry) => (
              <li key={entry.email} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div className="min-w-0">
                  <p className="truncate text-sm text-zinc-200">{entry.email}</p>
                  <p className="text-xs text-zinc-500">
                    {formatTime(entry.at)} · via {entry.source}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => void resubscribe(entry.email)}
                  className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-400 transition hover:border-emerald-500/60 hover:text-emerald-400"
                >
                  Re-subscribe
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <footer className="border-t border-zinc-800 pt-6 text-xs leading-relaxed text-zinc-500">
        Detection runs on each connected mailbox&apos;s own Apps Script — no mailbox passwords are stored.
        A reply counts as human unless machine headers (Auto-Submitted, Precedence), a
        mailer-daemon sender, or an out-of-office subject/body say otherwise.
      </footer>
    </div>
  );
}
