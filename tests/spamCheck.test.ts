import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addMailbox, listMailboxes } from "@/lib/server/mailboxes";
import {
  SpamCheckError,
  classifyMatches,
  getSpamCheckConfig,
  getSpamHistory,
  maskCheckerUrl,
  runCheck,
  saveSpamConfig,
  sendDemo,
  validateSpamConfig,
  validateSpamSend,
} from "@/lib/server/spamCheck";
import { installGitHubMock, storedJson, type GitHubMock } from "./helpers/githubMock";

/** Sender mailbox's Apps Script — where demo sends go. */
const SENDER_URL = "https://script.google.com/macros/s/sender/exec";
/** Checker account's Apps Script — where placement queries go. */
const CHECKER_URL = "https://script.google.com/macros/s/checker/exec";
/** Keep in sync with SPAM_CHECK_PATH in lib/server/spamCheck.ts. */
const SPAM_CHECK_PATH = "config/spam-check.json";

let appsResponse: () => Response = () => Response.json({ ok: true });
let checkerResponse: () => Response = () => Response.json({ ok: true, matches: [] });
/** Bodies actually POSTed to the sender mailbox's Apps Script. */
let senderPosts: { to: string; subject: string; body: string }[] = [];

/**
 * Route fetch: the checker URL is checked first (it is also a
 * script.google.com URL), sender posts are captured for assertions, and
 * everything else (GitHub contents API) goes to the store mock.
 */
function stubRouter(mock: GitHubMock): void {
  senderPosts = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === CHECKER_URL) return checkerResponse();
      if (url === SENDER_URL) {
        senderPosts.push(JSON.parse(String(init?.body)) as (typeof senderPosts)[number]);
        return appsResponse();
      }
      if (url.startsWith("https://script.google.com/")) return appsResponse();
      return (mock.fetchMock as unknown as typeof fetch)(input, init);
    }),
  );
}

async function connectedMailbox(): Promise<string> {
  const mailbox = await addMailbox({ label: "sender", webAppUrl: SENDER_URL, dailyQuota: 500 });
  return mailbox.id;
}

function validSend(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    mailboxId: "box-1",
    to: "lead@example.com",
    subject: "About {{app}}",
    body: "Hi {{developer}}, reach {{email}}.",
    ...overrides,
  };
}

describe("spam check: validation", () => {
  let mock: GitHubMock;

  beforeEach(() => {
    process.env.PSA_STATE_REPO = "owner/state-repo";
    process.env.GITHUB_TOKEN = "test-token";
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    mock = installGitHubMock();
    appsResponse = () => Response.json({ ok: true });
    checkerResponse = () => Response.json({ ok: true, matches: [] });
    stubRouter(mock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rejects bad demo payloads with readable errors", () => {
    expect(validateSpamSend(null).ok).toBe(false);
    expect(validateSpamSend([]).ok).toBe(false);
    expect(validateSpamSend(validSend({ mailboxId: "" })).ok).toBe(false);
    expect(validateSpamSend(validSend({ to: "not-an-email" })).ok).toBe(false);
    expect(validateSpamSend(validSend({ subject: "  " })).ok).toBe(false);
    expect(validateSpamSend(validSend({ body: "" })).ok).toBe(false);
    expect(validateSpamSend(validSend({ body: "x".repeat(6_001) })).ok).toBe(false);

    const parsed = validateSpamSend(validSend({ to: "  lead@example.com  " }));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.to).toBe("lead@example.com");
  });

  it("rejects bad checker config and accepts subsets", () => {
    expect(validateSpamConfig("nope").ok).toBe(false);
    expect(validateSpamConfig({}).ok).toBe(false);
    expect(validateSpamConfig({ theme: "dark" }).ok).toBe(false);
    expect(validateSpamConfig({ checkerWebAppUrl: 42 }).ok).toBe(false);
    // http is only fine for loopback; path must end in /exec.
    expect(validateSpamConfig({ checkerWebAppUrl: "http://evil.example/exec" }).ok).toBe(false);
    expect(validateSpamConfig({ checkerWebAppUrl: "https://script.google.com/macros/s/x" }).ok).toBe(
      false,
    );
    expect(validateSpamConfig({ checkerWebAppUrl: "http://localhost:8787/exec" }).ok).toBe(true);
    expect(validateSpamConfig({ checkerWebAppUrl: "" }).ok).toBe(true);
    expect(validateSpamConfig({ subject: "x".repeat(201) }).ok).toBe(false);
    expect(validateSpamConfig({ body: "kept" }).ok).toBe(true);
  });

  it("classifies checker matches by their labels", () => {
    expect(classifyMatches([])).toBe("not-found");
    expect(classifyMatches([{ inbox: true, spam: false, labels: "INBOX" }])).toBe("inbox");
    expect(classifyMatches([{ inbox: false, spam: true, labels: "SPAM" }])).toBe("spam");
    // Archived-only messages are neither.
    expect(classifyMatches([{ inbox: false, spam: false, labels: "" }])).toBe("other");
    // Any clean Inbox hit wins over a separate spam hit.
    expect(
      classifyMatches([
        { inbox: true, spam: false, labels: "INBOX" },
        { inbox: false, spam: true, labels: "SPAM" },
      ]),
    ).toBe("inbox");
    // A single message flagged both ways cannot be trusted — report spam.
    expect(classifyMatches([{ inbox: true, spam: true, labels: "INBOX, SPAM" }])).toBe("spam");
  });

  it("masks the checker URL down to its origin", () => {
    expect(maskCheckerUrl(CHECKER_URL)).toBe("https://script.google.com/…/exec");
    expect(maskCheckerUrl("")).toBe("");
    expect(maskCheckerUrl("::::")).toBe("…/exec");
  });
});

