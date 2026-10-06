import { cookies } from "next/headers";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/server/auth";

export const maxDuration = 10;

/** Who am I? 200 with the admin email, or 401 — drives the menu chip. */
export async function GET(): Promise<Response> {
  const store = await cookies();
  const session = await verifySessionToken(store.get(SESSION_COOKIE)?.value);
  if (!session) return Response.json({ error: "Unauthorized." }, { status: 401 });
  return Response.json(
    { ok: true, email: session.email },
    { headers: { "Cache-Control": "no-store" } },
  );
}
