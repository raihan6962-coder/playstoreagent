import { describe, expect, it } from "vitest";
import { emptyPool, parsePool, toPoolCard } from "@/lib/playstore/harvest";
import { MAX_TEMP_CANDIDATES } from "@/lib/playstore/queryPlan";

const KEYWORD = "budget tracker";

function card(index: number) {
  return toPoolCard({
    p: `com.example.app${index}`,
    t: `Budget Tracker ${index}`,
    d: "Studio",
    r: 4.6,
    rr: "4.6",
    i: 10_000,
    ir: "10,000+",
    c: "Finance",
    s: `summary ${index}`.repeat(120),
    gl: "US",
  });
}

describe("harvest pool", () => {
  it("round-trips a persisted pool back into a usable inbox", () => {
    const saved = emptyPool(KEYWORD, 0);
    saved.cards = [card(1), card(2), card(3)];
    saved.collected = 3;

    const parsed = parsePool(JSON.parse(JSON.stringify(saved)), KEYWORD, 0);

    expect(parsed.keyword).toBe(KEYWORD);
    expect(parsed.keywordIndex).toBe(0);
    expect(parsed.cards).toHaveLength(3);
    expect(parsed.cards[0].p).toBe("com.example.app1");
    expect(parsed.collected).toBe(3);
  });

  it("survives the size a full harvest actually produces", () => {
    // The whole point of the split: 1000+ cards must round-trip, and the
    // summaries must stay clipped so the pool file stays a predictable size.
    const saved = emptyPool(KEYWORD, 0);
    saved.cards = Array.from({ length: MAX_TEMP_CANDIDATES }, (_, index) => card(index));
    saved.collected = saved.cards.length;

    const parsed = parsePool(JSON.parse(JSON.stringify(saved)), KEYWORD, 0);

    expect(parsed.cards).toHaveLength(MAX_TEMP_CANDIDATES);
    expect(parsed.collected).toBe(MAX_TEMP_CANDIDATES);
    // Clipped, but still well past the stub length the relevance check uses.
    expect(parsed.cards[0].s!.length).toBeLessThanOrEqual(600);
    expect(parsed.cards[0].s!.length).toBeGreaterThan(300);
  });

  it("discards a pool harvested for a different keyword or cycle", () => {
    const saved = emptyPool(KEYWORD, 0);
    saved.cards = [card(1), card(2)];
    saved.collected = 2;

    // Wrong keyword: those cards were harvested for a different relevance
    // verdict, so filtering them here would judge them against the wrong
    // text.
    expect(parsePool(saved, "crypto wallet", 0).cards).toHaveLength(0);
    // Wrong cycle: the run already moved past this keyword's inbox.
    expect(parsePool(saved, KEYWORD, 3).cards).toHaveLength(0);
  });

  it("self-heals a malformed pool instead of throwing away the session", () => {
    expect(parsePool(null, KEYWORD, 0).cards).toEqual([]);
    expect(parsePool("nonsense", KEYWORD, 0).cards).toEqual([]);
    expect(parsePool({ keyword: KEYWORD, keywordIndex: 0, cards: "no" }, KEYWORD, 0).cards).toEqual(
      [],
    );

    // A single bad entry is dropped, the rest of the inbox survives.
    const mixed = parsePool(
      {
        keyword: KEYWORD,
        keywordIndex: 0,
        collected: 3,
        cards: [{ p: "", t: "no package" }, { p: "com.example.ok", t: "Fine" }, 42],
      },
      KEYWORD,
      0,
    );
    expect(mixed.cards).toHaveLength(1);
    expect(mixed.cards[0].p).toBe("com.example.ok");
  });
});