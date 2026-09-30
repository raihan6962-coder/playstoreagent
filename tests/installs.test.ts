import { describe, expect, it } from "vitest";
import { bucketUpperBound, parseInstallCount } from "@/lib/parser/installs";
import { parseRating, parseRatingsCount } from "@/lib/parser/rating";

describe("parseInstallCount", () => {
  it("reads Play's bucket labels as lower bounds", () => {
    expect(parseInstallCount("10,000+")).toMatchObject({ value: 10_000, ok: true, approximate: true });
    expect(parseInstallCount("1,000,000+").value).toBe(1_000_000);
    expect(parseInstallCount("50M+").value).toBe(50_000_000);
    expect(parseInstallCount("500K").value).toBe(500_000);
  });

  it("handles locale separators", () => {
    expect(parseInstallCount("1.000.000+").value).toBe(1_000_000);
    expect(parseInstallCount("50 000 000+").value).toBe(50_000_000);
    expect(parseInstallCount("1,5K+").value).toBe(1_500);
  });

  it("treats missing values as unknown, never as zero", () => {
    for (const input of [null, undefined, "", "-", "Varies with device"]) {
      const parsed = parseInstallCount(input);
      expect(parsed.ok).toBe(false);
      expect(parsed.value).toBeNull();
    }
  });

  it("exposes the next bucket edge", () => {
    expect(bucketUpperBound(10_000)).toBe(50_000);
    expect(bucketUpperBound(10_000_000_000)).toBeNull();
  });
});

describe("parseRating", () => {
  it("parses the printed score", () => {
    expect(parseRating("4.5")).toBe(4.5);
    expect(parseRating(2.1)).toBe(2.1);
    expect(parseRating("4,5")).toBe(4.5);
  });

  it("rejects missing and out of range scores", () => {
    expect(parseRating("New")).toBeNull();
    expect(parseRating("")).toBeNull();
    expect(parseRating(0)).toBeNull();
    expect(parseRating(5.5)).toBeNull();
    expect(parseRating(null)).toBeNull();
  });
});

describe("parseRatingsCount", () => {
  it("reads counts with separators", () => {
    expect(parseRatingsCount("12,345")).toBe(12_345);
    expect(parseRatingsCount(1_000)).toBe(1_000);
    expect(parseRatingsCount(null)).toBeNull();
  });
});