describe("spam check: demo sends", () => {
  let mock: GitHubMock;

  beforeEach(() => {
    process.env.PSA_STATE_REPO = "owner/state-repo";
    process.env.GITHUB_TOKEN = "test-token";
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    mock = installGitHubMock();
    appsResponse = () => Response.json({ ok: true });
    checkerResponse = () => Response.json({ ok: true, matches: [] });
    stubRouter(mock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders the template, appends the reference token and records the send", async () => {
    const mailboxId = await connectedMailbox();
    const record = await sendDemo({
      mailboxId,
      to: "lead@example.com",
      subject: "About {{app}}",
      body: "Hi {{developer}}, reach {{email}} for {{keyword}}.",
    });

    expect(record.sendOk).toBe(true);
    expect(record.sendError).toBeNull();
    expect(record.marker).toMatch(/^PSAchk[0-9a-f]{16}$/);
    expect(record.subject).toBe("About Sample Demo App");
    expect(record.mailboxLabel).toBe("sender");

    // The delivered body carries the rendered template plus the reference.
    expect(senderPosts).toHaveLength(1);
    expect(senderPosts[0].to).toBe("lead@example.com");
    expect(senderPosts[0].subject).toBe("About Sample Demo App");
    expect(senderPosts[0].body).toContain("Hi Sample Studio, reach lead@example.com for demo.");
    expect(senderPosts[0].body).toContain(`[ref ${record.marker}]`);

    const state = storedJson(mock.files, SPAM_CHECK_PATH) as {
      history: typeof record[];
      subject: string;
      body: string;
    };
    expect(state.history).toHaveLength(1);
    expect(state.history[0].marker).toBe(record.marker);
    // The manual template survives a reload.
    expect(state.subject).toBe("About {{app}}");
    expect(state.body).toBe("Hi {{developer}}, reach {{email}} for {{keyword}}.");

    // Success counts against the mailbox's daily quota.
    expect((await listMailboxes())[0].sent.count).toBe(1);
  });

  it("records a failed send without spending quota", async () => {
    const mailboxId = await connectedMailbox();
    appsResponse = () => Response.json({ ok: false, error: "missing to" }, { status: 400 });

    const record = await sendDemo({
      mailboxId,
      to: "lead@example.com",
      subject: "Hello",
      body: "World",
    });

    expect(record.sendOk).toBe(false);
    expect(record.sendError).toBe("missing to");
    expect(await getSpamHistory()).toHaveLength(1);
    expect((await listMailboxes())[0].sent.count).toBe(0);
  });

  it("rejects an unknown mailbox", async () => {
    await expect(
      sendDemo({ mailboxId: "ghost", to: "a@b.co", subject: "x", body: "y" }),
    ).rejects.toBeInstanceOf(SpamCheckError);
  });

  it("trims history to the newest 20 demos", async () => {
    const mailboxId = await connectedMailbox();
    for (let index = 0; index < 21; index += 1) {
      await sendDemo({ mailboxId, to: `lead${index}@example.com`, subject: `S${index}`, body: "b" });
    }
    const history = await getSpamHistory();
    expect(history).toHaveLength(20);
    expect(history[0].subject).toBe("S20");
    expect(history[19].subject).toBe("S1");
  });
});

describe("spam check: placement queries", () => {
  let mock: GitHubMock;

  beforeEach(() => {
    process.env.PSA_STATE_REPO = "owner/state-repo";
    process.env.GITHUB_TOKEN = "test-token";
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    mock = installGitHubMock();
    appsResponse = () => Response.json({ ok: true });
    checkerResponse = () => Response.json({ ok: true, matches: [] });
    stubRouter(mock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function sentDemo(): Promise<{ id: string; marker: string }> {
    const mailboxId = await connectedMailbox();
    return sendDemo({ mailboxId, to: "lead@example.com", subject: "Hello", body: "World" });
  }

  it("classifies an Inbox hit and stamps the record", async () => {
    await saveSpamConfig({ checkerWebAppUrl: CHECKER_URL });
    const demo = await sentDemo();
    checkerResponse = () =>
      Response.json({
        ok: true,
        matches: [{ subject: "Hello", inbox: true, spam: false, labels: "INBOX" }],
      });

    const record = await runCheck(demo.id);
    expect(record.result).toBe("inbox");
    expect(record.detail).toContain("INBOX");
    expect(record.checkedAt).toBeGreaterThan(0);

    const [stored] = await getSpamHistory();
    expect(stored.result).toBe("inbox");

    // The query went to the checker with the demo's marker.
    const router = vi.mocked(globalThis.fetch as unknown as ReturnType<typeof vi.fn>);
    const call = router.mock.calls.find((entry) => String(entry[0]) === CHECKER_URL);
    expect(call).toBeDefined();
    const sent = JSON.parse(String((call![1] as RequestInit).body)) as {
      action: string;
      marker: string;
      minutes: number;
    };
    expect(sent.action).toBe("check");
    expect(sent.marker).toBe(demo.marker);
    expect(sent.minutes).toBeGreaterThanOrEqual(15);
  });

  it("reports Spam when the checker only finds it in SPAM", async () => {
    await saveSpamConfig({ checkerWebAppUrl: CHECKER_URL });
    const demo = await sentDemo();
    checkerResponse = () =>
      Response.json({
        ok: true,
        matches: [{ subject: "Hello", inbox: false, spam: true, labels: "SPAM" }],
      });

    expect((await runCheck(demo.id)).result).toBe("spam");
  });

  it("reports not-found when no message carries the marker", async () => {
    await saveSpamConfig({ checkerWebAppUrl: CHECKER_URL });
    const demo = await sentDemo();
    checkerResponse = () => Response.json({ ok: true, matches: [] });

    expect((await runCheck(demo.id)).result).toBe("not-found");
  });

  it("fails with a redeploy hint when the checker still runs the old script", async () => {
    await saveSpamConfig({ checkerWebAppUrl: CHECKER_URL });
    const demo = await sentDemo();
    checkerResponse = () => Response.json({ ok: false, error: "missing to" });

    await expect(runCheck(demo.id)).rejects.toMatchObject({
      name: "SpamCheckError",
      status: 502,
    });
    const [stored] = await getSpamHistory();
    expect(stored.result).toBe("error");
    expect(stored.detail).toContain("old send-only script");
  });

  it("fails when the checker returns Google's sign-in page", async () => {
    await saveSpamConfig({ checkerWebAppUrl: CHECKER_URL });
    const demo = await sentDemo();
    checkerResponse = () => new Response("<!DOCTYPE html><html>sign in</html>", { status: 200 });

    await expect(runCheck(demo.id)).rejects.toMatchObject({ status: 502 });
    const [stored] = await getSpamHistory();
    expect(stored.result).toBe("error");
    expect(stored.detail).toContain("sign-in page");
  });

  it("requires a saved checker URL before querying", async () => {
    const demo = await sentDemo();
    await expect(runCheck(demo.id)).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining("checker's Apps Script URL"),
    });
  });

  it("refuses to check a demo that never went out", async () => {
    await saveSpamConfig({ checkerWebAppUrl: CHECKER_URL });
    const mailboxId = await connectedMailbox();
    appsResponse = () => Response.json({ ok: false, error: "boom" }, { status: 500 });
    const demo = await sendDemo({ mailboxId, to: "a@b.co", subject: "x", body: "y" });

    await expect(runCheck(demo.id)).rejects.toMatchObject({ status: 400 });
  });

  it("rejects unknown demo ids", async () => {
    await saveSpamConfig({ checkerWebAppUrl: CHECKER_URL });
    await expect(runCheck("missing-id")).rejects.toMatchObject({ status: 404 });
  });
});

describe("spam check: saved config", () => {
  let mock: GitHubMock;

  beforeEach(() => {
    process.env.PSA_STATE_REPO = "owner/state-repo";
    process.env.GITHUB_TOKEN = "test-token";
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    mock = installGitHubMock();
    stubRouter(mock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("persists and masks the checker URL, keeps templates raw", async () => {
    const saved = await saveSpamConfig({
      checkerWebAppUrl: CHECKER_URL,
      subject: "About {{app}}",
      body: "Body text",
    });
    expect(saved.checkerWebAppUrl).toBe("https://script.google.com/…/exec");
    expect(saved.subject).toBe("About {{app}}");
    expect(saved.body).toBe("Body text");

    // Partial update keeps the untouched fields.
    const updated = await saveSpamConfig({ subject: "New subject" });
    expect(updated.subject).toBe("New subject");
    expect(updated.body).toBe("Body text");
    expect(updated.checkerWebAppUrl).toBe("https://script.google.com/…/exec");

    const config = await getSpamCheckConfig();
    expect(config.checkerWebAppUrl).toContain("…/exec");
    // The real URL only lives server-side in the raw state file.
    const state = storedJson(mock.files, SPAM_CHECK_PATH) as { checkerWebAppUrl: string };
    expect(state.checkerWebAppUrl).toBe(CHECKER_URL);
  });

  it("starts empty when nothing was ever saved", async () => {
    expect(await getSpamCheckConfig()).toEqual({ checkerWebAppUrl: "", subject: "", body: "" });
    expect(await getSpamHistory()).toEqual([]);
  });
});
