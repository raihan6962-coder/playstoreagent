import { describe, expect, it } from "vitest";
import { parseReleaseDate, readReleaseDateFromAppInfo } from "@/lib/parser/releaseDate";

describe("parseReleaseDate", () => {
  it("prefers the epoch the store stores with the date", () => {
    // "Jun 5, 2025" + the epoch it stands for.
    const parsed = parseReleaseDate(["Jun 5, 2025", [1749168247, 0]]);
    expect(parsed).toBe(1749168247 * 1000);
  });

  it("keeps the store's whole-second precision", () => {
    // The store stores [seconds, nanoseconds]. The day is the only part a
    // publish date means, so the sub-second part is dropped.
    const parsed = parseReleaseDate(["Jul 23, 2026", [1784825811, 890000000]]);
    expect(parsed).toBe(1784825811 * 1000);
  });

  it("falls back to the printed date when no epoch is there", () => {
    const parsed = parseReleaseDate(["Jun 5, 2025"]);
    expect(parsed).toBe(Date.UTC(2025, 5, 5));
  });

  it("reads a full month name", () => {
    expect(parseReleaseDate(["June 5, 2025"])).toBe(Date.UTC(2025, 5, 5));
    expect(parseReleaseDate(["September 17, 2025"])).toBe(Date.UTC(2025, 8, 17));
  });

  it("has no answer for an empty row", () => {
    // Play leaves the row empty for listings it no longer tracks.
    expect(parseReleaseDate(null)).toBeNull();
    expect(parseReleaseDate([])).toBeNull();
    expect(parseReleaseDate("not a date")).toBeNull();
  });

  it("rejects a date the store could not have written", () => {
    // Feb 31 does not exist.
    expect(parseReleaseDate(["Feb 31, 2025"])).toBeNull();
    expect(parseReleaseDate(["Smarch 5, 2025"])).toBeNull();
  });

  it("rejects an epoch from outside the store's own history", () => {
    // With no printed date to fall back on, an impossible epoch is no date.
    expect(parseReleaseDate([null, [123, 0]])).toBeNull();
    expect(parseReleaseDate([null, [9_999_999_999_999, 0]])).toBeNull();
    // With a printed date beside it, that date still answers the question.
    expect(parseReleaseDate(["Jun 5, 2025", [123, 0]])).toBe(Date.UTC(2025, 5, 5));
  });
});

describe("readReleaseDateFromAppInfo", () => {
  it("reads the release row out of the app-info block", () => {
    // The layout Play uses: the release date is index 10.
    const info: unknown[] = new Array(14).fill(null);
    info[10] = ["Jun 5, 2025", [1749168247, 0]];
    expect(readReleaseDateFromAppInfo(info)).toBe(1749168247 * 1000);
  });

  it("answers null when the row is empty", () => {
    const info: unknown[] = new Array(14).fill(null);
    expect(readReleaseDateFromAppInfo(info)).toBeNull();
    expect(readReleaseDateFromAppInfo(null)).toBeNull();
    expect(readReleaseDateFromAppInfo("nope")).toBeNull();
  });
});
