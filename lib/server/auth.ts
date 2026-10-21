import { clearFailures, noteFailure, withinFailureBudget } from "@/lib/server/rateLimit";

/**
 * Admin-only auth. Stateless HMAC-signed session cookies (verified with
 * WebCrypto only, so the edge proxy and Node route handlers share one
 * implementation) plus the Supabase password-grant sign-in.
 *
 * The identity decision is made once, at login: Supabase Auth proves the
 * credentials, we then whitelist-check the email and mint our own session.
 * Nothing about the rest of the app talks to Supabase.
 */

export const SESSION_COOKIE = "psa_session";
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Failed sign-ins allowed per IP+email before cooling off. */
export const LOGIN_FAILURE_LIMIT = 5;
export const LOGIN_FAILURE_WINDOW_MS = 15 * 60 * 1000;

/**
 * Accounts that may sign in unless ADMIN_EMAILS overrides them. Kept in code
 * rather than env because the owner's Vercel org blocks env edits via API
 * (SAML), so the allowlist is only changeable through a commit.
 */
const DEFAULT_ADMIN_EMAILS = ["revnexa0@gmail.com", "raihan6962@gmail.com"];

const encoder = new TextEncoder();

export interface Session {
  email: string;
  exp: number;
}

export function adminEmails(): string[] {
  const raw = process.env.ADMIN_EMAILS?.trim() ?? "";
  const list = raw
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  return list.length > 0 ? list : [...DEFAULT_ADMIN_EMAILS];
}

export function isAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  return adminEmails().includes(email.trim().toLowerCase());
}

function authSecret(): string {
  const secret = process.env.AUTH_SECRET?.trim();
  if (!secret) throw new Error("AUTH_SECRET is not configured.");
  return secret;
}

export function supabaseUrl(): string {
  const url = process.env.SUPABASE_URL?.trim().replace(/\/+$/, "");
  if (!url) throw new Error("SUPABASE_URL is not configured.");
  return url;
}

export function supabaseServiceKey(): string {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!key) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not configured.");
  return key;
}

/* ── base64url + HMAC (WebCrypto) ────────────────────────────────────────── */

function b64urlFromBytes(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function bytesFromB64url(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function b64urlFromString(value: string): string {
  return b64urlFromBytes(encoder.encode(value));
}

function stringFromB64url(value: string): string {
  return new TextDecoder().decode(bytesFromB64url(value));
}

async function hmac(data: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(authSecret()),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(data));
  return new Uint8Array(signature);
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) diff |= a[index] ^ b[index];
  return diff === 0;
}

/* ── session tokens ──────────────────────────────────────────────────────── */

export async function signSession(email: string, now = Date.now()): Promise<string> {
  const payload: Session = { email: email.trim().toLowerCase(), exp: now + SESSION_TTL_MS };
  const body = b64urlFromString(JSON.stringify(payload));
  const signature = b64urlFromBytes(await hmac(`v1.${body}`));
  return `v1.${body}.${signature}`;
}

/** Returns the session only for a well-formed, unexpired, admin-owned token. */
export async function verifySessionToken(token: string | undefined | null): Promise<Session | null> {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return null;
  try {
    const expected = await hmac(`v1.${parts[1]}`);
    if (!timingSafeEqual(expected, bytesFromB64url(parts[2]))) return null;
    const payload = JSON.parse(stringFromB64url(parts[1])) as Partial<Session>;
    if (typeof payload.email !== "string" || typeof payload.exp !== "number") return null;
    if (payload.exp <= Date.now()) return null;
    if (!isAdminEmail(payload.email)) return null;
    return { email: payload.email.trim().toLowerCase(), exp: payload.exp };
  } catch {
    return null;
  }
}

/** Shape-compatible with NextRequest: works in the proxy and route handlers. */
export async function sessionFromRequest(request: {
  cookies: { get(name: string): { value: string } | undefined };
}): Promise<Session | null> {
  return verifySessionToken(request.cookies.get(SESSION_COOKIE)?.value);
}

/* ── password sign-in ────────────────────────────────────────────────────── */

export interface LoginOutcome {
  ok: boolean;
  email?: string;
  error?: string;
}

/**
 * Verify a password against Supabase's password grant for one allowlisted
 * account, enforcing that account's per-IP failure budget. Every layer that
 * can reject does so without contacting Supabase when it already knows better.
 */
