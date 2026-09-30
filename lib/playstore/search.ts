import { parseSearchPage } from "@/lib/parser/searchPage";
import { PlayClient, PlayParseError } from "./client";
import { extractBuildLabel } from "./suggest";
import type { StoreApp } from "@/types/lead";

export type PriceFilter = "all" | "free" | "paid";

export interface SearchParams {
  query: string;
  hl?: string;
  gl?: string;
  price?: PriceFilter;
}

export interface SearchResult {
  apps: StoreApp[];
  continuationToken: string | null;
  url: string;
  /** Current Play build label, reused by the suggest endpoint. */
  buildLabel: string;
}

function priceValue(price: PriceFilter | undefined): 0 | 1 | 2 {
  if (price === "free") return 1;
  if (price === "paid") return 2;
  return 0;
}

export function buildSearchUrl(params: SearchParams): string {
  const url = new URL("https://play.google.com/store/search");
  url.searchParams.set("c", "apps");
  url.searchParams.set("q", params.query);
  url.searchParams.set("hl", params.hl ?? "en");
  url.searchParams.set("gl", params.gl ?? "US");
  const price = priceValue(params.price);
  if (price !== 0) url.searchParams.set("price", String(price));
  return url.toString();
}

/**
 * Runs one Play Store keyword search and normalises the app cards found on the
 * results page. Play currently returns at most ~30 cards per query, so deep
 * coverage comes from running a plan of related queries (see queryPlan.ts).
 */
export async function searchApps(
  client: PlayClient,
  params: SearchParams,
): Promise<SearchResult> {
  const url = buildSearchUrl(params);
  const { body } = await client.get(url);

  if (!body.includes("AF_initDataCallback")) {
    throw new PlayParseError("Play Store search page did not contain any result data.");
  }

  const parsed = parseSearchPage(body);
  if (!parsed.parsedAnything) {
    throw new PlayParseError("Could not read app cards from the Play Store search page.");
  }

  return {
    apps: parsed.apps,
    continuationToken: parsed.continuationToken,
    url,
    buildLabel: extractBuildLabel(body),
  };
}
