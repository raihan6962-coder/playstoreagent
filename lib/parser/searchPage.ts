import { extractAfScripts } from "./afData";
import { collectStoreApps } from "./appEntries";
import type { StoreApp } from "@/types/lead";

export interface SearchPageResult {
  apps: StoreApp[];
  continuationToken: string | null;
  parsedAnything: boolean;
}

function findContinuationToken(html: string): string | null {
  // Play stores the paging token as a long base64-ish string next to the
  // results cluster. It is intentionally only used as a diagnostic signal: the
  // public search page does not expose a working "next page" endpoint anymore.
  const match = /"((?:EAE|AF1|AF2)[A-Za-z0-9_\-+/]{40,}={0,2})"/.exec(html);
  return match ? match[1] : null;
}

/**
 * Parses a Play Store search results page. All `AF_initDataCallback` payloads
 * are scanned so a layout move between keys degrades gracefully instead of
 * returning zero results.
 */
export function parseSearchPage(html: string): SearchPageResult {
  const merged = new Map<string, StoreApp>();

  for (const script of extractAfScripts(html)) {
    for (const app of collectStoreApps(script.data)) {
      if (!merged.has(app.packageName)) merged.set(app.packageName, app);
    }
  }

  return {
    apps: [...merged.values()],
    continuationToken: findContinuationToken(html),
    parsedAnything: merged.size > 0,
  };
}
