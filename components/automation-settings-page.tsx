"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { lintTemplate } from "@/lib/templateLint";
import type { AutomationTask, Mailbox, TaskStatus } from "@/types/automation";

const fieldClass =
  "w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2.5 text-sm text-zinc-100 outline-none transition placeholder:text-zinc-500 focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/20";

const STATUS_STYLE: Record<TaskStatus, string> = {
  scheduled: "border-zinc-700 text-zinc-400",
  starting: "border-emerald-500/40 text-emerald-400",
  collecting: "border-emerald-500/40 text-emerald-400",
  sending: "border-sky-500/40 text-sky-400",
  "awaiting-quota": "border-amber-500/40 text-amber-400",
  done: "border-zinc-600 text-zinc-300",
  failed: "border-rose-500/40 text-rose-400",
};

interface FormValues {
  keyword: string;
  maxRating: string;
  maxInstalls: string;
  limit: string;
  startAt: string;
  mailboxIds: string[];
  templateSubject: string;
  templateBody: string;
  intervalSeconds: string;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function toLocalInput(ms: number): string {
  const d = new Date(ms);
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

function emptyForm(): FormValues {
  return {
    keyword: "",
    maxRating: "3.5",
    maxInstalls: "500000",
    limit: "100",
    startAt: toLocalInput(Date.now() + 10 * 60_000),
    mailboxIds: [],
    templateSubject: "",
    templateBody: "",
    intervalSeconds: "30",
  };
}

function Field({
  label,
  hint,
  error,
  wide,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  wide?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className={`flex flex-col gap-1.5 ${wide ? "sm:col-span-2 lg:col-span-3" : ""}`}>
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
 * Automation Settings: book up to ~30 days of tasks (keyword, filters, lead
 * target, start date+time, which connected mailboxes to send from, the email
 * template and the per-email interval). The dashboard and the hourly cron
 * both claim due tasks, so a task starts by itself at its time, collects its
 * leads, mails them, and goes quiet for the rest of the day.
 */
export function AutomationSettingsPage() {
  const [tasks, setTasks] = useState<AutomationTask[]>([]);
  const [mailboxes, setMailboxes] = useState<Mailbox[]>([]);
  const [loading, setLoading] = useState(true);
  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [values, setValues] = useState<FormValues>(emptyForm);
  const [formError, setFormError] = useState("");
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");

  const refresh = useCallback(async () => {
    try {
      const [tasksRes, boxesRes] = await Promise.all([
        fetch("/api/tasks", { cache: "no-store" }),
        fetch("/api/email-settings", { cache: "no-store" }),
      ]);
      const tasksBody = (await tasksRes.json()) as { tasks?: AutomationTask[] };
      const boxesBody = (await boxesRes.json()) as { mailboxes?: Mailbox[] };
      if (tasksRes.ok) setTasks(tasksBody.tasks ?? []);
      if (boxesRes.ok) setMailboxes(boxesBody.mailboxes ?? []);
    } catch {
      // Next tick retries.
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Deferred a tick so the effect body stays free of synchronous setState.
    const initial = window.setTimeout(() => void refresh(), 0);
    // Precise start trigger: claim due tasks now, then every 30s while this
    // page (or the dashboard) is open. The hourly cron is the backstop.
    const kick = () => {
      void fetch("/api/tasks/start-due", { method: "POST" }).catch(() => undefined);
    };
    kick();
    const poll = window.setInterval(() => {
      void refresh();
      kick();
    }, 30_000);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(poll);
    };
  }, [refresh]);

  function set<K extends keyof FormValues>(key: K, value: FormValues[K]): void {
    setValues((previous) => ({ ...previous, [key]: value }));
  }

  function toggleMailbox(id: string): void {
    setValues((previous) => ({
      ...previous,
      mailboxIds: previous.mailboxIds.includes(id)
        ? previous.mailboxIds.filter((entry) => entry !== id)
        : [...previous.mailboxIds, id],
    }));
  }

  function openCreate(): void {
    setEditingId(null);
    setValues(emptyForm());
    setFormError("");
    setFormOpen(true);
  }

  function openEdit(task: AutomationTask): void {
    setEditingId(task.id);
    setValues({
      keyword: task.keyword,
      maxRating: String(task.maxRating),
      maxInstalls: String(task.maxInstalls),
      limit: String(task.limit),
      startAt: toLocalInput(task.startAt),
      mailboxIds: [...task.mailboxIds],
      templateSubject: task.templateSubject,
      templateBody: task.templateBody,
      intervalSeconds: String(task.intervalSeconds),
    });
    setFormError("");
    setFormOpen(true);
  }

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (saving) return;
    setFormError("");

    const startMs = new Date(values.startAt).getTime();
    if (!Number.isFinite(startMs)) {
      setFormError("Pick a valid starting time.");
      return;
    }
    if (values.mailboxIds.length === 0) {
      setFormError(
        mailboxes.length === 0
          ? "Connect a mailbox first (Email Settings)."
          : "Select at least one mailbox to send from.",
      );
      return;
    }

    const payload = {
      keyword: values.keyword,
      maxRating: Number(values.maxRating),
      maxInstalls: values.maxInstalls,
      limit: Number(values.limit),
      startAt: String(startMs),
      mailboxIds: values.mailboxIds,
      templateSubject: values.templateSubject,
      templateBody: values.templateBody,
      intervalSeconds: Number(values.intervalSeconds),
    };

    setSaving(true);
    try {
      const response = await fetch(editingId ? `/api/tasks/${editingId}` : "/api/tasks", {
        method: editingId ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = (await response.json()) as { error?: string };
      if (!response.ok) {
        setFormError(body.error ?? "Could not save the task.");
        return;
      }
      setNotice(editingId ? "Task updated." : "Task scheduled.");
      setTimeout(() => setNotice(""), 4_000);
      setFormOpen(false);
      setEditingId(null);
      await refresh();
    } catch {
      setFormError("Connection failed — try again.");
    } finally {
      setSaving(false);
    }
  }

  async function remove(id: string): Promise<void> {
    if (!window.confirm("Delete this task?")) return;
    try {
      const response = await fetch(`/api/tasks/${id}`, { method: "DELETE" });
      if (!response.ok) {
        const body = (await response.json()) as { error?: string };
        setNotice(body.error ?? "Could not delete.");
        setTimeout(() => setNotice(""), 4_000);
        return;
      }
      await refresh();
    } catch {
      setNotice("Connection failed — try again.");
      setTimeout(() => setNotice(""), 4_000);
    }
  }

  const scheduled = tasks.filter((task) => task.status === "scheduled").sort((a, b) => a.startAt - b.startAt);
  const sorted = [
    ...scheduled,
    ...tasks
      .filter((task) => task.status !== "scheduled")
      .sort((a, b) => b.updatedAt - a.updatedAt),
  ];
  // Live deliverability hints for whatever is being composed — advisory,
  // never blocking (mirrors lib/templateLint.ts on the server side).
  const lintIssues = formOpen
    ? lintTemplate({
        subject: values.templateSubject,
        body: values.templateBody,
        intervalSeconds: Number(values.intervalSeconds),
      })
    : [];

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-8 sm:px-6 lg:py-12">
      <header className="flex flex-col gap-2">
        <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-[0.2em] text-emerald-400">
          <span className="h-px w-6 bg-emerald-500/60" />
          Automation settings
        </div>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-3xl font-semibold tracking-tight text-zinc-50">Scheduled tasks</h1>
            <p className="mt-1 max-w-2xl text-sm leading-relaxed text-zinc-400">
              Book days of automations at once. Each task starts by itself at its time, collects its
              leads, sends the templated email to every collected address at your chosen interval, then
              stops — Telegram gets a message at every step.
            </p>
          </div>
          <button
            type="button"
            onClick={formOpen ? () => setFormOpen(false) : openCreate}
            className="rounded-lg bg-emerald-500 px-5 py-2.5 text-sm font-semibold text-emerald-950 transition hover:bg-emerald-400"
          >
            {formOpen ? "Close" : "Add task"}
          </button>
        </div>
        {scheduled.length > 0 && (
          <p className="text-xs text-zinc-500">
            {scheduled.length} scheduled · next fires{" "}
            <span className="text-zinc-300">{new Date(scheduled[0].startAt).toLocaleString()}</span>
            {scheduled.length > 1 && (
              <>
                {" · "}
                <Link href="/email-analytics" className="text-emerald-500 hover:text-emerald-400">
                  view email analytics
                </Link>
              </>
            )}
          </p>
        )}
        {notice && <p className="text-sm text-emerald-400">{notice}</p>}
      </header>

      {formOpen && (
        <form
          className="flex flex-col gap-5 rounded-2xl border border-emerald-500/30 bg-zinc-900/60 p-5 sm:p-6"
          onSubmit={(event) => void submit(event)}
        >
          <h2 className="text-sm font-semibold text-zinc-100">
            {editingId ? "Edit task" : "Add task"}
          </h2>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <Field label="Main keyword" wide hint="e.g. budget tracker, sudoku, recipe box">
              <input
                className={fieldClass}
                value={values.keyword}
                onChange={(event) => set("keyword", event.target.value)}
                placeholder="budget tracker"
                maxLength={80}
                autoFocus
              />
            </Field>
            <Field label="Max rating" hint="0.5 – 5.0">
              <input
                className={fieldClass}
                value={values.maxRating}
                onChange={(event) => set("maxRating", event.target.value)}
                inputMode="decimal"
                placeholder="3.5"
              />
            </Field>
            <Field label="Max installs" hint="10000, 10K, 100K or 1M">
              <input
                className={fieldClass}
                value={values.maxInstalls}
                onChange={(event) => set("maxInstalls", event.target.value)}
                placeholder="500000"
              />
            </Field>
            <Field label="Lead target" hint="1 – 1,000">
              <input
                className={fieldClass}
                value={values.limit}
                onChange={(event) => set("limit", event.target.value)}
                inputMode="numeric"
                placeholder="100"
              />
            </Field>
            <Field label="Starting time" wide hint="Your local date + time — the task starts then (± a minute while the tab is closed)">
              <input
                className={fieldClass}
                type="datetime-local"
                value={values.startAt}
                onChange={(event) => set("startAt", event.target.value)}
              />
            </Field>

            <div className="sm:col-span-2 lg:col-span-3">
              <span className="text-xs font-medium uppercase tracking-wide text-zinc-400">
                Send emails from
              </span>
              {mailboxes.length === 0 ? (
                <p className="mt-2 text-sm text-zinc-500">
                  No mailboxes connected —{" "}
                  <Link href="/email-settings" className="text-emerald-500 hover:text-emerald-400">
                    connect one in Email Settings
                  </Link>
                  .
                </p>
              ) : (
                <div className="mt-2 flex flex-wrap gap-2">
                  {mailboxes.map((mailbox) => {
                    const selected = values.mailboxIds.includes(mailbox.id);
                    return (
                      <button
                        key={mailbox.id}
                        type="button"
                        onClick={() => toggleMailbox(mailbox.id)}
                        className={
                          selected
                            ? "rounded-lg border border-emerald-500/60 bg-emerald-500/10 px-3 py-1.5 text-sm text-emerald-300"
                            : "rounded-lg border border-zinc-700 px-3 py-1.5 text-sm text-zinc-400 transition hover:border-zinc-500"
                        }
                      >
                        {selected ? "✓ " : ""}
                        {mailbox.label}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            <Field label="Email subject" wide hint="Placeholders: {{email}} {{app}} {{developer}} {{package}} {{keyword}} {{rating}} {{installs}} {{url}}">
              <input
                className={fieldClass}
                value={values.templateSubject}
                onChange={(event) => set("templateSubject", event.target.value)}
                placeholder="Quick question about {{app}}"
                maxLength={200}
              />
            </Field>
            <Field label="Email body" wide hint="Sent as-is to every collected lead address">
              <textarea
                className={`${fieldClass} min-h-36 font-mono`}
                value={values.templateBody}
                onChange={(event) => set("templateBody", event.target.value)}
                placeholder={"Hi,\n\nI came across {{app}} by {{developer}}…"}
                maxLength={5000}
              />
            </Field>
            <Field label="Seconds between emails" hint="1 – 3600; 30 is a safe pace for Gmail">
              <input
                className={fieldClass}
                value={values.intervalSeconds}
                onChange={(event) => set("intervalSeconds", event.target.value)}
                inputMode="numeric"
                placeholder="30"
              />
            </Field>
          </div>

          {lintIssues.length > 0 && (
            <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-amber-400">
                Deliverability hints
              </p>
              <ul className="mt-1.5 flex flex-col gap-1 text-xs leading-relaxed text-amber-300/90">
                {lintIssues.map((issue) => (
                  <li key={issue}>• {issue}</li>
                ))}
              </ul>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-3">
            <button
              type="submit"
              disabled={saving}
              className="rounded-lg bg-emerald-500 px-5 py-2.5 text-sm font-semibold text-emerald-950 transition hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {saving ? "Saving…" : editingId ? "Save changes" : "Schedule task"}
            </button>
            <button
              type="button"
              onClick={() => setFormOpen(false)}
              className="rounded-lg px-3 py-2.5 text-sm text-zinc-400 transition hover:text-zinc-200"
            >
              Cancel
            </button>
            {formError && <span className="text-sm text-rose-400">{formError}</span>}
          </div>
        </form>
      )}

      <section className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-5 sm:p-6">
        <h2 className="text-sm font-semibold text-zinc-100">Tasks</h2>
        {loading ? (
          <p className="mt-4 text-sm text-zinc-500">Loading…</p>
        ) : sorted.length === 0 ? (
          <p className="mt-4 text-sm text-zinc-500">
            No tasks yet — hit “Add task” to schedule your first automation.
          </p>
        ) : (
          <ul className="mt-4 flex flex-col divide-y divide-zinc-800">
            {sorted.map((task) => (
              <li key={task.id} className="flex flex-wrap items-start justify-between gap-3 py-4">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium text-zinc-100">“{task.keyword}”</span>
                    <span
                      className={`rounded-full border px-2 py-0.5 text-[11px] uppercase tracking-wide ${STATUS_STYLE[task.status]}`}
                    >
                      {task.status.replace("-", " ")}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-zinc-500">
                    {new Date(task.startAt).toLocaleString()} · target {task.limit} leads · rating ≤{" "}
                    {task.maxRating} · installs ≤ {task.maxInstalls.toLocaleString("en-US")} · every{" "}
                    {task.intervalSeconds}s
                  </p>
                  <p className="mt-0.5 text-xs text-zinc-500">
                    {task.mailboxIds.length} mailbox{task.mailboxIds.length === 1 ? "" : "es"} ·{" "}
                    <span className="text-zinc-400">{task.templateSubject || "no subject"}</span>
                  </p>
                  {(task.status === "collecting" || task.status === "sending") && (
                    <p className="mt-1 text-xs text-emerald-400">
                      {task.status === "collecting"
                        ? `Collecting — ${task.leadCount}/${task.limit} leads`
                        : `Sending — ${task.email.sent} sent, ${task.email.failed} failed`}
                    </p>
                  )}
                  {(task.status === "awaiting-quota" || task.status === "done") && (
                    <p className="mt-1 text-xs text-zinc-400">
                      {task.status === "awaiting-quota"
                        ? "Waiting for tomorrow's quota…"
                        : `Done — ${task.leadCount} leads, ${task.email.sent} sent, ${task.email.failed} failed`}
                    </p>
                  )}
                  {task.error && <p className="mt-1 text-xs text-rose-400">{task.error}</p>}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {task.status === "scheduled" && (
                    <button
                      type="button"
                      onClick={() => openEdit(task)}
                      className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-400 transition hover:border-zinc-500 hover:text-zinc-200"
                    >
                      Edit
                    </button>
                  )}
                  {task.runId && (
                    <Link
                      href="/leads"
                      className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-400 transition hover:border-emerald-500/60 hover:text-emerald-400"
                    >
                      Leads
                    </Link>
                  )}
                  <button
                    type="button"
                    onClick={() => void remove(task.id)}
                    className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-400 transition hover:border-rose-500/60 hover:text-rose-400"
                  >
                    Delete
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <footer className="border-t border-zinc-800 pt-6 text-xs leading-relaxed text-zinc-500">
        Lifecycle: scheduled → (start time) collecting → sending → done. A task with no leads or no
        reachable mailbox ends as failed with the reason shown. While this page or the Automation page
        is open, due tasks start within ~30 seconds; with everything closed the hourly sweep still
        starts them (up to about an hour late, exact while any page is open).
      </footer>
    </div>
  );
}
