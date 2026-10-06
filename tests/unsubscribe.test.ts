import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildFooterHtml,
  buildPlainFooter,
  decodeRecipient,
  defaultFooter,
  encodeRecipient,
  getFooterSettings,
  plainToHtml,
  saveFooterSettings,
  siteOrigin,
  unsubscribeUrl,
  validateFooter,
} from "@/lib/server/emailFooter";
import {
  addUnsubscribe,
  isUnsubscribed,
  listUnsubscribes,
  removeUnsubscribe,
} from "@/lib/server/unsubscribes";
import { installGitHubMock } from "./helpers/githubMock";

describe("unsubscribe list", () => {
  beforeEach(() => {
    process.env.PSA_STATE_REPO = "owner/state-repo";
    process.env.GITHUB_TOKEN = "test-token";
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    installGitHubMock();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("adds, checks, lists and removes addresses (idempotently)", async () => {
    expect(await isUnsubscribed("Ada@Example.com")).toBe(false);

    expect(await addUnsubscribe("Ada@Example.com")).toBe(true);
    expect(await addUnsubscribe("ada@example.com")).toBe(false); // already present, deduped
    expect(await isUnsubscribed("ada@example.com")).toBe(true);

    const entries = await listUnsubscribes();
    expect(entries).toHaveLength(1);
    expect(entries[0].email).toBe("ada@example.com");
    expect(entries[0].source).toBe("footer-link");

    expect(await removeUnsubscribe("ADA@EXAMPLE.COM")).toBe(true);
    expect(await removeUnsubscribe("ada@example.com")).toBe(false);
    expect(await listUnsubscribes()).toEqual([]);
  });

  it("rejects unusable addresses", async () => {
    expect(await addUnsubscribe("not-an-email")).toBe(false);
    expect(await addUnsubscribe("")).toBe(false);
    expect(await removeUnsubscribe("nope")).toBe(false);
    expect(await isUnsubscribed("nope")).toBe(false);
  });
});

describe("email footer", () => {
  beforeEach(() => {
    process.env.PSA_STATE_REPO = "owner/state-repo";
    process.env.GITHUB_TOKEN = "test-token";
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.SITE_URL;
    installGitHubMock();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.SITE_URL;
  });

  it("encodes and decodes recipient tokens round-trip", () => {
    const token = encodeRecipient("Ada@Example.com");
    expect(token).not.toContain("@");
    expect(decodeRecipient(token)).toBe("ada@example.com");
    expect(decodeRecipient("!!!not-base64!!!")).toBeNull();
    expect(decodeRecipient(Buffer.from("plain-text", "utf8").toString("base64url"))).toBeNull();
  });

  it("builds a plain-text footer with the note and the link", () => {
    const url = "https://example.com/api/unsubscribe?to=abc";
    const text = buildPlainFooter("Because you rock.", url);
    expect(text).toContain("Because you rock.");
    expect(text).toContain(url);
    expect(text).toContain("Unsubscribe:");
    expect(text.startsWith("\n\n")).toBe(true);
  });

  it("builds an HTML footer with a real button and escapes the link", () => {
    const url = "https://example.com/api/unsubscribe?to=a&b=1";
    const html = buildFooterHtml('Say "hi" <now>', url);
    expect(html).toContain("Unsubscribe</a>");
    expect(html).toContain("#10b981");
    expect(html).toContain("a&amp;b=1");
    expect(html).not.toContain('Say "hi" <now>');
    expect(html).toContain("Say &quot;hi&quot; &lt;now&gt;");
  });

  it("renders plain bodies to safe HTML paragraphs", () => {
    const html = plainToHtml("Hello <script>alert(1)</script>\nSecond line\n\nNew para");
    expect(html).toContain("<p");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).toContain("<br>Second line");
  });

  it("prefers SITE_URL for link targets, falls back to the canonical host", () => {
    expect(siteOrigin()).toBe("https://playstoreagent.vercel.app");
    expect(unsubscribeUrl("a@b.co")).toContain("https://playstoreagent.vercel.app/api/unsubscribe?to=");

    process.env.SITE_URL = "http://localhost:3000";
    expect(siteOrigin()).toBe("http://localhost:3000");
    process.env.SITE_URL = "not a url";
    expect(siteOrigin()).toBe("https://playstoreagent.vercel.app");
  });

  it("validates and persists footer settings", async () => {
    expect(validateFooter(null).ok).toBe(false);
    expect(validateFooter({ enabled: "yes" }).ok).toBe(false);
    expect(validateFooter({ note: 42 }).ok).toBe(false);
    expect(validateFooter({ note: "x".repeat(401) }).ok).toBe(false);

    const parsed = validateFooter({ enabled: false, note: "  Only this.  " });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const saved = await saveFooterSettings(parsed.value);
    expect(saved.enabled).toBe(false);
    expect(saved.note).toBe("Only this.");
    expect((await getFooterSettings()).enabled).toBe(false);

    // Nothing stored yet → the defaults still come back.
    const fresh = await getFooterSettings();
    expect(defaultFooter().enabled).toBe(true);
    expect(typeof fresh.note).toBe("string");
  });
});
