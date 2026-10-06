import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addMailbox } from "@/lib/server/mailboxes";
import { taskEmailLogPath, TASKS_PATH } from "@/lib/server/paths";
import {
  checkReplies,
  classifyReply,
  getRepliesState,
  parseFromEmail,
  type ReplyRaw,
} from "@/lib/server/replies";
import { writeJson } from "@/lib/server/stateStore";
import { installGitHubMock, type GitHubMock } from "./helpers/githubMock";

const APPS_URL = "https://script.google.com/macros/s/test/exec";

let repliesResponse: () => Response = () => Response.json({ ok: true, messages: [] });
/** Telegram sendMessage payloads captured by the fetch router. */
let telegramPosts: { chat_id: string; text: string }[] = [];
/** The last {action:"replies"} request the server made to the mailer. */
let lastReplyRequest: { action?: string; since?: number; senders?: string[] } | null = null;

function stubRouter(mock: GitHubMock): void {
  telegramPosts = [];
  lastReplyRequest = null;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("api.telegram.org")) {
        telegramPosts.push(JSON.parse(String(init?.body)) as (typeof telegramPosts)[number]);
        return Response.json({ ok: true });
      }
      if (url.startsWith("https://script.google.com/") && init?.body) {
        const parsed = JSON.parse(String(init.body)) as { action?: string };
        if (parsed.action === "replies") {
          lastReplyRequest = parsed as typeof lastReplyRequest;
          return repliesResponse();
        }
        return Response.json({ ok: true });
      }
      return (mock.fetchMock as unknown as typeof fetch)(input, init);
    }),
  );
}

function raw(overrides: Partial<ReplyRaw> = {}): ReplyRaw {
  return {
    id: "m1",
    threadId: "t1",
    from: "Ada <ada@example.com>",
    to: "outreach@gmail.com",
    subject: "Re: About Sample App",
    date: Date.now() - 5_000,
    body: "Interesting — can we talk next week?",
    headers: {},
    ...overrides,
  };
}

describe("reply classification", () => {
  it("flags machine replies from headers, sender, subject and body", () => {
    expect(classifyReply(raw({ headers: { autoSubmitted: "auto-replied" } }))).toBe("auto");
    expect(classifyReply(raw({ headers: { precedence: "bulk" } }))).toBe("auto");
    expect(classifyReply(raw({ headers: { xAutoResponseSuppress: "OOF,DR" } }))).toBe("auto");
    expect(classifyReply(raw({ from: "MAILER-DAEMON@example.com" }))).toBe("auto");
    expect(classifyReply(raw({ from: "no-reply@company.com" }))).toBe("auto");
    expect(classifyReply(raw({ subject: "Automatic reply" }))).toBe("auto");
    expect(classifyReply(raw({ subject: "Re: Out of office" }))).toBe("auto");
    expect(classifyReply(raw({ subject: "Undeliverable: About Sample App" }))).toBe("auto");
    expect(classifyReply(raw({ body: "I am out of the office until Monday." }))).toBe("auto");
    expect(classifyReply(raw({ body: "Auto-reply: your message reached my vacation inbox." }))).toBe(
      "auto",
    );
    expect(
      classifyReply(raw({ headers: { listUnsubscribe: "<https://x/u>" }, body: "To unsubscribe from these updates, click the link." })),
    ).toBe("auto");
  });

  it("treats everyday human replies as human", () => {
    expect(classifyReply(raw())).toBe("human");
    expect(classifyReply(raw({ headers: { autoSubmitted: "no" } }))).toBe("human");
    expect(classifyReply(raw({ body: "Sure — send the details over." }))).toBe("human");
    // A phone signature is not an autoresponder.
    expect(classifyReply(raw({ body: "Sounds good\n\nSent from my iPhone" }))).toBe("human");
    // Empty headers must never fail open to "auto".
    expect(classifyReply(raw({ headers: undefined }))).toBe("human");
  });

  it("parses the sender address out of a display name", () => {
    expect(parseFromEmail("Ada Lovelace <Ada@Example.com>")).toBe("ada@example.com");
    expect(parseFromEmail("plain@example.com")).toBe("plain@example.com");
    expect(parseFromEmail("")).toBe("");
  });
});

