import { parseDetailPage } from "@/lib/parser/detailPage";
import { PlayClient, PlayParseError } from "./client";
import type { StoreApp } from "@/types/lead";

export interface DetailResult {
  app: StoreApp | null;
  similarApps: StoreApp[];
}

export function buildDetailUrl(packageName: string, hl = "en", gl = "US"): string {
  const url = new URL(`https://play.google.com/store/apps/details`);
  url.searchParams.set("id", packageName);
  url.searchParams.set("hl", hl);
  url.searchParams.set("gl", gl);
  return url.toString();
}

/**
 * Fetches a single app detail page. Besides the ratings count used to enrich
 * confirmed leads, the page also exposes Play's "similar apps" cluster which
 * the crawler uses to widen keyword-relevant discovery.
 */
export async function fetchAppDetail(
  client: PlayClient,
  packageName: string,
  hl = "en",
  gl = "US",
): Promise<DetailResult> {
  const url = buildDetailUrl(packageName, hl, gl);
  const { body } = await client.get(url);

  if (!body.includes("AF_initDataCallback") && !body.includes("application/ld+json")) {
    throw new PlayParseError("Play Store detail page did not contain any app data.");
  }

  const parsed = parseDetailPage(body, packageName);
  if (!parsed.parsedAnything) {
    throw new PlayParseError("Could not read data from the Play Store detail page.");
  }

  return { app: parsed.app, similarApps: parsed.similarApps };
}
