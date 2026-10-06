import { NextResponse, type NextRequest } from "next/server";
import { isPublicPath, sessionFromRequest } from "@/lib/server/auth";

/**
 * Optimistic gate: pages and APIs need a valid admin session, while the
 * login flow, the lead-facing unsubscribe page and the token-authenticated
 * server-to-server routes stay open. Route handlers re-check where it
 * matters — this file only decides redirects early and cheaply.
 */
export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (isPublicPath(pathname)) return NextResponse.next();

  const session = await sessionFromRequest(request);
  if (session) return NextResponse.next();

  if (pathname.startsWith("/api/") || pathname.startsWith("/auth/")) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }
  return NextResponse.redirect(new URL("/login", request.url));
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
