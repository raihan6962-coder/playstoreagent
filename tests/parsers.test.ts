import { describe, expect, it } from "vitest";
import { extractAfScripts } from "@/lib/parser/afData";
import { parseDetailPage } from "@/lib/parser/detailPage";
import { parseSearchPage } from "@/lib/parser/searchPage";
import { decodeEntities, stripHtml } from "@/lib/parser/html";
import { detailHtml, makeAppEntry, searchHtml } from "./fixtures";

describe("extractAfScripts", () => {
  it("pulls the JSON payload out of Play's callback blocks", () => {
    const html = searchHtml([[makeAppEntry({ packageName: "com.a.b", title: "A" })]]);
    const scripts = extractAfScripts(html);
    expect(scripts).toHaveLength(1);
    expect(scripts[0].key).toBe("ds:1");
    expect(Array.isArray(scripts[0].data)).toBe(true);
  });

  it("survives a malformed payload", () => {
    const html = "AF_initDataCallback({key: 'ds:9', hash: '1', data:{{{, sideChannel: {}});";
    expect(extractAfScripts(html)).toEqual([]);
  });
});

describe("parseSearchPage", () => {
  it("reads app cards from a search page", () => {
    const html = searchHtml([
      makeAppEntry({ packageName: "com.example.budget", title: "Budget Tracker", rating: "2.1", installs: "10,000+" }),
      makeAppEntry({ packageName: "com.example.other", title: "Other App", rating: "4.4", installs: "1,000,000+" }),
    ]);

    const result = parseSearchPage(html);
    expect(result.parsedAnything).toBe(true);
    expect(result.apps).toHaveLength(2);

    const first = result.apps[0];
    expect(first.packageName).toBe("com.example.budget");
    expect(first.title).toBe("Budget Tracker");
    expect(first.rating).toBe(2.1);
    expect(first.installs).toBe(10_000);
    expect(first.installsRaw).toBe("10,000+");
    expect(first.developer).toBe("Example Developer");
    expect(first.urlPath).toContain("com.example.budget");
  });

  it("reports nothing for an unrelated page", () => {
    const result = parseSearchPage("<html><body>no results here</body></html>");
    expect(result.parsedAnything).toBe(false);
    expect(result.apps).toEqual([]);
  });
});

describe("parseDetailPage", () => {
  it("merges JSON-LD metadata with the similar-apps cluster", () => {
    const html = detailHtml(
      { packageName: "com.example.budget", title: "Budget Tracker", ratingValue: 2.4 },
      [
        {
          packageName: "com.example.similar",
          title: "Similar Budget App",
          rating: "2.8",
          installs: "5,000+",
        },
      ],
      "10,000+",
    );

    const result = parseDetailPage(html, "com.example.budget");
    expect(result.parsedAnything).toBe(true);
    expect(result.app?.packageName).toBe("com.example.budget");
    expect(result.app?.rating).toBe(2.4);
    expect(result.app?.ratingsCount).toBe(57);
    expect(result.app?.installs).toBe(10_000);
    expect(result.app?.description).toContain("does the thing");
    expect(result.similarApps.map((app) => app.packageName)).toEqual(["com.example.similar"]);
  });

  it("still parses when JSON-LD is missing", () => {
    const html = searchHtml([
      makeAppEntry({ packageName: "com.example.bare", title: "Bare App", rating: "3.0", installs: "5,000+" }),
    ]);
    const result = parseDetailPage(html, "com.example.bare");
    expect(result.app?.packageName).toBe("com.example.bare");
    expect(result.app?.ratingsCount).toBeNull();
  });

  it("falls back to the visible star rating when JSON-LD has no aggregate", () => {
    // Play serves detail pages without aggregateRating to some storefronts;
    // the aria label is the exact number printed next to the stars, i.e. what
    // the user sees on the store.
    const html = `<html><head>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"SoftwareApplication","name":"Town Wallet","author":{"@type":"Person","name":"Town Dev"}}</script>
</head><body>
<div aria-label="Rated 4.5 stars">4.5</div>
<div class="WsMG1c">10,000+</div><div class="ClM7O">Downloads</div>
</body></html>`;

    const result = parseDetailPage(html, "com.example.townwallet");
    expect(result.app?.packageName).toBe("com.example.townwallet");
    expect(result.app?.rating).toBe(4.5);
  });
});

describe("html helpers", () => {
  it("decodes named, decimal and hex entities", () => {
    expect(decodeEntities("Tom &amp; Jerry &#39;00 &#x41;")).toBe("Tom & Jerry '00 A");
  });

  it("strips tags and collapses whitespace", () => {
    expect(stripHtml("<p>Hello <b>world</b></p>\n  again")).toBe("Hello world again");
  });
});
