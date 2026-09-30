"use client";

export interface SearchValues {
  keyword: string;
  maxRating: string;
  maxInstalls: string;
  limit: string;
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
  const set = (key: keyof SearchValues) => (event: React.ChangeEvent<HTMLInputElement>) =>
    onChange({ ...values, [key]: event.target.value });

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

        <Field label="Max rating" error={errors.maxRating} hint="0.5 – 5.0, only apps at or below this score">
          <input
            className={fieldClass}
            value={values.maxRating}
            onChange={set("maxRating")}
            inputMode="decimal"
            placeholder="3"
          />
        </Field>

        <Field label="Max installs" error={errors.maxInstalls} hint="10000, 10K, 100K or 1M">
          <input
            className={fieldClass}
            value={values.maxInstalls}
            onChange={set("maxInstalls")}
            inputMode="text"
            placeholder="100000"
          />
        </Field>

        <Field label="Number of leads" error={errors.limit} hint="1 – 100, generation stops early once reached">
          <input
            className={fieldClass}
            value={values.limit}
            onChange={set("limit")}
            inputMode="numeric"
            placeholder="10"
          />
        </Field>
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