describe("reply scan", () => {
  let mock: GitHubMock;

  beforeEach(async () => {
    process.env.PSA_STATE_REPO = "owner/state-repo";
    process.env.GITHUB_TOKEN = "test-token";
    process.env.TELEGRAM_BOT_TOKEN = "test-bot-token";
    process.env.TELEGRAM_CHAT_ID = "chat-42";
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    mock = installGitHubMock();
    repliesResponse = () => Response.json({ ok: true, messages: [raw()] });
    stubRouter(mock);
    await addMailbox({ label: "outreach@gmail.com", webAppUrl: APPS_URL, dailyQuota: 500 });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("notifies Telegram for a new human reply and stores it", async () => {
    const summary = await checkReplies();
    expect(summary.newHuman).toBe(1);
    expect(summary.newAuto).toBe(0);
    expect(summary.errors).toEqual([]);
    expect(summary.outdated).toEqual([]);

    expect(telegramPosts).toHaveLength(1);
    expect(telegramPosts[0].chat_id).toBe("chat-42");
    expect(telegramPosts[0].text).toContain("Client replied (human)");
    expect(telegramPosts[0].text).toContain("ada@example.com");
    expect(telegramPosts[0].text).toContain("Re: About Sample App");
    expect(telegramPosts[0].text).toContain("can we talk next week?");
    expect(telegramPosts[0].text).toContain("outreach@gmail.com");

    const state = await getRepliesState();
    expect(state.history).toHaveLength(1);
    expect(state.history[0]).toMatchObject({ kind: "human", notified: true, fromEmail: "ada@example.com" });
    expect(state.lastCheck?.newHuman).toBe(1);
    expect(state.lastCheckedAt).toBeGreaterThan(0);
  });

  it("records auto replies but never notifies", async () => {
    repliesResponse = () =>
      Response.json({
        ok: true,
        messages: [raw({ id: "m2", subject: "Automatic reply", body: "I'm out of office." })],
      });

    const summary = await checkReplies();
    expect(summary.newAuto).toBe(1);
    expect(summary.newHuman).toBe(0);
    expect(telegramPosts).toHaveLength(0);

    const state = await getRepliesState();
    expect(state.history[0].kind).toBe("auto");
    expect(state.history[0].notified).toBe(false);
  });

  it("never notifies twice for the same message", async () => {
    await checkReplies();
    const second = await checkReplies();
    expect(second.newHuman).toBe(0);
    expect(telegramPosts).toHaveLength(1);

    const state = await getRepliesState();
    expect(state.history).toHaveLength(1);
  });

  it("reports mailboxes still running the pre-replies script", async () => {
    repliesResponse = () => Response.json({ ok: false, error: "missing to" });
    const summary = await checkReplies();
    expect(summary.outdated).toEqual(["outreach@gmail.com"]);
    expect(summary.errors).toEqual([]);
    expect(telegramPosts).toHaveLength(0);
  });

  it("passes recently mailed recipients to the script", async () => {
    await writeJson(TASKS_PATH, [{ id: "task-1" }], "psa: seed task");
    await writeJson(
      taskEmailLogPath("task-1"),
      {
        taskId: "task-1",
        entries: [
          { t: Date.now() - 60_000, to: "lead@example.com", mailboxId: "mb", ok: true },
          // Skipped/opt-out sends must not mark an address as active outreach.
          { t: Date.now() - 60_000, to: "optout@example.com", mailboxId: "mb", ok: true, skipped: true },
          // Too old to count.
          { t: Date.now() - 10 * 24 * 60 * 60_000, to: "ancient@example.com", mailboxId: "mb", ok: true },
        ],
        days: {},
        updatedAt: Date.now(),
      },
      "psa: seed log",
    );

    await checkReplies();
    expect(lastReplyRequest?.action).toBe("replies");
    expect(lastReplyRequest?.senders).toContain("lead@example.com");
    expect(lastReplyRequest?.senders).not.toContain("optout@example.com");
    expect(lastReplyRequest?.senders).not.toContain("ancient@example.com");
    expect(typeof lastReplyRequest?.since).toBe("number");
  });

  it("still records replies when Telegram is not configured", async () => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_CHAT_ID;

    const summary = await checkReplies();
    expect(summary.newHuman).toBe(1);
    expect(telegramPosts).toHaveLength(0);

    const state = await getRepliesState();
    expect(state.history[0].notified).toBe(false);
  });
});
