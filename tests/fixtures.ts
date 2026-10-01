import type { PlayClient, PlayResponse } from "@/lib/playstore/client";

export interface EntryOptions {
  packageName: string;
  title: string;
  rating?: string | number | null;
  ratingValue?: number | null;
  installs?: string | null;
  developer?: string | null;
  category?: string | null;
  summary?: string | null;
  /** Rendered as Play's support anchor on detail pages only. */
  email?: string | null;
}

/** Builds one positional app card in the shape Play embeds in search pages. */
export function makeAppEntry(options: EntryOptions): unknown[] {
  const entry: unknown[] = new Array(16).fill(null);
  entry[0] = [options.packageName, 7];
  entry[1] = [null, null, null, [null, null, "https://play-lh.googleusercontent.com/abc=s64"]];
  entry[3] = options.title;
  entry[4] =
    options.rating === undefined || options.rating === null
      ? null
      : [options.rating, options.ratingValue ?? null];
  entry[5] = options.category ?? "Tools";
  entry[10] = [
    null,
    null,
    null,
    null,
    [null, null, `/store/apps/details?id=${options.packageName}&hl=en`],
  ];
  entry[13] = options.summary ? [null, options.summary] : null;
  entry[14] = options.developer ?? "Example Developer";
  entry[15] = options.installs ?? null;
  return entry;
}

function afScript(key: string, data: unknown): string {
  return `AF_initDataCallback({key: '${key}', hash: '1234', data:${JSON.stringify(
    data,
  )}, sideChannel: {}});`;
}

export function searchHtml(entries: unknown[][]): string {
  return `<html><body><div>Google Play</div><script>${afScript(
    "ds:1",
    entries.map((entry) => [entry]),
  )}</script></body></html>`;
}

export function detailHtml(
  main: EntryOptions,
  similar: EntryOptions[] = [],
  installsLabel = "10,000+",
): string {
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: main.title,
    description: main.summary ?? `${main.title} does the thing.`,
    author: { "@type": "Person", name: main.developer ?? "Example Developer" },
    applicationCategory: main.category ?? "Tools",
    image: "https://play-lh.googleusercontent.com/abc=s64",
    aggregateRating: {
      "@type": "AggregateRating",
      ratingValue: main.ratingValue ?? 2.4,
      ratingCount: 57,
    },
  };

  const afData = [main, ...similar].map((entry) => [makeAppEntry(entry)]);
  const emailAnchor = main.email
    ? `<a class="Si6A0c RrSxVb" href="mailto:${main.email}" target="_blank" aria-label="Support email mailto:${main.email} will open in your email app"></a>`
    : "";

  return `<html><head><meta property="og:url" content="https://play.google.com/store/apps/details?id=${main.packageName}&hl=en"></head>
<body>
<script type="application/ld+json" nonce="abc123">${JSON.stringify(jsonLd)}</script>
<div class="WsMG1c">${installsLabel}</div><div class="ClM7O">Downloads</div>
<div class="fgfPI">${emailAnchor}</div>
<script>${afScript("ds:8", afData)}</script>
</body></html>`;
}

function suggestBody(labels: string[]): string {
  const rows = labels.map((label) => [label]);
  const rawData = JSON.stringify([[rows]]);
  const payload = JSON.stringify([["wrb.fr", "IJ4APc", rawData]]);
  return `)]}'\n${payload}`;
}

export interface FakeRoutes {
  search?: (query: string) => string;
  detail?: (packageName: string) => string;
  suggest?: (term: string) => string[];
}

/**
 * Minimal stand-in for PlayClient so crawler tests exercise the real parsing,
 * filtering and cursor logic without touching the network.
 */
export function makeFakeClient(routes: FakeRoutes = {}): PlayClient {
  const client = {
    requests: 0,
    async get(url: string): Promise<PlayResponse> {
      client.requests += 1;
      const parsed = new URL(url);
      if (parsed.pathname === "/store/search") {
        const query = parsed.searchParams.get("q") ?? "";
        return { status: 200, body: (routes.search ?? (() => searchHtml([])))(query), url };
      }
      if (parsed.pathname === "/store/apps/details") {
        const id = parsed.searchParams.get("id") ?? "";
        return { status: 200, body: (routes.detail ?? (() => searchHtml([])))(id), url };
      }
      return { status: 404, body: "not found", url };
    },
    async postForm(url: string): Promise<PlayResponse> {
      client.requests += 1;
      return { status: 200, body: suggestBody(routes.suggest?.("") ?? []), url };
    },
  };

  return client as unknown as PlayClient;
}
