import { describe, expect, it } from "vitest";
import { lintTemplate } from "@/lib/templateLint";

describe("template lint", () => {
  it("passes a clean, human-sounding template", () => {
    const issues = lintTemplate({
      subject: "Quick question about {{app}}",
      body: "Hi {{developer}},\n\nI came across {{app}} on Google Play — the ratings look great.\n\nWould you be open to a short chat next week?\n\nBest,\nAlex",
      intervalSeconds: 30,
    });
    expect(issues).toEqual([]);
  });

  it("flags spammy phrases", () => {
    const issues = lintTemplate({
      subject: "ACT NOW — 100% FREE!!!",
      body: "Congratulations, you are a winner! Click here for your guaranteed risk-free bonus.",
    });
    expect(issues.length).toBeGreaterThanOrEqual(4);
    expect(issues.join(" ")).toContain("100% free");
    expect(issues.join(" ")).toContain("guaranteed");
    expect(issues.join(" ")).toContain("click here");
  });

  it("flags Re:/FW: spoofing, ALL CAPS and exclamation storms", () => {
    const issues = lintTemplate({ subject: "Re: our previous conversation", body: "" });
    expect(issues.join(" ")).toContain("Re:/FW:");

    const caps = lintTemplate({ subject: "FREE TRIAL TODAY", body: "" });
    expect(caps.join(" ")).toContain("ALL CAPS");

    const bangs = lintTemplate({ subject: "Hurry!!!", body: "" });
    expect(bangs.join(" ")).toContain("!!!");
  });

  it("flags shorteners, thin bodies, walls of text and reckless pacing", () => {
    const issues = lintTemplate({
      subject: "For you",
      body: "Check https://bit.ly/xyz now " + "lorem ipsum ".repeat(60),
      intervalSeconds: 5,
    });
    expect(issues.join(" ")).toContain("bit.ly");
    expect(issues.join(" ")).toContain("wall of text");
    expect(issues.join(" ")).toContain("10s");
  });

  it("flags a very short body", () => {
    const issues = lintTemplate({ subject: "Hi", body: "Look at this." });
    expect(issues.join(" ")).toContain("very short");
  });

  it("stays quiet about empty drafts", () => {
    expect(lintTemplate({ subject: "", body: "" })).toEqual([]);
  });
});
