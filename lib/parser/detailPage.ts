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
  for (const pattern of VISIBLE_RATING_PATTERNS) {
    const match = pattern.exec(html);
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
      app = {
        packageName,
        title,
        developer: jsonLd?.author ?? fromAf?.developer ?? null,
        rating: jsonLd?.rating ?? visible?.rating ?? fromAf?.rating ?? null,
        ratingRaw:
          fromAf?.ratingRaw ??
          (jsonLd?.rating !== null && jsonLd?.rating !== undefined
            ? String(jsonLd.rating)
            : visible?.raw ?? null),
        ratingsCount: jsonLd?.ratingsCount ?? null,
        installsRaw: installs.ok ? installs.raw : null,
        installs: installs.value,
        installsUpper: installs.upperBound,
        category: jsonLd?.category ?? fromAf?.category ?? null,
        summary: jsonLd?.description ?? fromAf?.summary ?? null,
        description: jsonLd?.description ? truncate(stripHtml(jsonLd.description), 4_000) : null,
        icon: jsonLd?.image ?? fromAf?.icon ?? null,
        urlPath: fromAf?.urlPath ?? `/store/apps/details?id=${encodeURIComponent(packageName)}`,
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
