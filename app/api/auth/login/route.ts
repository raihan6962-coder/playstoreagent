import { NextResponse } from "next/server";
import { buildAuthorizeUrl, makePkce, PKCE_COOKIE, PKCE_TTL_MS } from "@/lib/server/auth";

export const maxDuration = 15;

/**
 * Step 1 of sign-in: mint a PKCE verifier (HttpOnly cookie) and send the
 * browser to Supabase, which in turn sends it to Google. No API key ever
 * appears in a URL — Supabase's /authorize is a public entry point.
 */
export async function GET(request: Request): Promise<Response> {
  const origin = new URL(request.url).origin;
  try {
    const pkce = await makePkce();
    const url = buildAuthorizeUrl(origin, pkce.challenge);
    const response = NextResponse.redirect(url, 307);
    response.cookies.set(PKCE_COOKIE, JSON.stringify({ verifier: pkce.verifier, exp: pkce.exp }), {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: Math.floor(PKCE_TTL_MS / 1000),
    });
    return response;
  } catch (error) {
    console.error("auth login redirect failed", error);
    return NextResponse.redirect(new URL("/login?error=not_configured", request.url), 307);
  }
}
