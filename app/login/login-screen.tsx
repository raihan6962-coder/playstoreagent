"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";

const MESSAGES: Record<string, string> = {
  invalid_credentials: "Wrong email or password.",
  access_denied: "This account isn't allowed. Only the workspace admin can sign in.",
  rate_limited: "Too many attempts — wait a few minutes and try again.",
  not_configured: "Sign-in isn't configured yet — the Supabase auth environment is missing.",
  auth_disabled: "Supabase Auth looks disabled for this project.",
  unverified: "This email address isn't verified yet.",
  network: "Couldn't reach the sign-in service — check your connection and try again.",
};

function LoginContent(): React.ReactElement {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      try {
        const response = await fetch("/api/auth/me", { cache: "no-store" });
        if (response.ok && !cancelled) router.replace("/");
      } catch {
        /* not signed in — stay on the sign-in screen */
      }
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [router]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      if (response.ok) {
        router.replace("/");
        router.refresh();
        return;
      }
      const payload = (await response.json().catch(() => null)) as { error?: string } | null;
      setError(MESSAGES[payload?.error ?? ""] ?? "Sign-in failed — please try again.");
    } catch {
      setError(MESSAGES.network);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="relative flex min-h-[100svh] items-center justify-center px-4 py-12">
      <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden>
        <div className="absolute left-1/2 top-1/2 h-[520px] w-[520px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-emerald-500/10 blur-[140px]" />
        <div className="absolute right-[12%] top-[18%] h-64 w-64 rounded-full bg-cyan-400/8 blur-[110px]" />
      </div>

      <div className="relative w-full max-w-md psa-fade-up">
        <div className="mb-8 flex flex-col items-center text-center">
          <div className="relative mb-5 flex h-16 w-16 items-center justify-center">
            <span className="absolute inset-0 rounded-2xl bg-gradient-to-br from-emerald-400/25 to-cyan-400/10 blur-xl" />
            <span className="relative flex h-14 w-14 items-center justify-center rounded-2xl border border-emerald-400/40 bg-zinc-950/80 shadow-[0_0_30px_-6px_rgba(16,185,129,0.55)]">
              <span className="text-xl font-black tracking-tight text-emerald-400">PSA</span>
            </span>
          </div>
          <h1 className="psa-grad-text text-3xl font-bold tracking-tight">Command Center</h1>
          <p className="mt-3 max-w-xs text-sm leading-relaxed text-zinc-400">
            Automated Play Store outreach — lead discovery, email automation and reply
            intelligence in one console.
          </p>
        </div>

        <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-7 shadow-[0_24px_80px_-24px_rgba(16,185,129,0.25)] backdrop-blur-xl">
          {error ? (
            <div
              role="alert"
              className="mb-5 rounded-xl border border-amber-400/30 bg-amber-400/10 px-4 py-3 text-sm leading-relaxed text-amber-200"
            >
              {error}
            </div>
          ) : null}

          <form onSubmit={submit} className="space-y-4">
            <div>
              <label htmlFor="email" className="mb-1.5 block text-xs uppercase tracking-[0.18em] text-zinc-500">
                Email
              </label>
              <input
                id="email"
                type="email"
                required
                autoComplete="username"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                className="w-full rounded-xl border border-white/10 bg-zinc-950/60 px-4 py-3 text-sm text-zinc-100 outline-none transition placeholder:text-zinc-600 focus-visible:border-emerald-400/60"
                placeholder="admin@example.com"
              />
            </div>

            <div>
              <label htmlFor="password" className="mb-1.5 block text-xs uppercase tracking-[0.18em] text-zinc-500">
                Password
              </label>
              <input
                id="password"
                type="password"
                required
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                className="w-full rounded-xl border border-white/10 bg-zinc-950/60 px-4 py-3 text-sm text-zinc-100 outline-none transition placeholder:text-zinc-600 focus-visible:border-emerald-400/60"
                placeholder="••••••••"
              />
            </div>

            <button
              type="submit"
              disabled={busy}
              className="group flex h-[52px] w-full items-center justify-center gap-3 rounded-xl bg-gradient-to-b from-emerald-400 to-emerald-500 text-sm font-semibold text-zinc-950 shadow-[0_12px_36px_-12px_rgba(16,185,129,0.7)] transition hover:from-emerald-300 hover:to-emerald-400 active:scale-[0.99] disabled:opacity-60"
            >
              {busy ? (
                <span className="h-4 w-4 animate-spin rounded-full border-2 border-zinc-950/30 border-t-zinc-950" />
              ) : (
                "Sign in"
              )}
            </button>
          </form>

          <p className="mt-5 text-center text-xs leading-relaxed text-zinc-500">
            Restricted access — sign-in is limited to the workspace admin account.
          </p>
        </div>

        <p className="mt-6 text-center text-[11px] uppercase tracking-[0.28em] text-zinc-600">
          Play Store Agent · Secure
        </p>
      </div>
    </div>
  );
}

export function LoginScreen(): React.ReactElement {
  return <LoginContent />;
}
