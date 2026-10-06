import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { allowRequest, clientIp } from "@/lib/server/rateLimit";
import {
  exchangeAuthCode,
  isAdminEmail,
  parsePkce,
  PKCE_COOKIE,
  SESSION_COOKIE,
  signSession,
} from "@/lib/server/auth";

export const maxDuration = 20;

function toLogin(request: Request, error: string, email?: string): NextResponse {
  const url = new URL("/login", request.url);
  url.searchParams.set("error", error);
  if (email) url.searchParams.set("email", email);
  return NextResponse.redirect(url, 307);
}

/**
 * Step 2: Google redirected back through Supabase with ?code=… (or an
 * error). We exchange the code, whitelist-check the email, mint our own
 * session cookie and drop the user on the dashboard.
 */
export async function GET(request: Request): Promise<Response> {
  if (!allowRequest(clientIp(request))) {
    return toLogin(request, "rate_limited");
  }
  const url = new URL(request.url);
  const providerError = url.searchParams.get("error") ?? url.searchParams.get("error_code");
  if (providerError) {
    const detail = url.searchParams.get("error_description") ?? "";
    const mapped = detail.toLowerCase().includes("redirect") ? "redirect_mismatch" : "provider_error";
    return toLogin(request, mapped);
  }

  const code = url.searchParams.get("code");
  if (!code) return toLogin(request, "missing_code");

  const store = await cookies();
  const pkce = parsePkce(store.get(PKCE_COOKIE)?.value);
  if (!pkce) return toLogin(request, "expired");

  let result: Awaited<ReturnType<typeof exchangeAuthCode>>;
  try {
    result = await exchangeAuthCode(url.origin, code, pkce.verifier);
  } catch (error) {
    console.error("auth code exchange threw", error);
    result = { ok: false, error: "exchange_failed" };
  }
  if (!result.ok || !result.email) {
    console.error("auth code exchange failed", result.error);
    return toLogin(request, result.error ?? "exchange_failed");
  }
  if (!result.emailVerified) return toLogin(request, "unverified", result.email);
  if (!isAdminEmail(result.email)) {
    // The account proved who it is — it just isn't on the allowlist.
    return toLogin(request, "access_denied", result.email);
  }

  const session = await signSession(result.email);
  store.delete(PKCE_COOKIE);
  store.set(SESSION_COOKIE, session, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 7 * 24 * 60 * 60,
  });
  return NextResponse.redirect(new URL("/", request.url), 307);
}
