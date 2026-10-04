import { afterEach, describe, expect, it, vi } from "vitest";
import { generateSecondaryKeywords, MAX_SECONDARY, normalizeSecondary } from "@/lib/keywords/secondary";

function groqResponse(content: string): Response {
  return {
    ok: true,
    json: async () => ({ choices: [{ message: { content } }] }),
  } as unknown as Response;
}

describe("secondary keyword generation", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("normalises model output: trims, dedupes, drops the main keyword and junk", () => {
    const out = normalizeSecondary(
      [
        "  expense   manager ",
        "EXPENSE MANAGER",
        "budget tracker",
        "a",
        "x".repeat(200),
        "money tracker",
        42 as unknown as string,
      ],
      "budget tracker",
    );
    expect(out).toEqual(["expense manager", "money tracker"]);
  });

  it("caps the number of phrases", () => {
    const raw = Array.from({ length: MAX_SECONDARY + 20 }, (_, index) => `phrase number ${index}`);
    expect(normalizeSecondary(raw, "budget tracker")).toHaveLength(MAX_SECONDARY);
  });

  it("parses fenced JSON arrays and surrounding prose", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        groqResponse('Here you go:\n```json\n["expense manager","money tracker"]\n```'),
      ),
    );
    vi.stubEnv("GROQ_API_KEY", "test-key");
    await expect(generateSecondaryKeywords("budget tracker")).resolves.toEqual([
      "expense manager",
      "money tracker",
    ]);
  });

  it("returns an empty list when no API key is configured", async () => {
    vi.stubEnv("GROQ_API_KEY", "");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(generateSecondaryKeywords("budget tracker")).resolves.toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns an empty list on HTTP errors, bad payloads and network failures", async () => {
    vi.stubEnv("GROQ_API_KEY", "test-key");

    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500 }) as unknown as Response));
    await expect(generateSecondaryKeywords("budget tracker")).resolves.toEqual([]);

    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({}) }) as unknown as Response));
    await expect(generateSecondaryKeywords("budget tracker")).resolves.toEqual([]);

    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("boom"); }));
    await expect(generateSecondaryKeywords("budget tracker")).resolves.toEqual([]);
  });
});
