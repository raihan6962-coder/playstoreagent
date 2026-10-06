import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  adminEmails,
  attemptLogin,
  isAdminEmail,
  isPublicPath,
  LOGIN_FAILURE_LIMIT,
  signSession,
  verifySessionToken,
} from "@/lib/server/auth";

beforeEach(() => {
  process.env.AUTH_SECRET = "test-secret";
  process.env.SUPABASE_URL = "https://test-project.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";
  delete process.env.ADMIN_EMAILS;
  // Isolate the per-IP+email failure budget between tests.
  vi.useFakeTimers();
  vi.setSystemTime(Date.parse("2026-01-01T00:00:00Z"));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  delete process.env.ADMIN_EMAILS;
});

describe("admin allowlist", () => {
  it("accepts the one admin account, case-insensitively", () => {
    expect(isAdminEmail("revnexa0@gmail.com")).toBe(true);
    expect(isAdminEmail("  Revnexa0@Gmail.Com  ")).toBe(true);
    expect(isAdminEmail("someone.else@gmail.com")).toBe(false);
    expect(isAdminEmail("revnexa0@gmail.com.evil.com")).toBe(false);
    expect(isAdminEmail("")).toBe(false);
    expect(isAdminEmail(null)).toBe(false);
  });

  it("lets ADMIN_EMAILS extend or replace the allowlist", () => {
    process.env.ADMIN_EMAILS = " first@example.com, SECOND@example.com ";
    expect(adminEmails()).toEqual(["first@example.com", "second@example.com"]);
    expect(isAdminEmail("first@example.com")).toBe(true);
    // Replacing the list is intentional: env wins over the baked default.
    expect(isAdminEmail("revnexa0@gmail.com")).toBe(false);
    delete process.env.ADMIN_EMAILS;
    expect(isAdminEmail("revnexa0@gmail.com")).toBe(true);
  });
});

describe("session tokens", () => {
  it("round-trips a valid admin session", async () => {
    const token = await signSession("revnexa0@gmail.com");
    const session = await verifySessionToken(token);
    expect(session?.email).toBe("revnexa0@gmail.com");
    expect(session!.exp).toBeGreaterThan(Date.now());
  });

  it("rejects tampered, foreign and malformed tokens", async () => {
    const token = await signSession("revnexa0@gmail.com");
    const [version, body, signature] = token.split(".");
    const forgedBody = Buffer.from(
      JSON.stringify({ email: "revnexa0@gmail.com", exp: Date.now() + 60_000 }),
    ).toString("base64url");
    expect(await verifySessionToken(`${version}.${forgedBody}.${signature}`)).toBeNull();
    expect(await verifySessionToken(`${version}.${body}.${signature.slice(0, -2)}xx`)).toBeNull();
    expect(await verifySessionToken("v2.deadbeef.deadbeef")).toBeNull();
    expect(await verifySessionToken("not-a-token")).toBeNull();
    expect(await verifySessionToken("")).toBeNull();
    expect(await verifySessionToken(undefined)).toBeNull();
    expect(await verifySessionToken("v1.!!!invalid!!!.zzzz")).toBeNull();
  });

  it("never honours a token signed for a non-admin address", async () => {
    const token = await signSession("intruder@example.com");
    expect(await verifySessionToken(token)).toBeNull();
  });

  it("expires sessions after the TTL", async () => {
    const token = await signSession("revnexa0@gmail.com");
    expect(await verifySessionToken(token)).not.toBeNull();
    vi.setSystemTime(Date.parse("2026-01-08T00:00:00Z"));
    expect(await verifySessionToken(token)).toBeNull();
  });

  it("fails closed when the signing secret disappears", async () => {
    const token = await signSession("revnexa0@gmail.com");
    delete process.env.AUTH_SECRET;
    expect(await verifySessionToken(token)).toBeNull();
    await expect(signSession("revnexa0@gmail.com")).rejects.toThrow("AUTH_SECRET");
  });

  it("rejects tokens signed under a different secret", async () => {
    const token = await signSession("revnexa0@gmail.com");
    process.env.AUTH_SECRET = "rotated-secret";
    expect(await verifySessionToken(token)).toBeNull();
  });
});

