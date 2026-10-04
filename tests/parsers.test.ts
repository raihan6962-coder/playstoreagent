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
    expect(result.app?.ratingSource).toBe("visible");
  });

  it("reads the rating under the app's own heading, not an earlier label", () => {
    // Live layout variant: a neighbour's "Rated 4.5" label rendered before
    // the app's own heading while this listing prints 2.9. Reading the first
    // label on the page handed 4.5 to applyDetail, which dropped the lead.
    const html = `<html><head>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"SoftwareApplication","name":"Town Wallet","author":{"@type":"Person","name":"Town Dev"}}</script>
</head><body>
<div aria-label="Rated 4.5 stars out of five stars">4.5</div>
<h1><span itemprop="name">Town Wallet</span></h1>
<div aria-label="Rated 2.9 stars out of five stars">2.9</div>
<div class="WsMG1c">1,000+</div><div class="ClM7O">Downloads</div>
</body></html>`;

    const result = parseDetailPage(html, "com.example.townwallet");
    expect(result.app?.rating).toBe(2.9);
    expect(result.app?.ratingSource).toBe("visible");
  });

  it("tags a JSON-LD rating as package-scoped", () => {
    const html = detailHtml({
      packageName: "com.example.budget",
      title: "Budget Tracker",
      ratingValue: 2.4,
    });
    expect(parseDetailPage(html, "com.example.budget").app?.ratingSource).toBe("jsonld");
  });

  it("reads the developer's published contact email from the support anchor", () => {
    const html = detailHtml({
      packageName: "com.example.budget",
      title: "Budget Tracker",
      ratingValue: 2.4,
      email: "help@budget.example",
    });

    expect(parseDetailPage(html, "com.example.budget").app?.email).toBe("help@budget.example");
  });

  it("falls back to the developer-contact block when no support anchor is rendered", () => {
    const html = `<html><head>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"SoftwareApplication","name":"Ledger Lite","author":{"@type":"Person","name":"Ledger Works"}}</script>
</head><body>
<div class="WsMG1c">5,000+</div><div class="ClM7O">Downloads</div>
<script>AF_initDataCallback({key: 'ds:8', hash: '1', data:[[["com.example.ledger",7]],["Ledger Works",["ledger@works.example"],["2 Test St"]]], sideChannel: {}});</script>
</body></html>`;

    expect(parseDetailPage(html, "com.example.ledger").app?.email).toBe("ledger@works.example");
  });

  it("reports no email when the listing publishes none", () => {
    const plain = detailHtml({ packageName: "com.example.budget", title: "Budget Tracker", ratingValue: 2.4 });
    expect(parseDetailPage(plain, "com.example.budget").app?.email).toBeNull();

    // A description that quotes somebody else's address is not this app's
    // contact email and must never surface as one.
    const quoted = detailHtml({
      packageName: "com.example.budget",
      title: "Budget Tracker",
      ratingValue: 2.4,
      summary: "Questions? Mail billing@someone-else.example for help.",
    });
    expect(parseDetailPage(quoted, "com.example.budget").app?.email).toBeNull();
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
