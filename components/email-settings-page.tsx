"use client";

import { useCallback, useEffect, useState } from "react";
import { APPS_SCRIPT_SOURCE, APPS_SCRIPT_STEPS } from "@/components/apps-script";
import type { Mailbox } from "@/types/automation";

/** Mirror of the server's cap (kept literal so no server code bundles here). */
const MAX_DAILY_QUOTA = 2_000;

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

/**
 * Email Settings: copy the Apps Script, connect any number of Gmail
 * mailboxes (web-app URL + per-day send quota), manage them. The URL is
 * write-only — after saving, only a masked origin comes back from the API.
 */
export function EmailSettingsPage() {
  const [mailboxes, setMailboxes] = useState<Mailbox[]>([]);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);
  const [label, setLabel] = useState("");
  const [webAppUrl, setWebAppUrl] = useState("");
  const [dailyQuota, setDailyQuota] = useState("500");
  const [formError, setFormError] = useState("");
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/email-settings", { cache: "no-store" });
      const body = (await response.json()) as { mailboxes?: Mailbox[] };
      if (response.ok) setMailboxes(body.mailboxes ?? []);
    } catch {
      // Keep the last list; the next refresh retries.
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
      setFormError("Clipboard blocked by the browser — select the script below and copy manually.");
    }
  }

  async function addMailbox(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (saving) return;
    setFormError("");
    setSaving(true);
    try {
      const response = await fetch("/api/email-settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label, webAppUrl, dailyQuota: Number(dailyQuota) }),
      });
      const body = (await response.json()) as { error?: string; mailbox?: Mailbox };
      if (!response.ok) {
        setFormError(body.error ?? "Could not save the mailbox.");
        return;
      }
      setLabel("");
      setWebAppUrl("");
      setNotice(`Connected “${body.mailbox?.label ?? label}”.`);
      setTimeout(() => setNotice(""), 4_000);
      await refresh();
    } catch {
      setFormError("Connection failed — try again.");
    } finally {
      setSaving(false);
    }
  }

  async function remove(id: string): Promise<void> {
    setFormError("");
    try {
      const response = await fetch(`/api/email-settings/${id}`, { method: "DELETE" });
      const body = (await response.json()) as { error?: string };
      if (!response.ok) {
        setFormError(body.error ?? "Could not remove the mailbox.");
        return;
      }
      await refresh();
    } catch {
      setFormError("Connection failed — try again.");
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-8 sm:px-6 lg:py-12">
      <header className="flex flex-col gap-2">
        <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-[0.2em] text-emerald-400">
          <span className="h-px w-6 bg-emerald-500/60" />
          Email settings
        </div>
        <h1 className="text-3xl font-semibold tracking-tight text-zinc-50">Connect your Gmail mailboxes</h1>
        <p className="max-w-2xl text-sm leading-relaxed text-zinc-400">
          One Apps Script deployment per Gmail account. Copy the script below, deploy it in Google Apps
          Script, then paste each web-app URL here. Every mailbox gets its own daily send quota and the
          pipeline round-robins across the ones a task selects.
        </p>
      </header>

      <section className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-5 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-zinc-100">1. Copy the sender script</h2>
            <p className="text-xs text-zinc-500">Paste it into script.google.com for each Gmail account.</p>
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
        </ol>
        <details className="mt-4">
          <summary className="cursor-pointer text-xs text-zinc-500 hover:text-zinc-300">Show script source</summary>
          <pre className="mt-3 max-h-72 overflow-auto rounded-xl border border-zinc-800 bg-zinc-950 p-4 text-[11px] leading-relaxed text-zinc-400">
            {APPS_SCRIPT_SOURCE}
          </pre>
        </details>
      </section>

      <section className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-5 sm:p-6">
        <h2 className="text-sm font-semibold text-zinc-100">2. Add a mailbox</h2>
        <form className="mt-4 grid gap-4 sm:grid-cols-3" onSubmit={(event) => void addMailbox(event)}>
          <Field label="Label" hint="Shown in task pickers">
            <input
              className={fieldClass}
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              placeholder="outreach@gmail.com"
              maxLength={60}
            />
          </Field>
          <Field label="Web app URL" hint="The /exec URL from your deployment" error={formError || undefined}>
            <input
              className={fieldClass}
              value={webAppUrl}
              onChange={(event) => setWebAppUrl(event.target.value)}
              placeholder="https://script.google.com/macros/s/…/exec"
            />
          </Field>
          <Field label="Daily send quota" hint={`1 – ${MAX_DAILY_QUOTA} emails per day`}>
            <input
              className={fieldClass}
              value={dailyQuota}
              onChange={(event) => setDailyQuota(event.target.value)}
              inputMode="numeric"
              placeholder="500"
            />
          </Field>
          <div className="sm:col-span-3 flex items-center gap-3">
            <button
              type="submit"
              disabled={saving}
              className="rounded-lg bg-emerald-500 px-5 py-2.5 text-sm font-semibold text-emerald-950 transition hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {saving ? "Saving…" : "Add mailbox"}
            </button>
            {notice && <span className="text-sm text-emerald-400">{notice}</span>}
          </div>
        </form>
      </section>

      <section className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-5 sm:p-6">
        <h2 className="text-sm font-semibold text-zinc-100">Connected mailboxes</h2>
        {loading ? (
          <p className="mt-4 text-sm text-zinc-500">Loading…</p>
        ) : mailboxes.length === 0 ? (
          <p className="mt-4 text-sm text-zinc-500">No mailboxes yet — copy the script, deploy it, then add your first URL.</p>
        ) : (
          <ul className="mt-4 flex flex-col divide-y divide-zinc-800">
            {mailboxes.map((mailbox) => {
              const used = mailbox.sent.date === new Date().toISOString().slice(0, 10) ? mailbox.sent.count : 0;
              const pct = Math.min(100, Math.round((used / mailbox.dailyQuota) * 100));
              return (
                <li key={mailbox.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-zinc-200">{mailbox.label}</p>
                    <p className="truncate font-mono text-xs text-zinc-500">{mailbox.webAppUrl}</p>
                  </div>
                  <div className="flex items-center gap-4">
                    <div className="text-right">
                      <p className="text-xs text-zinc-400">
                        <span className="font-medium text-zinc-200">{used}</span> / {mailbox.dailyQuota} today
                      </p>
                      <div className="mt-1 h-1.5 w-32 overflow-hidden rounded-full bg-zinc-800">
                        <div
                          className={`h-full rounded-full ${pct >= 100 ? "bg-amber-500" : "bg-emerald-500"}`}
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => void remove(mailbox.id)}
                      className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-400 transition hover:border-rose-500/60 hover:text-rose-400"
                    >
                      Remove
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <footer className="border-t border-zinc-800 pt-6 text-xs leading-relaxed text-zinc-500">
        The web-app URL is stored server-side only and is never shown again after saving — anyone with
        that URL could send mail as your account, so keep deployments at access: Anyone (required for
        the pipeline to deliver) and rotate by redeploying if it ever leaks.
      </footer>
    </div>
  );
}
