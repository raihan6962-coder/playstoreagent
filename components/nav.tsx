"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/", label: "Automation" },
  { href: "/leads", label: "Leads" },
  { href: "/email-analytics", label: "Email Analytics" },
  { href: "/email-settings", label: "Email Settings" },
  { href: "/spam-check", label: "Spam Check" },
  { href: "/automation-settings", label: "Automation Settings" },
] as const;

/** Top menu: the six sections of the pipeline. */
export function Nav() {
  const pathname = usePathname();
  return (
    <header className="sticky top-0 z-20 border-b border-zinc-800 bg-zinc-950/95 backdrop-blur">
      <nav className="mx-auto flex w-full max-w-6xl flex-wrap items-center gap-x-1 gap-y-1 px-4 py-3 sm:px-6">
        <Link href="/" className="mr-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.18em] text-emerald-400">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
          PSA
        </Link>
        {LINKS.map((link) => {
          const active = link.href === "/" ? pathname === "/" : pathname.startsWith(link.href);
          return (
            <Link
              key={link.href}
              href={link.href}
              className={
                active
                  ? "rounded-lg bg-zinc-800/80 px-3 py-1.5 text-sm font-medium text-emerald-400"
                  : "rounded-lg px-3 py-1.5 text-sm text-zinc-400 transition hover:bg-zinc-900 hover:text-zinc-200"
              }
            >
              {link.label}
            </Link>
          );
        })}
      </nav>
    </header>
  );
}
