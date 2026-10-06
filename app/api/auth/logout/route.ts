import { cookies } from "next/headers";
import { SESSION_COOKIE } from "@/lib/server/auth";

export const maxDuration = 10;

/** Clear the session cookie — the client then bounces to /login. */
export async function POST(): Promise<Response> {
  const store = await cookies();
  store.delete(SESSION_COOKIE);
  return Response.json({ ok: true });
}
