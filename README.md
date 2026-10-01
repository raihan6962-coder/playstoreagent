# Play Store Lead Generator

A production-ready, no-database web app that finds Google Play apps matching
**keyword relevance + a maximum rating + a maximum install count**, streams them
to the browser in real time and exports them as CSV.

- **Stack:** Next.js 16 (App Router) · React 19 · TypeScript · Tailwind 4 · Vitest
- **Data source:** server-side scraping of the public Google Play Store — no
  database, no paid or third-party APIs.

## What it does

1. Enter a keyword, a maximum rating (e.g. `3.0`), a maximum install count
   (e.g. `100K`), your Play Store country (two-letter code, default `BD`) and
   how many leads you want (1–1,000).
2. The server searches the Play Store, starting with your keyword and then a
   plan of related queries: **locally generated topic-consistent variants of
   your keyword** (every one keeps all of the keyword's significant words —
   "best budget tracker", "budget tracker lite apk", …), Play's own
   suggestions, variants, long-tail modifiers, 40+ storefront locales and
   free/paid filters. When the base plan runs out before your lead limit, the
   run appends fresh query waves and keeps going — it only stops at your
   limit or when another wave finds nothing new.
3. Every app card is scored for keyword relevance and qualified against your
   rating and install ceilings. Matches stream to the table immediately.
4. Confirmed leads are enriched from their detail page — fetched **from your
   selected country's storefront**, so the rating in the table is the number
   your Play Store shows (the same app can rate 2.2 in one country and 4.5 in
   another). The ratings count and install bucket are re-checked there too: a
   lead that would break a ceiling, has no rating to compare, or whose page
   now 404s is removed again (`lead-remove`) — and relevant results seed a
   "similar apps" expansion pass so the search can reach apps the keyword plan
   alone would miss.
5. Generation stops as soon as the requested number of leads is found, or —
   if the strict ceilings leave fewer apps than requested — after the query
   waves are exhausted, reported honestly as `plan-exhausted` with the count
   that was actually found.
6. Export the results to CSV (RFC 4180, Excel-friendly BOM).

## Running locally

```bash
npm install
npm run dev        # http://localhost:3000
```

Production build and tests:

```bash
npm run typecheck  # tsc --noEmit
npm run lint       # eslint
npm test           # unit + fixture-based tests (offline)
npm run build
npm start
```

Live tests against the real Play Store are skipped unless you opt in:

```bash
PLAY_LIVE=1 npm test
```

## Architecture

```
app/
  api/generate/route.ts   SSE endpoint: validation, rate limit, budget, resume
  page.tsx / layout.tsx   UI shell
components/               dashboard, search form, progress panel, lead table
lib/
  playstore/
    client.ts             polite HTTP client (timeout, retries, request gate)
    search.ts / detail.ts Play search + detail page fetchers
    suggest.ts            Play's own related-search suggestions (best effort)
    keywords.ts           deterministic topic-consistent keyword variants
    queryPlan.ts          deterministic plan of related queries
    crawler.ts            resumable session engine that emits GenerationEvent
  parser/                 AF_initDataCallback, JSON-LD, installs, rating, HTML
  filters/                keyword relevance scoring + qualification rules
  csv/                    CSV export
  validation/             server-side input + resume-cursor validation
  client/generation.ts    browser-side SSE reader and lead merge
tests/                    vitest suites + fixtures + optional live tests
```

### Real-time streaming

`POST /api/generate` replies with `text/event-stream`. Events are `progress`,
`lead`, `lead-update`, `lead-remove`, `warning`, `done` and `error`. The browser
renders each `lead` the moment the server finds it, and every event passes the
same qualification check on the client before a row can appear in the table or
the CSV — if the settings change between steps, the run restarts with the new
settings instead of keeping rows that no longer match.

### Resumable sessions (serverless friendly)

The Play Store has no working pagination for search results, so depth comes from
running a plan of queries. Each invocation works under a time budget
(`GENERATION_BUDGET_MS`, default 240 s) and, when the budget runs out, returns
the `done` event with a **cursor** (query plan position and wave, dedupe set,
expansion and enrichment queues, counters). The client replays that cursor on
the next request and the session continues exactly where it stopped. Cursors
are fully validated server-side; anything malformed is discarded and the
session restarts.

If the whole base plan runs out before the lead limit, the crawler appends a
**query wave** (a fresh deterministic batch of long-tail queries — appended
only, so the plan position stays valid across resumes) and continues. A wave
that discovers nothing new means the reachable supply under the given ceilings
is genuinely exhausted; only then does the run end, with an honest
`plan-exhausted` summary naming how many waves were searched.

### Qualification rules

An app becomes a lead only when **all** of these hold:

| Rule | Behaviour |
| --- | --- |
| Keyword relevance | **every** significant word of the keyword must appear in the listing (title / developer / category / description); weighted score is kept for ranking |
| Rating | present and `rating <= maxRating`, compared and stored at the one-decimal precision Play prints, always read from the run's selected country storefront |
| Installs | parseable and `installs <= maxInstalls` |
| Duplicate | seen earlier in the session |

Missing ratings and missing/unparseable install counts **never** qualify.

Install counts are store buckets (`"10,000+"`), so they are treated as lower
bounds and flagged with `installCertainty: "bucket"`.

Detail pages are authoritative: after enrichment a lead is re-checked against
the ceilings (and re-matched against the keyword on the combined search +
detail text). A lead that no longer qualifies — or whose detail page cannot
confirm a rating from the run's country — is removed from the table rather
than left on screen with numbers that break the rules it was collected with.
Every row's link carries the same country (`&gl=…`), so opening it shows the
same numbers the table printed.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `GENERATION_BUDGET_MS` | `240000` | work budget per SSE invocation (5 000–240 000) |

No other environment variables are required. Nothing secret is shipped to the
browser: all Play Store access happens in the route handler.

## Known limitations (important)

- **Play barely ranks very low rated apps.** Across hundreds of live probes the
  lowest rating the public search surface ever surfaced was ~2.2–2.5. Asking
  for `max rating = 2.0` will usually return few or no leads. The app reports
  this honestly (`plan-exhausted` plus a hint) instead of inventing rows —
  relax the ceiling, raise the install cap or use a more specific keyword.
- **Search has no pagination.** `&start=` is ignored and Play's `batchexecute`
  paging RPC returns `PlayDataError`. Coverage comes from query breadth and
  similar-apps expansion, not from scrolling.
- **Rate limiting** is best-effort and in-memory (this project deliberately has
  no database), so it protects one warm instance rather than the fleet.
- Scraping depends on Play's public markup. If the layout changes, the run
  fails fast with a clear `failed` reason rather than returning garbage.

## Deploy

```bash
npm i -g vercel
vercel --prod
```

The route exports `maxDuration = 300`, which matches Vercel's maximum function
duration on the Hobby plan.
