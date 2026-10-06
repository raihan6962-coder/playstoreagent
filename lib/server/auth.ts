/**
 * Admin-only auth. Stateless HMAC-signed session cookies (verified with
 * WebCrypto only, so the edge proxy and Node route handlers share one
 * implementation) plus the Supabase PKCE pieces of the Google flow.
 *
 * The identity decision is made once, at the callback: Supabase Auth proves
 * the Google account, we then whitelist-check the email and mint our own
 * short-lived session. Nothing about the rest of the app talks to Supabase.
 */

export const SESSION_COOKIE = "psa_session";
export const PKCE_COOKIE = "psa_pkce";
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const PKCE_TTL_MS = 10 * 60 * 1000;

/** The only account that may sign in unless ADMIN_EMAILS overrides it. */
const DEFAULT_ADMIN_EMAIL = "revnexa0@gmail.com";

const encoder = new TextEncoder();

export interface Session {
  email: string;
  exp: number;
}

export interface PkceState {
  verifier: string;
  exp: number;
}

export function adminEmails(): string[] {
  const raw = process.env.ADMIN_EMAILS?.trim() ?? "";
  const list = raw
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  return list.length > 0 ? list : [DEFAULT_ADMIN_EMAIL];
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

/* ── PKCE helpers for the Google round-trip ──────────────────────────────── */

export interface PkceChallenge {
  verifier: string;
  challenge: string;
  exp: number;
}

export async function makePkce(now = Date.now()): Promise<PkceChallenge> {
  const verifier = b64urlFromBytes(crypto.getRandomValues(new Uint8Array(48)));
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(verifier));
  return { verifier, challenge: b64urlFromBytes(new Uint8Array(digest)), exp: now + PKCE_TTL_MS };
}

export function parsePkce(value: string | undefined | null, now = Date.now()): PkceState | null {
  if (!value) return null;
  try {
    const state = JSON.parse(value) as Partial<PkceState>;
    if (typeof state.verifier !== "string" || state.verifier.length < 32) return null;
    if (typeof state.exp !== "number" || state.exp <= now) return null;
    return { verifier: state.verifier, exp: state.exp };
  } catch {
    return null;
  }
}

/** Supabase's browser entry point — no API key in the URL, by design. */
export function buildAuthorizeUrl(origin: string, challenge: string): string {
  const url = new URL(`${supabaseUrl()}/auth/v1/authorize`);
  url.searchParams.set("provider", "google");
  url.searchParams.set("redirect_to", `${origin}/auth/callback`);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "s256");
  return url.toString();
}

export interface ExchangeResult {
  ok: boolean;
  email?: string;
  emailVerified?: boolean;
  error?: string;
}

/**
 * Swap the callback code for a Supabase session. Primary: the current
 * `grant_type=pkce` contract (what supabase-js sends); fallback: the older
 * `authorization_code` shape, in case the project still runs an older GoTrue.
 */
export async function exchangeAuthCode(
  origin: string,
  code: string,
  verifier: string,
): Promise<ExchangeResult> {
  let endpoint: string;
  let headers: Record<string, string>;
  try {
    endpoint = `${supabaseUrl()}/auth/v1/token`;
    headers = {
      apikey: supabaseServiceKey(),
      "content-type": "application/json",
    };
  } catch {
    return { ok: false, error: "not_configured" };
  }
  const redirectUri = `${origin}/auth/callback`;

  const attempts: { grant: string; body: Record<string, string> }[] = [
    { grant: "pkce", body: { auth_code: code, code_verifier: verifier } },
    {
      grant: "authorization_code",
      body: { auth_code: code, code_verifier: verifier, redirect_uri: redirectUri },
    },
  ];

  let lastError = "exchange_failed";
  for (const attempt of attempts) {
    try {
      const response = await fetch(`${endpoint}?grant_type=${attempt.grant}`, {
        method: "POST",
        headers,
        body: JSON.stringify(attempt.body),
        signal: AbortSignal.timeout(15_000),
      });
      const data = (await response.json().catch(() => null)) as
        | {
            user?: { email?: string; email_verified?: boolean };
            session?: { user?: { email?: string; email_verified?: boolean } };
            error_code?: string;
            error_description?: string;
            msg?: string;
          }
        | null;
      if (!response.ok) {
        lastError = mapSupabaseError(data, response.status);
        continue;
      }
      const user = data?.user ?? data?.session?.user;
      const email = user?.email?.trim().toLowerCase();
      if (!email) return { ok: false, error: "no_email" };
      return { ok: true, email, emailVerified: user?.email_verified !== false };
    } catch {
      lastError = "exchange_timeout";
    }
  }
  return { ok: false, error: lastError };
}

function mapSupabaseError(
  data: { error_code?: string; error_description?: string; msg?: string } | null,
  status: number,
): string {
  const text = `${data?.error_code ?? ""} ${data?.error_description ?? ""} ${data?.msg ?? ""}`.toLowerCase();
  if (text.includes("redirect")) return "redirect_mismatch";
  if (text.includes("code verifier") || text.includes("code_verifier")) return "pkce_mismatch";
  if (text.includes("expired")) return "code_expired";
  if (status === 404) return "auth_disabled";
  return "exchange_failed";
}

/* ── proxy access rules ──────────────────────────────────────────────────── */

/**
 * Everything not listed here needs a valid admin session in proxy.ts.
 * The cron and the tick routes keep their own credential checks — they are
 * called server-to-server without cookies.
 */
export function isPublicPath(pathname: string): boolean {
  if (pathname === "/login") return true;
  if (pathname.startsWith("/auth/")) return true;
  if (pathname.startsWith("/api/auth/")) return true;
  if (pathname === "/api/unsubscribe") return true; // lead-facing opt-out page/form
  if (pathname.startsWith("/api/cron/")) return true; // Bearer CRON_SECRET
  if (/^\/api\/tasks\/[^/]+\/email-tick$/.test(pathname)) return true; // x-task-token
  if (/^\/api\/runs\/[^/]+\/tick$/.test(pathname)) return true; // run token
  return false;
}
