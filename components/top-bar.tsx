"use client";

import Link from "next/link";
import { useRouter, usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";

function icon(paths: ReactNode): ReactNode {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className="h-5 w-5 shrink-0"
    >
      {paths}
    </svg>
  );
}

const LINKS: { href: string; label: string; hint: string; icon: ReactNode }[] = [
  {
    href: "/",
    label: "Automation",
    hint: "Run the lead pipeline",
    icon: icon(<path d="M13 2 4.5 13.5h6L10 22l8.5-11.5h-6L13 2Z" />),
  },
  {
    href: "/leads",
    label: "Leads",
    hint: "Collected Play Store apps",
    icon: icon(
      <>
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <path d="M3 10h18M9 10v10" />
      </>,
    ),
  },
  {
    href: "/inbox",
    label: "Inbox",
    hint: "Human reply notifications",
    icon: icon(
      <>
        <path d="M22 12h-6l-2 3h-4l-2-3H2" />
        <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11Z" />
      </>,
    ),
  },
  {
    href: "/email-analytics",
    label: "Email Analytics",
    hint: "Sends, skips and health",
    icon: icon(
      <>
        <path d="M3 3v18h18" />
        <path d="M7 16v-5M12 16V8M17 16v-9" />
      </>,
    ),
  },
  {
    href: "/email-settings",
    label: "Email Settings",
    hint: "Mailboxes, template, footer",
    icon: icon(
      <>
        <rect x="2" y="4" width="20" height="16" rx="2" />
        <path d="m2.5 7 9.5 6.5L21.5 7" />
      </>,
    ),
  },
  {
    href: "/spam-check",
    label: "Spam Check",
    hint: "Inbox vs spam placement",
    icon: icon(<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" />),
  },
  {
    href: "/automation-settings",
    label: "Automation Settings",
    hint: "Rules, pacing, strictness",
    icon: icon(
      <>
        <path d="M4 6h3M11 6h9M4 12h7M15 12h5M4 18h9M17 18h3" />
        <circle cx="9" cy="6" r="2" />
        <circle cx="13" cy="12" r="2" />
        <circle cx="15" cy="18" r="2" />
      </>,
    ),
  },
];

/** Sticky glass bar with the 3-line menu that opens the section drawer. */
export function TopBar() {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState<string | null>(null);
  const pathname = usePathname();
  const router = useRouter();

  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      try {
        const response = await fetch("/api/auth/me", { cache: "no-store" });
        if (!cancelled && response.ok) {
          const data = (await response.json()) as { email?: string };
          if (data.email) setEmail(data.email);
        }
      } catch {
        /* the drawer works without the chip */
      }
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);

  const logout = async () => {
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } finally {
      router.push("/login");
    }
  };

  return (
    <>
      <header className="sticky top-0 z-40 border-b border-white/5 bg-zinc-950/75 backdrop-blur-xl">
        <nav className="mx-auto flex w-full max-w-6xl items-center justify-between px-4 py-3 sm:px-6">
          <Link href="/" className="group flex items-center gap-3">
            <span className="relative flex h-9 w-9 items-center justify-center">
              <span className="absolute inset-0 rounded-xl bg-gradient-to-br from-emerald-400/30 to-cyan-400/10 blur-md transition group-hover:blur-lg" />
              <span className="relative flex h-8 w-8 items-center justify-center rounded-xl border border-emerald-400/40 bg-zinc-950/80 text-[11px] font-black tracking-tight text-emerald-400 shadow-[0_0_18px_-4px_rgba(16,185,129,0.6)]">
                PSA
              </span>
            </span>
            <span className="hidden flex-col leading-tight sm:flex">
              <span className="text-sm font-semibold tracking-wide text-zinc-100">
                Play Store Agent
              </span>
              <span className="text-[10px] uppercase tracking-[0.3em] text-emerald-400/70">
                Command Center
              </span>
            </span>
          </Link>

          <button
            type="button"
            onClick={() => setOpen((value) => !value)}
            aria-label={open ? "Close menu" : "Open menu"}
            aria-expanded={open}
            className="group relative flex h-11 w-11 flex-col items-center justify-center gap-[5px] rounded-xl border border-white/10 bg-white/5 transition hover:border-emerald-400/40 hover:bg-white/10"
          >
            <span
              className={`block h-[2px] w-5 rounded-full bg-zinc-100 transition-all duration-300 ${
                open ? "translate-y-[7px] rotate-45" : ""
              }`}
            />
            <span
              className={`block h-[2px] w-5 rounded-full bg-zinc-100 transition-all duration-300 ${
                open ? "scale-x-0 opacity-0" : ""
              }`}
            />
            <span
              className={`block h-[2px] w-5 rounded-full bg-zinc-100 transition-all duration-300 ${
                open ? "-translate-y-[7px] -rotate-45" : ""
              }`}
            />
          </button>
        </nav>
      </header>

    {open ? (
      <>
        <div
          className="psa-fade-in fixed inset-0 z-40 bg-black/60 backdrop-blur-sm"
          onClick={() => setOpen(false)}
          aria-hidden
        />
        <aside className="psa-drawer-in fixed right-0 top-0 z-50 flex h-full w-[min(360px,90vw)] flex-col border-l border-white/10 bg-zinc-950/95 shadow-[-30px_0_80px_-30px_rgba(16,185,129,0.25)] backdrop-blur-2xl">
          <div className="flex items-center justify-between border-b border-white/5 px-5 py-4">
            <span className="text-[11px] uppercase tracking-[0.3em] text-emerald-400/80">
              Navigation
            </span>
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Close menu"
              className="flex h-8 w-8 items-center justify-center rounded-lg border border-white/10 text-zinc-400 transition hover:border-emerald-400/40 hover:text-emerald-300"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} className="h-4 w-4">
                <path d="M6 6l12 12M18 6 6 18" strokeLinecap="round" />
              </svg>
            </button>
          </div>

          <div className="flex-1 overflow-y-auto px-3 py-4">
            <ul className="space-y-1.5">
              {LINKS.map((link) => {
                const active =
                  link.href === "/" ? pathname === "/" : pathname.startsWith(link.href);
                return (
                  <li key={link.href}>
                    <Link
                      href={link.href}
                      onClick={() => setOpen(false)}
                      className={`group relative flex items-center gap-3.5 rounded-xl px-4 py-3 transition ${
                        active
                          ? "border border-emerald-400/25 bg-emerald-400/10 text-emerald-300"
                          : "border border-transparent text-zinc-300 hover:border-white/10 hover:bg-white/5 hover:text-zinc-100"
                      }`}
                    >
                      <span
                        className={`absolute left-0 top-1/2 h-7 w-[3px] -translate-y-1/2 rounded-full transition ${
                          active
                            ? "bg-emerald-400 shadow-[0_0_12px_2px_rgba(16,185,129,0.55)]"
                            : "bg-transparent"
                        }`}
                      />
                      <span className={active ? "text-emerald-300" : "text-zinc-500 group-hover:text-emerald-400"}>
                        {link.icon}
                      </span>
                      <span className="flex flex-col">
                        <span className="text-sm font-medium">{link.label}</span>
                        <span className="text-[11px] text-zinc-500">{link.hint}</span>
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>

          <div className="border-t border-white/5 px-5 py-4">
            <div className="mb-3 flex items-center gap-2.5 rounded-xl border border-white/10 bg-white/[0.03] px-3.5 py-3">
              <span className="relative flex h-2 w-2">
                <span className="psa-dot absolute inline-flex h-full w-full rounded-full bg-emerald-400" />
              </span>
              <span className="min-w-0 flex-1 truncate text-xs text-zinc-300">
                {email ?? "admin session"}
              </span>
            </div>
            <button
              type="button"
              onClick={() => void logout()}
              className="flex w-full items-center justify-center gap-2 rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm font-medium text-zinc-300 transition hover:border-red-400/40 hover:bg-red-400/10 hover:text-red-300"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} className="h-4 w-4">
                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              Sign out
            </button>
          </div>
        </aside>
      </>
    ) : null}
    </>
  );
}
