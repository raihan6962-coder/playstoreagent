import { parseInstallCount } from "./installs";
import { parseRating } from "./rating";
import { stripHtml, truncate } from "./html";
import type { StoreApp } from "@/types/lead";

export const PLAY_BASE_URL = "https://play.google.com";

const PACKAGE_PATTERN = /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z0-9_]+)+$/;
/** Length at which {@link readSummary} clips the card description. */
export const MAX_DESCRIPTION_LENGTH = 4_000;

export function looksLikePackageId(value: unknown): value is string {
  return typeof value === "string" && value.length <= 255 && PACKAGE_PATTERN.test(value);
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readPath(entry: unknown[]): string | null {
  const candidate = entry[10];
  if (Array.isArray(candidate)) {
    const nested = candidate[4];
    if (Array.isArray(nested)) {
      const path = readString(nested[2]);
      if (path && path.startsWith("/store/apps/details")) return path;
    }
  }
  return null;
}

function readIcon(entry: unknown[]): string | null {
  const candidate = entry[1];
  if (!Array.isArray(candidate)) return null;
  const nested = candidate[3];
  if (!Array.isArray(nested)) return null;
  const deeper = nested[2];
  if (typeof deeper === "string" && /^https:\/\//.test(deeper)) return deeper;
  return null;
}

function readSummary(entry: unknown[]): string | null {
  const candidate = entry[13];
  if (Array.isArray(candidate)) {
    const summary = readString(candidate[1]);
    if (summary) return truncate(stripHtml(summary), MAX_DESCRIPTION_LENGTH);
  }
  return null;
}

function readRating(entry: unknown[]): { value: number | null; raw: string | null } {
  const candidate = entry[4];
  if (!Array.isArray(candidate)) return { value: null, raw: null };
  const raw = candidate[0] === null || candidate[0] === undefined ? null : String(candidate[0]);
  const numeric = typeof candidate[1] === "number" ? candidate[1] : null;

  // Prefer the value Play prints in the UI, fall back to the raw score.
  const displayed = parseRating(candidate[0]);
  if (displayed !== null) return { value: displayed, raw };

  const precise = parseRating(numeric);
  if (precise !== null) return { value: precise, raw: raw ?? String(numeric) };

  return { value: null, raw };
}

/**
 * A node is considered a Play app card when it keeps the positional shape Play
 * has used for search/detail result entries. Every field is validated so a
 * structural change degrades to "no apps parsed" instead of crashing.
 */
export function isAppEntry(node: unknown): node is unknown[] {
  if (!Array.isArray(node) || node.length < 16) return false;
  const id = node[0];
  if (!Array.isArray(id) || !looksLikePackageId(id[0])) return false;
  if (readString(node[3]) === null) return false;
  if (node[4] !== null && !Array.isArray(node[4])) return false;
  if (node[14] !== null && typeof node[14] !== "string") return false;
  if (node[15] !== null && typeof node[15] !== "string") return false;
  if (readPath(node) === null && readIcon(node) === null) return false;
  return true;
}

export function toStoreApp(entry: unknown[]): StoreApp | null {
  if (!isAppEntry(entry)) return null;

  const id = entry[0];
  if (!Array.isArray(id)) return null;
  const packageName = String(id[0]);
  if (packageName.length === 0) return null;
  const installs = parseInstallCount(entry[15]);
  const rating = readRating(entry);

  return {
    packageName,
    title: readString(entry[3]) ?? packageName,
    developer: readString(entry[14]),
    rating: rating.value,
    ratingRaw: rating.raw,
    ratingsCount: null,
    installsRaw: installs.raw,
    installs: installs.value,
    installsUpper: installs.upperBound,
    category: readString(entry[5]),
    summary: readSummary(entry),
    description: null,
    icon: readIcon(entry),
    urlPath: readPath(entry) ?? `/store/apps/details?id=${encodeURIComponent(packageName)}`,
  };
}

export function collectStoreApps(data: unknown): StoreApp[] {
  const results: StoreApp[] = [];
  const seen = new Set<string>();

  const walk = (node: unknown, depth: number): void => {
    if (!Array.isArray(node) || depth > 40) return;

    if (isAppEntry(node)) {
      const app = toStoreApp(node);
      if (app && !seen.has(app.packageName)) {
        seen.add(app.packageName);
        results.push(app);
      }
      return;
    }

    for (const child of node) {
      if (Array.isArray(child)) walk(child, depth + 1);
    }
  };

  walk(data, 0);
  return results;
}

export function playStoreUrl(packageName: string, hl = "en", gl = "US"): string {
  return `${PLAY_BASE_URL}/store/apps/details?id=${encodeURIComponent(packageName)}&hl=${hl}&gl=${gl}`;
}
