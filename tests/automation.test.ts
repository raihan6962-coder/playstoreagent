import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import {
  addMailbox,
  listMailboxes,
  pickMailbox,
  recordSend,
  removeMailbox,
  validateMailbox,
  validateWebAppUrl,
} from "@/lib/server/mailboxes";
import { TASKS_PATH, taskEmailLogPath } from "@/lib/server/paths";
import { createRun } from "@/lib/server/runs";
import { readJson, writeJson } from "@/lib/server/stateStore";
import {
  beginEmailTick,
  deliver,
  executeEmailTick,
  renderTemplate,
  sweepEmailChains,
} from "@/lib/server/emailSender";
import {
  createTask,
  deleteTask,
  handleTaskRunFinished,
  isValidTaskId,
  listTasks,
  startDueTasks,
  sweepTasks,
  updateTask,
  validateTask,
} from "@/lib/server/tasks";
import type { AutomationTask, EmailLog, Mailbox } from "@/types/automation";
import type { Lead } from "@/types/lead";
import { installGitHubMock, storedJson, type GitHubMock, type MockFile } from "./helpers/githubMock";

const ORIGIN = "http://automation.test";
/** Route the app posts to — controlled per test by `appsResponse`. */
const APPS_URL = "https://script.google.com/macros/s/test/exec";

let appsResponse: () => Response = () => Response.json({ ok: true });

function lead(email: string | null, pkg: string): Lead {
  return {
    packageName: pkg,
    title: `App ${pkg}`,
    developer: "Example Developer",
    rating: 4.1,
    ratingRaw: "4.1",
    ratingsCount: 10,
    installsRaw: "10,000",
    installs: 10_000,
    installsUpper: 10_000,
    category: "Tools",
    summary: null,
    description: null,
    icon: null,
    urlPath: null,
    email,
    playStoreUrl: `https://play.google.com/store/apps/details?id=${pkg}`,
    keyword: "budget tracker",
    relevanceScore: 1,
    relevanceTerms: [],
    installCertainty: "exact",
  };
}

function storedTasks(files: Map<string, MockFile>): AutomationTask[] {
  return storedJson(files, TASKS_PATH) as AutomationTask[];
}

async function replaceTaskIn(files: Map<string, MockFile>, task: AutomationTask): Promise<void> {
  const tasks = storedTasks(files);
  const index = tasks.findIndex((entry) => entry.id === task.id);
  expect(index).toBeGreaterThanOrEqual(0);
  tasks[index] = task;
  await writeJson(TASKS_PATH, tasks, "psa: seed task");
}

/** Fully-formed task written straight to the store (bypasses the HTTP layer). */
function seedTask(partial: Partial<AutomationTask> = {}): AutomationTask {
  const now = Date.now();
  const task: AutomationTask = {
    id: randomUUID(),
    keyword: "budget tracker",
    maxRating: 3.5,
    maxInstalls: 500_000,
    limit: 100,
    startAt: now + 60_000,
    mailboxIds: [],
    templateSubject: "About {{app}}",
    templateBody: "Hi {{developer}}, package {{package}}, rating {{rating}}.",
    intervalSeconds: 1,
    status: "scheduled",
    runId: null,
    runToken: null,
    emailToken: randomUUID(),
    leadCount: 0,
    error: null,
    email: {
      nextIndex: 0,
      sent: 0,
      failed: 0,
      lastSentAt: 0,
      leaseUntil: 0,
      consecutiveFailures: 0,
      startedAt: null,
      finishedAt: null,
    },
    createdAt: now,
    updatedAt: now,
    ...partial,
  };
  return task;
}

async function writeTasks(tasks: AutomationTask[]): Promise<void> {
  await writeJson(TASKS_PATH, tasks, "psa: seed tasks");
}

/**
 * Route fetch for the whole test: Apps Script URLs hit the per-test handler,
 * everything else (the GitHub contents API, the chain's own tick hops) falls
 * through to the store mock.
 */