describe("password sign-in", () => {
  function stubFetch(responses: Response[]): { calls: { url: string; init?: RequestInit }[] } {
    const calls: { url: string; init?: RequestInit }[] = [];
    let index = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ url: String(input), init });
        const next = responses[Math.min(index, responses.length - 1)];
        index += 1;
        return next;
      }),
    );
    return { calls };
  }

  it("accepts the admin password and returns the verified email", async () => {
    const { calls } = stubFetch([
      Response.json({ user: { email: "revnexa0@gmail.com", email_confirmed_at: "2026-01-01" } }),
    ]);
    const outcome = await attemptLogin("10.0.0.1", "  Revnexa0@Gmail.com ", "hunter2hunter2");
    expect(outcome).toEqual({ ok: true, email: "revnexa0@gmail.com" });
    expect(calls[0].url).toBe("https://test-project.supabase.co/auth/v1/token?grant_type=password");
    const body = JSON.parse(String(calls[0].init?.body)) as Record<string, string>;
    expect(body.email).toBe("revnexa0@gmail.com");
    expect(body.password).toBe("hunter2hunter2");
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers.apikey).toBe("service-role-key");
  });

  it("never contacts Supabase for a non-admin address", async () => {
    const { calls } = stubFetch([]);
    const outcome = await attemptLogin("10.0.0.1", "stranger@example.com", "anything123");
    expect(outcome).toEqual({ ok: false, error: "access_denied" });
    expect(calls).toHaveLength(0);
  });

  it("rejects empty submissions without a network call", async () => {
    const { calls } = stubFetch([]);
    expect(await attemptLogin("10.0.0.1", "", "pw")).toEqual({
      ok: false,
      error: "invalid_credentials",
    });
    expect(await attemptLogin("10.0.0.1", "revnexa0@gmail.com", "")).toEqual({
      ok: false,
      error: "invalid_credentials",
    });
    expect(calls).toHaveLength(0);
  });

  it("maps Supabase's wrong-password rejection", async () => {
    stubFetch([
      Response.json({ code: 400, error_code: "invalid_credentials", msg: "Invalid login credentials" }, { status: 400 }),
    ]);
    const outcome = await attemptLogin("10.0.0.4", "revnexa0@gmail.com", "wrong-password");
    expect(outcome).toEqual({ ok: false, error: "invalid_credentials" });
  });

  it("turns a password for a non-allowlisted account into a denial", async () => {
    process.env.ADMIN_EMAILS = "revnexa0@gmail.com";
    stubFetch([
      Response.json({ user: { email: "someone.else@gmail.com" } }),
    ]);
    const outcome = await attemptLogin("10.0.0.5", "revnexa0@gmail.com", "pw");
    expect(outcome).toEqual({ ok: false, error: "access_denied" });
  });

  it("locks out after the failure budget and reopens on a fresh window", async () => {
    stubFetch([
      Response.json({ error_code: "invalid_credentials", msg: "Invalid login credentials" }, { status: 400 }),
    ]);
    for (let attempt = 0; attempt < LOGIN_FAILURE_LIMIT; attempt += 1) {
      const outcome = await attemptLogin("10.0.0.6", "revnexa0@gmail.com", "nope");
      expect(outcome.error).toBe("invalid_credentials");
    }
    const locked = await attemptLogin("10.0.0.6", "revnexa0@gmail.com", "nope");
    expect(locked).toEqual({ ok: false, error: "rate_limited" });

    // A different email on the same IP still has its own budget.
    process.env.ADMIN_EMAILS = "revnexa0@gmail.com,other@example.com";
    const otherEmail = await attemptLogin("10.0.0.6", "other@example.com", "nope");
    expect(otherEmail.error).toBe("invalid_credentials");

    // The window rolls over.
    vi.setSystemTime(Date.parse("2026-01-01T00:16:00Z"));
    const reopened = await attemptLogin("10.0.0.6", "revnexa0@gmail.com", "nope");
    expect(reopened.error).toBe("invalid_credentials");
  });

  it("clears the budget after a successful sign-in", async () => {
    const wrong = () =>
      Response.json({ error_code: "invalid_credentials", msg: "Invalid login credentials" }, { status: 400 });
    // Sequence matters: four failures, then the good password, then more failures.
    stubFetch([wrong(), wrong(), wrong(), wrong(), Response.json({ user: { email: "revnexa0@gmail.com" } }), wrong()]);
    // Four failures — one short of the limit.
    for (let attempt = 0; attempt < LOGIN_FAILURE_LIMIT - 1; attempt += 1) {
      await attemptLogin("10.0.0.7", "revnexa0@gmail.com", "nope");
    }
    const ok = await attemptLogin("10.0.0.7", "revnexa0@gmail.com", "right");
    expect(ok.ok).toBe(true);
    // Without a reset the very next failure would trip the lockout (4+1=5);
    // with it, four more failures still fit inside the fresh budget.
    for (let attempt = 0; attempt < LOGIN_FAILURE_LIMIT - 1; attempt += 1) {
      const again = await attemptLogin("10.0.0.7", "revnexa0@gmail.com", "nope");
      expect(again.error).toBe("invalid_credentials");
    }
  });

  it("reports a missing Supabase environment", async () => {
    delete process.env.SUPABASE_URL;
    const outcome = await attemptLogin("10.0.0.8", "revnexa0@gmail.com", "pw");
    expect(outcome).toEqual({ ok: false, error: "not_configured" });
  });

  it("classifies network failure and Supabase rate limits", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    expect(await attemptLogin("10.0.0.9", "revnexa0@gmail.com", "pw")).toEqual({
      ok: false,
      error: "network",
    });

    stubFetch([
      Response.json({ error_code: "over_request_rate_limit", msg: "Request rate limit reached" }, { status: 429 }),
    ]);
    expect(await attemptLogin("10.0.0.2", "revnexa0@gmail.com", "pw")).toEqual({
      ok: false,
      error: "rate_limited",
    });
  });
});

