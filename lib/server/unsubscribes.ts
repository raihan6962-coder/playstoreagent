/**
 * The suppression list behind the footer's Unsubscribe button: addresses
 * people opted out of are never mailed again. Small, append-mostly state —
 * a Set-shaped JSON file in the state store.
 */

import { mutateJson, readJson } from "@/lib/server/stateStore";

export const UNSUBSCRIBE_PATH = "config/unsubscribes.json";

export interface UnsubscribeEntry {
  email: string;
  at: number;
  /** Where the opt-out happened: "footer-link" | "manual". */
  source: string;
}

interface UnsubscribeState {
  entries: UnsubscribeEntry[];
  updatedAt: number;
}

function normalizeEmail(email: string): string | null {
  const value = email.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value) ? value : null;
}

export async function listUnsubscribes(): Promise<UnsubscribeEntry[]> {
  const state = await readJson<UnsubscribeState>(UNSUBSCRIBE_PATH, true);
  return state?.entries ?? [];
}

export async function isUnsubscribed(email: string): Promise<boolean> {
  const normalized = normalizeEmail(email);
  if (!normalized) return false;
  const state = await readJson<UnsubscribeState>(UNSUBSCRIBE_PATH, true);
  return (state?.entries ?? []).some((entry) => entry.email === normalized);
}

/** Idempotent opt-out. Returns true only when a new entry was created (false for unusable addresses or already-opted-out). */
export async function addUnsubscribe(email: string, source = "footer-link"): Promise<boolean> {
  const normalized = normalizeEmail(email);
  if (!normalized) return false;
  let added = false;
  await mutateJson<UnsubscribeState>(
    UNSUBSCRIBE_PATH,
    (current) => {
      const state = current ?? { entries: [], updatedAt: 0 };
      if (!state.entries.some((entry) => entry.email === normalized)) {
        state.entries.unshift({ email: normalized, at: Date.now(), source });
        added = true;
      }
      state.updatedAt = Date.now();
      return state;
    },
    "psa: unsubscribe",
  );
  return added;
}

/** Opt back in (management UI). */
export async function removeUnsubscribe(email: string): Promise<boolean> {
  const normalized = normalizeEmail(email);
  if (!normalized) return false;
  let removed = false;
  await mutateJson<UnsubscribeState>(
    UNSUBSCRIBE_PATH,
    (current) => {
      if (!current) return null;
      const next = current.entries.filter((entry) => entry.email !== normalized);
      removed = next.length !== current.entries.length;
      current.entries = next;
      current.updatedAt = Date.now();
      return current;
    },
    "psa: resubscribe",
  );
  return removed;
}