function stubRouter(mock: GitHubMock): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).startsWith("https://script.google.com/")) return appsResponse();
      return (mock.fetchMock as unknown as typeof fetch)(input, init);
    }),
  );
}

function validPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    keyword: "recipe box",
    maxRating: 3.5,
    maxInstalls: "500000",
    limit: 100,
    startAt: String(Date.now() + 60_000),
    mailboxIds: [],
    templateSubject: "Quick question",
    templateBody: "Hello there, {{email}}.",
    intervalSeconds: 30,
    ...overrides,
  };
}

describe("automation: mailboxes", () => {
  let mock: GitHubMock;

  beforeEach(() => {
    process.env.PSA_STATE_REPO = "owner/state-repo";
    process.env.GITHUB_TOKEN = "test-token";
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_CHAT_ID;
    mock = installGitHubMock();
    appsResponse = () => Response.json({ ok: true });
    stubRouter(mock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("validates the Apps Script web-app URL", () => {
    expect(validateWebAppUrl(APPS_URL).ok).toBe(true);
    expect(validateWebAppUrl("http://script.google.com/macros/s/x/exec").ok).toBe(false);
    expect(validateWebAppUrl("https://script.google.com/macros/s/x").ok).toBe(false);
    expect(validateWebAppUrl("not a url").ok).toBe(false);
    expect(validateWebAppUrl(42).ok).toBe(false);
    // Loopback http stays allowed so local e2e can mock the mailer.
    expect(validateWebAppUrl("http://127.0.0.1:8787/exec").ok).toBe(true);
    expect(validateWebAppUrl("http://localhost:8787/exec").ok).toBe(true);
    expect(validateWebAppUrl("http://evil.example/exec").ok).toBe(false);
  });

  it("validates label and quota bounds", () => {
    expect(validateMailbox({ label: "", webAppUrl: APPS_URL, dailyQuota: 100 }).ok).toBe(false);
    expect(validateMailbox({ label: "box", webAppUrl: APPS_URL, dailyQuota: 0 }).ok).toBe(false);
    expect(validateMailbox({ label: "box", webAppUrl: APPS_URL, dailyQuota: 9_999 }).ok).toBe(false);
    const parsed = validateMailbox({ label: " box ", webAppUrl: ` ${APPS_URL} `, dailyQuota: "300" });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value).toEqual({ label: "box", webAppUrl: APPS_URL, dailyQuota: 300 });
  });

  it("adds, lists and removes mailboxes", async () => {
    const mailbox = await addMailbox({ label: "outreach", webAppUrl: APPS_URL, dailyQuota: 500 });
    expect((await listMailboxes()).map((entry) => entry.id)).toEqual([mailbox.id]);
    expect(await removeMailbox(mailbox.id)).toBe(true);
    expect(await listMailboxes()).toEqual([]);
    expect(await removeMailbox(mailbox.id)).toBe(false);
  });

  it("round-robins quota-free mailboxes and returns null when all are spent", async () => {
    const a = await addMailbox({ label: "a", webAppUrl: APPS_URL, dailyQuota: 1 });
    const b = await addMailbox({ label: "b", webAppUrl: APPS_URL, dailyQuota: 1 });
    const ids = [a.id, b.id];

    const first = await pickMailbox(ids, 0);
    expect(first?.mailbox.id).toBe(a.id);
    await recordSend(a.id);

    const second = await pickMailbox(ids, first!.cursor);
    expect(second?.mailbox.id).toBe(b.id);
    await recordSend(b.id);

    expect(await pickMailbox(ids, 0)).toBeNull();
    expect(await pickMailbox([], 0)).toBeNull();
  });

  it("treats a stale (yesterday's) counter as fresh quota", async () => {
    const box = await addMailbox({ label: "old", webAppUrl: APPS_URL, dailyQuota: 500 });
    await recordSend(box.id);
    await recordSend(box.id);

    const settings = (await readJson<{ mailboxes: Mailbox[] }>("config/mailboxes.json", true))!;
    settings.mailboxes[0].sent = { date: "2000-01-01", count: 499 };
    await writeJson("config/mailboxes.json", settings, "psa: stale quota");

    const picked = await pickMailbox([box.id], 0);
    expect(picked).not.toBeNull();
    // The pick only *reads* quota (yesterday's 499/500 still counts as fresh);
    // the counter resets lazily on the next recorded send.
    expect((await listMailboxes())[0].sent.count).toBe(499);
    await recordSend(box.id);
    const current = (await listMailboxes())[0];
    expect(current.sent.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(current.sent.count).toBe(1);
  });
});

describe("automation: task validation & CRUD", () => {
  let mock: GitHubMock;

  beforeEach(() => {
    process.env.PSA_STATE_REPO = "owner/state-repo";
    process.env.GITHUB_TOKEN = "test-token";
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_CHAT_ID;
    mock = installGitHubMock();
    stubRouter(mock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rejects invalid payloads with readable errors", async () => {
    expect((await validateTask(validPayload({ keyword: "x" }))).ok).toBe(false);
    expect((await validateTask(validPayload({ maxRating: 6 }))).ok).toBe(false);
    expect((await validateTask(validPayload({ limit: 0 }))).ok).toBe(false);
    expect((await validateTask(validPayload({ startAt: String(Date.now() - 10 * 60_000) }))).ok).toBe(
      false,
    );
    expect(
      (await validateTask(validPayload({ startAt: String(Date.now() + 60 * 24 * 60 * 60_000) }))).ok,
    ).toBe(false);
    expect((await validateTask(validPayload({ mailboxIds: [] }))).ok).toBe(false);
    expect(
      (await validateTask(validPayload({ mailboxIds: [randomUUID()] }))).ok,
    ).toBe(false);
    expect((await validateTask(validPayload({ intervalSeconds: 0 }))).ok).toBe(false);
    expect((await validateTask(validPayload({ intervalSeconds: 5_000 }))).ok).toBe(false);
    expect((await validateTask(validPayload({ templateSubject: "" }))).ok).toBe(false);
    expect((await validateTask(validPayload({ templateBody: "" }))).ok).toBe(false);
  });

  it("accepts a valid payload and creates/lists the task", async () => {
    const mailbox = await addMailbox({ label: "box", webAppUrl: APPS_URL, dailyQuota: 100 });
    const validated = await validateTask(validPayload({ mailboxIds: [mailbox.id] }));
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;

    const task = await createTask(validated.value);
    expect(task.status).toBe("scheduled");
    expect(task.runId).toBeNull();
    expect(isValidTaskId(task.id)).toBe(true);
    expect(isValidTaskId("../../../etc")).toBe(false);
    expect(await listTasks()).toHaveLength(1);
    expect(storedTasks(mock.files)[0].id).toBe(task.id);
  });

  it("edits only while scheduled and deletes with confirmation", async () => {
    const mailbox = await addMailbox({ label: "box", webAppUrl: APPS_URL, dailyQuota: 100 });
    const validated = await validateTask(validPayload({ mailboxIds: [mailbox.id] }));
    if (!validated.ok) throw new Error("expected valid payload");
    const task = await createTask(validated.value);

    const edited = await updateTask(task.id, { ...validated.value, limit: 42 });
    expect(edited).toEqual({ ok: true });
    expect((await listTasks())[0].limit).toBe(42);

    await writeTasks([{ ...(await listTasks())[0], status: "sending" }]);
    const blocked = await updateTask(task.id, { ...validated.value, limit: 7 });
    expect(blocked).toMatchObject({ ok: false, code: 409 });
    expect(await updateTask(randomUUID(), validated.value)).toMatchObject({ ok: false, code: 404 });

    expect(await deleteTask(task.id)).toBe(true);
    expect(await listTasks()).toEqual([]);
    expect(await deleteTask(task.id)).toBe(false);
  });

  it("deleting a collecting task stops its lead run", async () => {
    const mailbox = await addMailbox({ label: "box", webAppUrl: APPS_URL, dailyQuota: 100 });
    const validated = await validateTask(validPayload({ mailboxIds: [mailbox.id] }));
    if (!validated.ok) throw new Error("expected valid payload");
    const created = await createTask(validated.value);
    const { runId, token } = await createRun({
      keyword: "recipe box",
      maxRating: 3.5,
      maxInstalls: 500_000,
      limit: 10,
      country: "BD",
    });
    await writeTasks([{ ...created, status: "collecting", runId, runToken: token }]);

    expect(await deleteTask(created.id)).toBe(true);
    const meta = storedJson(mock.files, `runs/${runId}.meta.json`) as { status: string };
    expect(meta.status).toBe("stopped");
  });
});

describe("automation: scheduler", () => {
  let mock: GitHubMock;
  let mailboxId: string;

  beforeEach(async () => {
    process.env.PSA_STATE_REPO = "owner/state-repo";
    process.env.GITHUB_TOKEN = "test-token";
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_CHAT_ID;
    mock = installGitHubMock();
    stubRouter(mock);
    mailboxId = (await addMailbox({ label: "box", webAppUrl: APPS_URL, dailyQuota: 100 })).id;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("ignores tasks that are not due yet", async () => {
    const task = seedTask({ mailboxIds: [mailboxId], startAt: Date.now() + 5 * 60_000 });
    await writeTasks([task]);

    const result = await startDueTasks(ORIGIN);
    expect(result).toEqual({ due: 0, started: 0, failed: 0 });
    expect(storedTasks(mock.files)[0].status).toBe("scheduled");
  });

  it("claims a due task, launches its run and marks it collecting", async () => {
    const task = seedTask({ mailboxIds: [mailboxId], startAt: Date.now() - 1_000 });
    await writeTasks([task]);

    const result = await startDueTasks(ORIGIN, { country: "US" });
    expect(result).toEqual({ due: 1, started: 1, failed: 0 });

    const fresh = storedTasks(mock.files)[0];
    expect(fresh.status).toBe("collecting");
    expect(fresh.runId).toBeTruthy();
    expect(fresh.runToken).toBeTruthy();
    expect(mock.files.has(`runs/${fresh.runId}.state.json`)).toBe(true);
  });

  it("reschedules a claim whose createRun died (stale starting)", async () => {
    const task = seedTask({
      mailboxIds: [mailboxId],
      startAt: Date.now() - 1_000,
      status: "starting",
      updatedAt: Date.now() - 121_000,
    });
    await writeTasks([task]);

    const result = await startDueTasks(ORIGIN);
    expect(result.started).toBe(1);
    expect(storedTasks(mock.files)[0].status).toBe("collecting");
  });

  it("does not touch a fresh in-flight claim", async () => {
    const task = seedTask({
      mailboxIds: [mailboxId],
      startAt: Date.now() - 1_000,
      status: "starting",
      updatedAt: Date.now(),
    });
    await writeTasks([task]);

    const result = await startDueTasks(ORIGIN);
    expect(result).toEqual({ due: 0, started: 0, failed: 0 });
    expect(storedTasks(mock.files)[0].status).toBe("starting");
  });

  it("fails a task whose selected mailbox was deleted", async () => {
    const task = seedTask({ mailboxIds: [randomUUID()], startAt: Date.now() - 1_000 });
    await writeTasks([task]);

    const result = await startDueTasks(ORIGIN);
    expect(result).toMatchObject({ due: 1, started: 0, failed: 1 });

    const fresh = storedTasks(mock.files)[0];
    expect(fresh.status).toBe("failed");
    expect(fresh.error).toContain("mailbox was removed");
  });

  it("runs a full sweep pass without throwing", async () => {
    const due = seedTask({ mailboxIds: [mailboxId], startAt: Date.now() - 1_000 });
    const waiting = seedTask({ mailboxIds: [mailboxId], startAt: Date.now() + 60_000 });
    await writeTasks([due, waiting]);

    const result = await sweepTasks(ORIGIN);
    expect(result.started).toBe(1);
    expect(result.due).toBe(1);
    expect(storedTasks(mock.files)[0].status).toBe("collecting");
    expect(storedTasks(mock.files)[1].status).toBe("scheduled");
  });
});

describe("automation: run finished transitions", () => {
  let mock: GitHubMock;
  let mailboxId: string;

  beforeEach(async () => {
    process.env.PSA_STATE_REPO = "owner/state-repo";
    process.env.GITHUB_TOKEN = "test-token";
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_CHAT_ID;
    mock = installGitHubMock();
    stubRouter(mock);
    mailboxId = (await addMailbox({ label: "box", webAppUrl: APPS_URL, dailyQuota: 100 })).id;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fails the task when the run was stopped", async () => {
    const runId = randomUUID();
    const task = seedTask({ status: "collecting", runId, runToken: randomUUID(), mailboxIds: [mailboxId] });
    await writeTasks([task]);

    await handleTaskRunFinished(ORIGIN, runId, "stopped");
    const fresh = storedTasks(mock.files)[0];
    expect(fresh.status).toBe("failed");
    expect(fresh.error).toContain("stopped");
    expect(fresh.email.finishedAt).toBeTruthy();
  });

  it("fails the task when no leads were collected", async () => {
    const runId = randomUUID();
    const task = seedTask({ status: "collecting", runId, runToken: randomUUID(), mailboxIds: [mailboxId] });
    await writeTasks([task]);

    await handleTaskRunFinished(ORIGIN, runId, "target-reached");
    const fresh = storedTasks(mock.files)[0];
    expect(fresh.status).toBe("failed");
    expect(fresh.error).toContain("No leads were collected");
  });

  it("fails the task when none of the leads carry an email address", async () => {
    const runId = randomUUID();
    const task = seedTask({ status: "collecting", runId, runToken: randomUUID(), mailboxIds: [mailboxId] });
    await writeTasks([task]);
    await writeJson(`runs/${runId}.leads.json`, [lead(null, "com.a"), lead(null, "com.b")], "psa: seed");

    await handleTaskRunFinished(ORIGIN, runId, "target-reached");
    const fresh = storedTasks(mock.files)[0];
    expect(fresh.status).toBe("failed");
    expect(fresh.error).toContain("email address");
  });

  it("moves to sending with mailable leads and records the lead count", async () => {
    const runId = randomUUID();
    const task = seedTask({ status: "collecting", runId, runToken: randomUUID(), mailboxIds: [mailboxId] });
    await writeTasks([task]);
    await writeJson(
      `runs/${runId}.leads.json`,
      [lead("a@example.com", "com.a"), lead(null, "com.b"), lead("c@example.com", "com.c")],
      "psa: seed",
    );

    await handleTaskRunFinished(ORIGIN, runId, "target-reached");
    const fresh = storedTasks(mock.files)[0];
    expect(fresh.status).toBe("sending");
    expect(fresh.leadCount).toBe(3);
    expect(fresh.email.startedAt).toBeTruthy();
    expect(fresh.error).toBeNull();
  });

  it("leaves the task collecting on an auto-resumable reason", async () => {
    const runId = randomUUID();
    const task = seedTask({ status: "collecting", runId, runToken: randomUUID(), mailboxIds: [mailboxId] });
    await writeTasks([task]);

    await handleTaskRunFinished(ORIGIN, runId, "rate-limited");
    expect(storedTasks(mock.files)[0].status).toBe("collecting");
  });
});

describe("automation: email sender", () => {
  let mock: GitHubMock;

  beforeEach(() => {
    process.env.PSA_STATE_REPO = "owner/state-repo";
    process.env.GITHUB_TOKEN = "test-token";
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_CHAT_ID;
    mock = installGitHubMock();
    appsResponse = () => Response.json({ ok: true });
    stubRouter(mock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders placeholders and keeps unknown ones visible", () => {
    const rendered = renderTemplate(
      "Hi {{developer}} — {{app}} ({{package}}) by {{keyword}} rating {{rating}} {{installs}} {{url}} {{unknown}}",
      lead("x@y.z", "com.app"),
      "budget tracker",
    );
    expect(rendered).toBe(
      "Hi Example Developer — App com.app (com.app) by budget tracker rating 4.1 10,000 " +
        "https://play.google.com/store/apps/details?id=com.app {{unknown}}",
    );
  });

  it("delivers through a healthy Apps Script web app", async () => {
    const result = await deliver(APPS_URL, "to@example.com", "Hi", "Body");
    expect(result).toEqual({ ok: true });
  });

  it("flags Google's sign-in page instead of counting it as sent", async () => {
    appsResponse = () => new Response("<!DOCTYPE html><html>Sign in</html>", { status: 200 });
    const result = await deliver(APPS_URL, "to@example.com", "Hi", "Body");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("access: Anyone");
  });

  it("surfaces the web app's own error message", async () => {
    appsResponse = () => Response.json({ ok: false, error: "quota exhausted" });
    const result = await deliver(APPS_URL, "to@example.com", "Hi", "Body");
    expect(result).toEqual({ ok: false, error: "quota exhausted" });
  });

  it("guards the email tick lease (token, status, concurrency)", async () => {
    const mailboxId = (await addMailbox({ label: "box", webAppUrl: APPS_URL, dailyQuota: 10 })).id;
    const task = seedTask({ mailboxIds: [mailboxId] });
    await writeTasks([task]);

    expect(await beginEmailTick(task.id, "wrong")).toEqual({ kind: "forbidden" });
    expect(await beginEmailTick(randomUUID(), task.emailToken)).toEqual({ kind: "missing" });
    expect(await beginEmailTick(task.id, task.emailToken)).toMatchObject({
      kind: "final",
      status: "scheduled",
    });

    await replaceTaskIn(mock.files, { ...task, status: "sending" });
    const first = await beginEmailTick(task.id, task.emailToken);
    expect(first.kind).toBe("step");
    if (first.kind !== "step") return;
    expect(first.task.email.leaseUntil).toBeGreaterThan(Date.now());

    const second = await beginEmailTick(task.id, task.emailToken);
    expect(second.kind).toBe("busy");
  });

  it("walks every mailable lead at the configured interval and finishes", async () => {
    const mailboxId = (await addMailbox({ label: "box", webAppUrl: APPS_URL, dailyQuota: 10 })).id;
    const runId = randomUUID();
    const task = seedTask({
      status: "sending",
      mailboxIds: [mailboxId],
      runId,
      intervalSeconds: 1,
    });
    await writeTasks([task]);
    await writeJson(
      `runs/${runId}.leads.json`,
      [lead("one@example.com", "com.one"), lead(null, "com.two"), lead("three@example.com", "com.three")],
      "psa: seed",
    );

    const leased = await beginEmailTick(task.id, task.emailToken);
    expect(leased.kind).toBe("step");
    if (leased.kind !== "step") return;
    await executeEmailTick(ORIGIN, task.id, leased.task);

    const fresh = storedTasks(mock.files)[0];
    expect(fresh.status).toBe("done");
    expect(fresh.email.nextIndex).toBe(2);
    expect(fresh.email.sent).toBe(2);
    expect(fresh.email.failed).toBe(0);
    expect(fresh.email.finishedAt).toBeTruthy();
    expect(fresh.email.leaseUntil).toBe(0);

    const log = storedJson(mock.files, taskEmailLogPath(task.id)) as EmailLog;
    expect(log.entries).toHaveLength(2);
    expect(log.entries.every((entry) => entry.ok)).toBe(true);
    expect(Object.values(log.days).reduce((sum, day) => sum + day.sent, 0)).toBe(2);

    const mailbox = (await listMailboxes())[0];
    expect(mailbox.sent.count).toBe(2);
  });

  it("releases the lease and chains a hop when the store hiccups mid-send", async () => {
    const mailboxId = (await addMailbox({ label: "box", webAppUrl: APPS_URL, dailyQuota: 10 })).id;
    const runId = randomUUID();
    const task = seedTask({ status: "sending", mailboxIds: [mailboxId], runId });
    await writeTasks([task]);
    await writeJson(`runs/${runId}.leads.json`, [lead("one@example.com", "com.one")], "psa: seed");

    const leased = await beginEmailTick(task.id, task.emailToken);
    expect(leased.kind).toBe("step");
    if (leased.kind !== "step") return;

    // The checkpoint PUT right after the delivery dies once — the catch path
    // must free the lease AND chain a follow-up tick so the task does not
    // wait a full cron interval to resume.
    mock.failNextPut(500);
    await executeEmailTick(ORIGIN, task.id, leased.task);

    const fresh = storedTasks(mock.files)[0];
    expect(fresh.status).toBe("sending");
    expect(fresh.email.leaseUntil).toBe(0);

    const chainCalls = mock.fetchMock.mock.calls.filter(([url]) =>
      String(url).includes(`/api/tasks/${task.id}/email-tick`),
    );
    expect(chainCalls.length).toBeGreaterThan(0);
  });

  it("aborts after five consecutive delivery failures", async () => {
    appsResponse = () => new Response("<html>nope</html>", { status: 500 });
    const mailboxId = (await addMailbox({ label: "box", webAppUrl: APPS_URL, dailyQuota: 10 })).id;
    const runId = randomUUID();
    const task = seedTask({
      status: "sending",
      mailboxIds: [mailboxId],
      runId,
      email: {
        nextIndex: 0,
        sent: 0,
        failed: 0,
        lastSentAt: 0,
        leaseUntil: 0,
        consecutiveFailures: 4,
        startedAt: Date.now(),
        finishedAt: null,
      },
    });
    await writeTasks([task]);
    await writeJson(`runs/${runId}.leads.json`, [lead("one@example.com", "com.one")], "psa: seed");

    const leased = await beginEmailTick(task.id, task.emailToken);
    expect(leased.kind).toBe("step");
    if (leased.kind !== "step") return;
    await executeEmailTick(ORIGIN, task.id, leased.task);

    const fresh = storedTasks(mock.files)[0];
    expect(fresh.status).toBe("failed");
    expect(fresh.error).toContain("in a row");
    expect(fresh.email.consecutiveFailures).toBe(5);
  });

  it("sweep restarts quiet chains and lifts quota-waiting tasks", async () => {
    const mailboxId = (await addMailbox({ label: "box", webAppUrl: APPS_URL, dailyQuota: 10 })).id;
    const quiet = seedTask({
      status: "sending",
      mailboxIds: [mailboxId],
      updatedAt: Date.now() - 61_000,
      email: {
        nextIndex: 0,
        sent: 0,
        failed: 0,
        lastSentAt: 0,
        leaseUntil: 0,
        consecutiveFailures: 0,
        startedAt: Date.now(),
        finishedAt: null,
      },
    });
    const waiting = seedTask({
      status: "awaiting-quota",
      mailboxIds: [mailboxId],
      email: {
        nextIndex: 0,
        sent: 0,
        failed: 0,
        lastSentAt: 0,
        leaseUntil: 0,
        consecutiveFailures: 0,
        startedAt: Date.now(),
        finishedAt: null,
      },
    });
    const held = seedTask({
      status: "sending",
      mailboxIds: [mailboxId],
      email: {
        nextIndex: 0,
        sent: 0,
        failed: 0,
        lastSentAt: 0,
        leaseUntil: Date.now() + 60_000,
        consecutiveFailures: 0,
        startedAt: Date.now(),
        finishedAt: null,
      },
    });
    await writeTasks([quiet, waiting, held]);

    const result = await sweepEmailChains(ORIGIN);
    expect(result.sending).toBe(2);
    expect(result.leaseHeld).toBe(1);
    expect(result.kicked).toBe(2);
    expect(result.quotaReady).toBe(1);

    const tasks = storedTasks(mock.files);
    expect(tasks[0].status).toBe("sending");
    expect(tasks[1].status).toBe("sending");
    expect(tasks[2].status).toBe("sending");
  });
});
