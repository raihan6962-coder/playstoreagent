import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  adminEmails,
  buildAuthorizeUrl,
  exchangeAuthCode,
  isAdminEmail,
  isPublicPath,
  makePkce,
  parsePkce,
  SESSION_TTL_MS,
  signSession,
  verifySessionToken,
} from "@/lib/server/auth";

beforeEach(() => {
  process.env.AUTH_SECRET = "test-secret";
  process.env.SUPABASE_URL = "https://test-project.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";
  delete process.env.ADMIN_EMAILS;
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
    const forgedBody = Buffer.from(JSON.stringify({ email: "revnexa0@gmail.com", exp: Date.now() + 60_000 })).toString("base64url");
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
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse("2026-01-01T00:00:00Z"));
    const token = await signSession("revnexa0@gmail.com");
    expect(await verifySessionToken(token)).not.toBeNull();
    vi.setSystemTime(Date.parse("2026-01-01T00:00:00Z") + SESSION_TTL_MS + 1_000);
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

describe("PKCE state", () => {
  it("builds a verifiable challenge and round-trips the cookie value", async () => {
    const pkce = await makePkce();
    expect(pkce.verifier.length).toBeGreaterThanOrEqual(40);
    expect(pkce.challenge).not.toContain("=");
    const parsed = parsePkce(JSON.stringify({ verifier: pkce.verifier, exp: pkce.exp }));
    expect(parsed?.verifier).toBe(pkce.verifier);
  });

  it("rejects expired, short or garbage state", () => {
    expect(parsePkce(null)).toBeNull();
    expect(parsePkce("")).toBeNull();
    expect(parsePkce("not json")).toBeNull();
    expect(parsePkce(JSON.stringify({ verifier: "short", exp: Date.now() + 60_000 }))).toBeNull();
    expect(
      parsePkce(JSON.stringify({ verifier: "x".repeat(48), exp: Date.now() - 1 })),
    ).toBeNull();
  });

  it("builds the Supabase authorize URL", () => {
    const url = new URL(buildAuthorizeUrl("http://localhost:3000", "challenge-value"));
    expect(url.origin + url.pathname).toBe("https://test-project.supabase.co/auth/v1/authorize");
    expect(url.searchParams.get("provider")).toBe("google");
    expect(url.searchParams.get("redirect_to")).toBe("http://localhost:3000/auth/callback");
    expect(url.searchParams.get("code_challenge")).toBe("challenge-value");
    expect(url.searchParams.get("code_challenge_method")).toBe("s256");
    // The service key must never leak into a URL.
    expect(url.toString()).not.toContain("service-role-key");
  });
});

describe("code exchange", () => {
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

  it("exchanges via grant_type=pkce and extracts the email", async () => {
    const { calls } = stubFetch([
      Response.json({ user: { email: "Admin@Gmail.com", email_verified: true } }),
    ]);
    const result = await exchangeAuthCode("http://localhost:3000", "auth-code", "verifier-1");
    expect(result).toEqual({ ok: true, email: "admin@gmail.com", emailVerified: true });
    expect(calls[0].url).toContain("grant_type=pkce");
    const body = JSON.parse(String(calls[0].init?.body)) as Record<string, string>;
    expect(body.auth_code).toBe("auth-code");
    expect(body.code_verifier).toBe("verifier-1");
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers.apikey).toBe("service-role-key");
  });

  it("falls back to the legacy authorization_code grant", async () => {
    const { calls } = stubFetch([
      Response.json({ error_code: "bad_code" }, { status: 400 }),
      Response.json({ user: { email: "admin@gmail.com", email_verified: true } }),
    ]);
    const result = await exchangeAuthCode("https://app.example.com", "auth-code", "verifier-1");
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[1].url).toContain("grant_type=authorization_code");
    const body = JSON.parse(String(calls[1].init?.body)) as Record<string, string>;
    expect(body.redirect_uri).toBe("https://app.example.com/auth/callback");
  });

  it("maps Supabase redirect complaints to a setup hint", async () => {
    stubFetch([
      Response.json({ error_code: "validation_failed", msg: "Invalid Redirect URL" }, { status: 400 }),
      Response.json({ error_code: "validation_failed", msg: "Invalid Redirect URL" }, { status: 400 }),
    ]);
    const result = await exchangeAuthCode("http://localhost:3000", "auth-code", "verifier-1");
    expect(result).toEqual({ ok: false, error: "redirect_mismatch" });
  });

  it("requires an email in the payload", async () => {
    stubFetch([Response.json({ access_token: "no-user-here" })]);
    const result = await exchangeAuthCode("http://localhost:3000", "auth-code", "verifier-1");
    expect(result).toEqual({ ok: false, error: "no_email" });
  });

  it("surfaces network failure as a timeout", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    const result = await exchangeAuthCode("http://localhost:3000", "auth-code", "verifier-1");
    expect(result).toEqual({ ok: false, error: "exchange_timeout" });
  });

  it("flags an auth endpoint that is not there", async () => {
    stubFetch([
      Response.json({ message: "Not found" }, { status: 404 }),
      Response.json({ message: "Not found" }, { status: 404 }),
    ]);
    const result = await exchangeAuthCode("http://localhost:3000", "auth-code", "verifier-1");
    expect(result).toEqual({ ok: false, error: "auth_disabled" });
  });
});

describe("proxy access rules", () => {
  it("keeps the login flow, leads' opt-out and credentialed server routes public", () => {
    expect(isPublicPath("/login")).toBe(true);
    expect(isPublicPath("/auth/callback")).toBe(true);
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
    expect(isPublicPath("/api/unsubscribes")).toBe(false); // plural = management API
    expect(isPublicPath("/api/replies")).toBe(false);
    expect(isPublicPath("/api/tasks")).toBe(false);
    expect(isPublicPath("/api/tasks/start-due")).toBe(false);
    expect(isPublicPath("/api/email-settings")).toBe(false);
    expect(isPublicPath("/api/spam-check")).toBe(false);
    expect(isPublicPath("/api/generate")).toBe(false);
  });
});