async function verifyPassword(
  ip: string,
  email: string,
  password: string,
): Promise<LoginOutcome> {
  const budgetKey = `login:${ip}:${email}`;
  if (!withinFailureBudget(budgetKey, LOGIN_FAILURE_LIMIT, LOGIN_FAILURE_WINDOW_MS)) {
    return { ok: false, error: "rate_limited" };
  }

  let endpoint: string;
  let headers: Record<string, string>;
  try {
    endpoint = `${supabaseUrl()}/auth/v1/token?grant_type=password`;
    headers = {
      apikey: supabaseServiceKey(),
      "content-type": "application/json",
    };
  } catch {
    return { ok: false, error: "not_configured" };
  }

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({ email, password }),
      signal: AbortSignal.timeout(15_000),
    });
    const data = (await response.json().catch(() => null)) as
      | {
          user?: { email?: string; email_confirmed_at?: string };
          error_code?: string;
          msg?: string;
        }
      | null;
    if (!response.ok) {
      noteFailure(budgetKey);
      return { ok: false, error: mapPasswordError(data, response.status) };
    }
    const verified = data?.user?.email?.trim().toLowerCase();
    if (!verified || !isAdminEmail(verified)) {
      // Supabase accepted a password for a non-admin account — still deny.
      noteFailure(budgetKey);
      return { ok: false, error: "access_denied" };
    }
    clearFailures(budgetKey);
    return { ok: true, email: verified };
  } catch {
    noteFailure(budgetKey);
    return { ok: false, error: "network" };
  }
}

/**
 * Sign in with a password, optionally naming the account. Named, the address
 * is checked against the allowlist first and exactly one account is tried.
 * Unnamed — the shape the sign-in screen submits — the password is offered to
 * every allowlisted admin until one accepts it, so the operator never has to
 * remember which address owns which password. A session is minted for
 * whichever account matched, and each candidate keeps its own failure budget
 * so a typo cannot be laundered across accounts.
 */
export async function attemptLogin(
  ip: string,
  email: string | null | undefined,
  password: string,
): Promise<LoginOutcome> {
  const normalized = email?.trim().toLowerCase() ?? "";
  if (!password) return { ok: false, error: "invalid_credentials" };
  if (normalized && !isAdminEmail(normalized)) {
    return { ok: false, error: "access_denied" };
  }

  const candidates = normalized ? [normalized] : adminEmails();
  /** Rejections a later candidate cannot fix — report them immediately. */
  const fatal = new Set(["not_configured", "network"]);
  let sawRateLimit = false;
  let reported: string | undefined;
  for (const candidate of candidates) {
    const outcome = await verifyPassword(ip, candidate, password);
    if (outcome.ok) return outcome;
    const error = outcome.error ?? "invalid_credentials";
    if (fatal.has(error)) return { ok: false, error };
    if (error === "rate_limited") {
      sawRateLimit = true;
      continue;
    }
    reported ??= error;
  }
  return {
    ok: false,
    error: sawRateLimit ? "rate_limited" : (reported ?? "invalid_credentials"),
  };
}

function mapPasswordError(
  data: { error_code?: string; msg?: string } | null,
  status: number,
): string {
  const text = `${data?.error_code ?? ""} ${data?.msg ?? ""}`.toLowerCase();
  if (status === 429 || text.includes("rate limit")) return "rate_limited";
  if (text.includes("not confirmed")) return "unverified";
  if (status === 404) return "auth_disabled";
  return "invalid_credentials";
}

/* ── proxy access rules ──────────────────────────────────────────────────── */

/**
 * Everything not listed here needs a valid admin session in proxy.ts.
 * The cron and the tick routes keep their own credential checks — they are
 * called server-to-server without cookies.
 */
export function isPublicPath(pathname: string): boolean {
  if (pathname === "/login") return true;
  if (pathname.startsWith("/api/auth/")) return true;
  if (pathname === "/api/unsubscribe") return true; // lead-facing opt-out page/form
  if (pathname.startsWith("/api/cron/")) return true; // Bearer CRON_SECRET
  if (/^\/api\/tasks\/[^/]+\/email-tick$/.test(pathname)) return true; // x-task-token
  if (/^\/api\/runs\/[^/]+\/tick$/.test(pathname)) return true; // run token
  return false;
}