describe("proxy access rules", () => {
  it("keeps the login flow, leads' opt-out and credentialed server routes public", () => {
    expect(isPublicPath("/login")).toBe(true);
    expect(isPublicPath("/api/auth/login")).toBe(true);
    expect(isPublicPath("/api/auth/logout")).toBe(true);
    expect(isPublicPath("/api/auth/me")).toBe(true);
    expect(isPublicPath("/api/unsubscribe")).toBe(true);
    expect(isPublicPath("/api/cron/sweep")).toBe(true);
    expect(isPublicPath("/api/tasks/abc/email-tick")).toBe(true);
    expect(isPublicPath("/api/runs/abc/tick")).toBe(true);
  });

  it("locks everything else behind the admin session", () => {
    expect(isPublicPath("/")).toBe(false);
    expect(isPublicPath("/inbox")).toBe(false);
    expect(isPublicPath("/spam-check")).toBe(false);
    expect(isPublicPath("/auth/callback")).toBe(false); // Google flow is gone
    expect(isPublicPath("/api/unsubscribes")).toBe(false); // plural = management API
    expect(isPublicPath("/api/replies")).toBe(false);
    expect(isPublicPath("/api/tasks")).toBe(false);
    expect(isPublicPath("/api/tasks/start-due")).toBe(false);
    expect(isPublicPath("/api/email-settings")).toBe(false);
    expect(isPublicPath("/api/spam-check")).toBe(false);
    expect(isPublicPath("/api/generate")).toBe(false);
  });
});
