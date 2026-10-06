"use client";

import { Suspense, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";

const MESSAGES: Record<string, string> = {
  access_denied: "This Google account isn't allowed. Only the workspace admin can sign in.",
  not_configured: "Sign-in isn't configured yet — the Supabase auth environment is missing.",
  provider_error: "Supabase refused the Google sign-in. Check that the Google provider is enabled.",
  redirect_mismatch: "Supabase hasn't allowlisted this app's callback URL (Authentication → URL Configuration).",
  auth_disabled: "Supabase Auth looks disabled for this project.",
  pkce_mismatch: "The sign-in session didn't match — please try again.",
  code_expired: "That sign-in link expired — please try again.",
  exchange_failed: "Couldn't complete the sign-in with Supabase — please try again.",
  no_email: "Google didn't return an email address for this account.",
  unverified: "Google hasn't verified this account's email address.",
  missing_code: "The sign-in was interrupted — please try again.",
  expired: "Your sign-in attempt expired — please try again.",
  rate_limited: "Too many attempts — wait a moment and try again.",
};

function GoogleGlyph(): React.ReactElement {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className="h-5 w-5">
      <path
        fill="#4285F4"
        d="M23.49 12.27c0-.79-.07-1.54-.19-2.27H12v4.51h6.47a5.54 5.54 0 0 1-2.4 3.63v3.02h3.88c2.27-2.09 3.54-5.17 3.54-8.89Z"
      />
      <path
        fill="#34A853"
        d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.88-3.01c-1.08.72-2.45 1.15-4.05 1.15-3.13 0-5.78-2.11-6.73-4.96H1.28v3.09A11.99 11.99 0 0 0 12 24Z"
      />
      <path
        fill="#FBBC05"
        d="M5.27 14.27a7.19 7.19 0 0 1 0-4.54V6.64H1.28a12 12 0 0 0 0 10.72l3.99-3.09Z"
      />
      <path
        fill="#EA4335"
        d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0A11.99 11.99 0 0 0 1.28 6.64l3.99 3.09C6.22 6.86 8.87 4.75 12 4.75Z"
      />
    </svg>
  );
}

function LoginContent(): React.ReactElement {
  const searchParams = useSearchParams();
  const router = useRouter();
  const error = searchParams.get("error");
  const deniedEmail = searchParams.get("email");

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

  const message = error ? (MESSAGES[error] ?? "Sign-in failed — please try again.") : null;

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
          {message ? (
            <div className="mb-5 rounded-xl border border-amber-400/30 bg-amber-400/10 px-4 py-3 text-sm leading-relaxed text-amber-200">
              {message}
              {deniedEmail ? (
                <span className="mt-1 block break-all text-amber-300/80">
                  Account: <strong>{deniedEmail}</strong>
                </span>
              ) : null}
            </div>
          ) : null}

          <a
            href="/api/auth/login"
            className="group flex h-[52px] w-full items-center justify-center gap-3 rounded-xl border border-white/15 bg-white text-sm font-semibold text-zinc-900 transition hover:bg-white/90 active:scale-[0.99]"
          >
            <GoogleGlyph />
            Continue with Google
          </a>

          <p className="mt-5 text-center text-xs leading-relaxed text-zinc-500">
            Restricted access — sign-in is limited to the workspace admin Google account.
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
  return (
    <Suspense fallback={null}>
      <LoginContent />
    </Suspense>
  );
}
