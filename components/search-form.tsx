"use client";

import { DEFAULT_WINDOW_DAYS, PUBLISHED_WINDOWS } from "@/lib/validation/input";

export interface SearchValues {
  keyword: string;
  maxRating: string;
  maxInstalls: string;
  limit: string;
  /**
   * "Newly published apps": the store window in days, or "" for the mode off.
   */
  publishedWithinDays: string;
}

interface SearchFormProps {
  values: SearchValues;
  errors: Partial<Record<keyof SearchValues, string>>;
  running: boolean;
  canResume: boolean;
  onChange: (values: SearchValues) => void;
  onSubmit: () => void;
  onStop: () => void;
  onResume: () => void;
  onReset: () => void;
}

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

export function SearchForm({
  values,
  errors,
  running,
  canResume,
  onChange,
  onSubmit,
  onStop,
  onResume,
  onReset,
}: SearchFormProps) {
  const newAppsMode = values.publishedWithinDays !== "";
  const set =
    (key: "keyword" | "maxRating" | "maxInstalls" | "limit") =>
    (event: React.ChangeEvent<HTMLInputElement>) =>
      onChange({
        ...values,
        [key]: event.target.value,
      });

  const toggleNewApps = (event: React.ChangeEvent<HTMLInputElement>): void => {
    onChange({
      ...values,
      publishedWithinDays: event.target.checked ? String(DEFAULT_WINDOW_DAYS) : "",
    });
  };

  const setWindow = (event: React.ChangeEvent<HTMLSelectElement>): void => {
    onChange({ ...values, publishedWithinDays: event.target.value });
  };

  return (
    <form
      className="flex flex-col gap-5 rounded-2xl border border-zinc-800 bg-zinc-900/60 p-5 sm:p-6"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <Field label="Keyword" error={errors.keyword} hint="e.g. budget tracker, sudoku, crypto wallet">
            <input
              className={fieldClass}
              value={values.keyword}
              onChange={set("keyword")}
              placeholder="budget tracker"
              maxLength={80}
              autoFocus
            />
          </Field>
        </div>

        <Field
          label="Max rating"
          error={errors.maxRating}
          hint={
            newAppsMode
              ? "Off in newly-published mode — only unrated apps qualify, so there is no rating to cap"
              : "0.5 – 5.0, only apps at or below this score"
          }
        >
          <input
            className={fieldClass}
            value={values.maxRating}
            onChange={set("maxRating")}
            inputMode="decimal"
            placeholder="3"
            disabled={newAppsMode}
          />
        </Field>

        <Field
          label="Max installs"
          error={errors.maxInstalls}
          hint={
            newAppsMode
              ? "Keep this low — a brand-new app has few installs"
              : "10000, 10K, 100K or 1M"
          }
        >
          <input
            className={fieldClass}
            value={values.maxInstalls}
            onChange={set("maxInstalls")}
            inputMode="text"
            placeholder="5000000"
          />
        </Field>

        <Field
          label="Number of leads"
          error={errors.limit}
          hint="1 – 1,000, generation stops early once reached"
        >
          <input
            className={fieldClass}
            value={values.limit}
            onChange={set("limit")}
            inputMode="numeric"
            placeholder="10"
          />
        </Field>
      </div>

      <div className="flex flex-col gap-3 rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3">
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
          <label className="flex cursor-pointer items-center gap-2.5">
            <input
              type="checkbox"
              checked={newAppsMode}
              onChange={toggleNewApps}
              className="h-4 w-4 accent-emerald-500"
            />
            <span className="text-sm font-medium text-zinc-100">Newly published apps</span>
          </label>
          <label className="flex items-center gap-2 text-xs text-zinc-400">
            Published within
            <select
              className="rounded-lg border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 text-sm text-zinc-100 outline-none transition focus:border-emerald-500 disabled:opacity-50"
              value={values.publishedWithinDays || String(DEFAULT_WINDOW_DAYS)}
              onChange={setWindow}
              disabled={!newAppsMode}
            >
              {PUBLISHED_WINDOWS.map((days) => (
                <option key={days} value={days}>
                  {days} days
                </option>
              ))}
            </select>
          </label>
        </div>
        <p className="text-xs leading-relaxed text-zinc-500">
          Only apps the store says were published inside that window — a brand-new listing, not
          an old one with a fresh update. The run stays on this one keyword, and it only
          collects listings nobody has rated yet: a rated app has been around, and a big
          install count says the same. The lead target still applies.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={running}
          className="rounded-lg bg-emerald-500 px-5 py-2.5 text-sm font-semibold text-emerald-950 transition hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {running ? "Generating…" : "Find leads"}
        </button>

        {running && (
          <button
            type="button"
            onClick={onStop}
            className="rounded-lg border border-zinc-700 px-4 py-2.5 text-sm font-medium text-zinc-200 transition hover:border-zinc-500"
          >
            Stop
          </button>
        )}

        {!running && canResume && (
          <button
            type="button"
            onClick={onResume}
            className="rounded-lg border border-amber-500/40 px-4 py-2.5 text-sm font-medium text-amber-300 transition hover:bg-amber-500/10"
          >
            Resume search
          </button>
        )}

        {!running && (
          <button
            type="button"
            onClick={onReset}
            className="rounded-lg px-3 py-2.5 text-sm text-zinc-400 transition hover:text-zinc-200"
          >
            Reset
          </button>
        )}
      </div>
    </form>
  );
}
