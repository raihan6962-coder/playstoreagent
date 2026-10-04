import { extractAfScripts } from "./afData";
import { collectStoreApps, looksLikePackageId } from "./appEntries";
import { extractSoftwareApplication } from "./jsonLd";
import { parseInstallCount } from "./installs";
import { parseRating } from "./rating";
import { stripHtml, truncate } from "./html";
import type { StoreApp } from "@/types/lead";

export interface DetailPageResult {
  app: StoreApp | null;
  similarApps: StoreApp[];
  parsedAnything: boolean;
}

const DOWNLOADS_PATTERN =
  />([0-9][0-9.,\s\u00a0\u202f]*\s*[KMB]?\+?)<\s*\/div\s*><\s*div[^>]*>\s*Downloads\s*</i;

const PACKAGE_IN_URL = /[?&]id=([a-zA-Z][a-zA-Z0-9_]*(?:\.[a-zA-Z0-9_]+)+)/;

/**
 * Visible rating markup used when the JSON-LD block has no aggregate rating
 * (Play serves that to some storefronts). The aria label is the same number
 * the page prints next to the stars — i.e. exactly what the user sees.
 */
const VISIBLE_RATING_PATTERNS = [
  /Rated\s+([\d.,]+)\s+stars/i,
  /itemprop="ratingValue"[^>]*content="([\d.,]+)"/i,
  /content="([\d.,]+)"[^>]*itemprop="ratingValue"/i,
  /itemprop="ratingValue"[^>]*>\s*([\d.,]+)/i,
];

function readVisibleRating(html: string): { rating: number; raw: string } | null {
  // Anchor the read at the app's own heading: the rating widget sits under
  // the <h1>, while earlier page chrome and the "similar apps" carousel
  // carry their own "Rated … stars" labels. A live probe of one layout
  // variant found a neighbour's "Rated 4.5" before this listing's own 2.9
  // block, and the lead was dropped on that number.
  const heading = /<h1[\s>]/i.exec(html);
  const region = heading ? html.slice(heading.index) : html;
  for (const pattern of VISIBLE_RATING_PATTERNS) {
    const match = pattern.exec(region);
    if (!match) continue;
    const raw = match[1].trim();
    const rating = parseRating(raw);
    if (rating !== null) return { rating, raw };
  }
  return null;
}

function readInstallsFromHtml(html: string): string | null {
  const match = DOWNLOADS_PATTERN.exec(html);
  return match ? match[1].trim() : null;
}

function findPackageName(html: string, fallback?: string): string | null {
  if (fallback && looksLikePackageId(fallback)) return fallback;
  const anyMatch = PACKAGE_IN_URL.exec(html);
  return anyMatch ? anyMatch[1] : null;
}

/**
 * Contact email Play publishes on the listing itself:
 *  1. the rendered support anchor (`href="mailto:…"`) — the address the store
 *     shows next to "Support email";
 *  2. the developer-contact block Play embeds in the page data
 *     (`["Dev Name",["email@example.com"],["address…"]])`.
 *
 * Deliberately not a free-floating email scan: descriptions quote addresses
 * belonging to other products, and those must never end up on a lead row.
 * Returns null when the developer publishes no address — that is the honest
 * value for a listing without one.
 */
const SUPPORT_EMAIL_PATTERNS = [
  /href="mailto:([^"&?#\s<>]+)"/i,
  /\["[^"\[\]]{1,80}",\["([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})"\]/,
];

function readDeveloperEmail(html: string): string | null {
  for (const pattern of SUPPORT_EMAIL_PATTERNS) {
    const match = pattern.exec(html);
    if (!match) continue;
    const email = match[1].trim();
    if (email.length > 0 && email.length <= 254 && email.includes("@")) return email;
  }
  return null;
}

function collectAllApps(html: string): StoreApp[] {
  const merged = new Map<string, StoreApp>();
  for (const script of extractAfScripts(html)) {
    for (const app of collectStoreApps(script.data)) {
      if (!merged.has(app.packageName)) merged.set(app.packageName, app);
    }
  }
  return [...merged.values()];
}

/**
 * Parses a Play Store app detail page into the enriched app plus the
 * "similar apps" cluster Play renders on the same page.
 */
export function parseDetailPage(html: string, requestedPackage?: string): DetailPageResult {
  const jsonLd = extractSoftwareApplication(html);
  const packageName = findPackageName(html, requestedPackage);
  const appsFromAf = collectAllApps(html);
  const fromAf = packageName ? appsFromAf.find((app) => app.packageName === packageName) : undefined;
  const visible = jsonLd?.rating === null || jsonLd?.rating === undefined ? readVisibleRating(html) : null;

  const installsRaw = readInstallsFromHtml(html) ?? fromAf?.installsRaw ?? null;
  const installs = parseInstallCount(installsRaw);

  let app: StoreApp | null = null;
  if (packageName) {
    const title = jsonLd?.name ?? fromAf?.title ?? null;
    if (title) {
      // Rating provenance decides whether a follow-up read may retract a lead
      // (see `applyDetail`): JSON-LD and this package's data blob are
      // package-scoped, the visible markup is positional. An AF entry that
      // exists without a rating means the storefront prints none — never
      // borrow a neighbour's label for an unrated listing.
      let rating: number | null = null;
      let ratingRaw: string | null = null;
      let ratingSource: StoreApp["ratingSource"] = undefined;
      if (jsonLd && jsonLd.rating !== null && jsonLd.rating !== undefined) {
        rating = jsonLd.rating;
        ratingRaw = String(jsonLd.rating);
        ratingSource = "jsonld";
      } else if (fromAf) {
        if (fromAf.rating !== null) {
          rating = fromAf.rating;
          ratingRaw = fromAf.ratingRaw;
          ratingSource = "af";
        }
      } else if (visible) {
        rating = visible.rating;
        ratingRaw = visible.raw;
        ratingSource = "visible";
      }
      app = {
        packageName,
        title,
        developer: jsonLd?.author ?? fromAf?.developer ?? null,
        rating,
        ratingRaw,
        ratingsCount: jsonLd?.ratingsCount ?? null,
        installsRaw: installs.ok ? installs.raw : null,
        installs: installs.value,
        installsUpper: installs.upperBound,
        category: jsonLd?.category ?? fromAf?.category ?? null,
        summary: jsonLd?.description ?? fromAf?.summary ?? null,
        description: jsonLd?.description ? truncate(stripHtml(jsonLd.description), 4_000) : null,
        icon: jsonLd?.image ?? fromAf?.icon ?? null,
        urlPath: fromAf?.urlPath ?? `/store/apps/details?id=${encodeURIComponent(packageName)}`,
        email: readDeveloperEmail(html),
        ratingSource,
      };
    }
  }

  const similarApps = appsFromAf.filter((entry) => entry.packageName !== packageName);

  return {
    app,
    similarApps,
    parsedAnything: Boolean(app) || appsFromAf.length > 0 || Boolean(jsonLd),
  };
}
