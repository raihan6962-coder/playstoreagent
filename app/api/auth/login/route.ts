import { NextResponse } from "next/server";
import {
  attemptLogin,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  signSession,
} from "@/lib/server/auth";
import { clientIp } from "@/lib/server/rateLimit";

export const maxDuration = 15;

/**
 * Verify email+password against Supabase, then mint our own HMAC session
 * cookie. The allowlist and the failure budget are enforced server-side
 * in attemptLogin — this route only shapes the HTTP contract.
 */
export async function POST(request: Request): Promise<Response> {
  let body: { email?: unknown; password?: unknown };
  try {
    body = (await request.json()) as { email?: unknown; password?: unknown };
  } catch {
    return NextResponse.json({ error: "invalid_credentials" }, { status: 400 });
  }
  const email = typeof body.email === "string" ? body.email : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (!email || !password) {
    return NextResponse.json({ error: "invalid_credentials" }, { status: 400 });
  }

  const outcome = await attemptLogin(clientIp(request), email, password);
  if (!outcome.ok || !outcome.email) {
    const status = outcome.error === "rate_limited" ? 429 : 401;
    return NextResponse.json({ error: outcome.error ?? "invalid_credentials" }, { status });
  }

  let token: string;
  try {
    token = await signSession(outcome.email);
  } catch (error) {
    console.error("session signing failed", error);
    return NextResponse.json({ error: "not_configured" }, { status: 503 });
  }

  const response = NextResponse.json({ ok: true, email: outcome.email });
  response.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  });
  return response;
}
