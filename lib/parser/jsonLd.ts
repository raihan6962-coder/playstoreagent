import { stripHtml, truncate } from "./html";
import { parseRating, parseRatingsCount } from "./rating";

export interface SoftwareApplicationJsonLd {
  name: string | null;
  description: string | null;
  author: string | null;
  category: string | null;
  image: string | null;
  rating: number | null;
  ratingsCount: number | null;
  ratingValueRaw: number | null;
}

const SCRIPT_PATTERN = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
const MAX_DESCRIPTION = 4_000;

export function extractSoftwareApplication(html: string): SoftwareApplicationJsonLd | null {
  SCRIPT_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = SCRIPT_PATTERN.exec(html)) !== null) {
    let payload: unknown;
    try {
      payload = JSON.parse(match[1]);
    } catch {
      continue;
    }

    const candidates = Array.isArray(payload) ? payload : [payload];
    for (const candidate of candidates) {
      if (!candidate || typeof candidate !== "object") continue;
      const record = candidate as Record<string, unknown>;
      const type = String(record["@type"] ?? "");
      if (!/Application/i.test(type)) continue;

      const author = record.author as Record<string, unknown> | undefined;
      const aggregate = record.aggregateRating as Record<string, unknown> | undefined;
      const image = record.image;
      const genre = record.applicationCategory ?? record.genre;

      const ratingValueRaw =
        aggregate && typeof aggregate.ratingValue === "number"
          ? aggregate.ratingValue
          : null;

      return {
        name: typeof record.name === "string" ? record.name : null,
        description:
          typeof record.description === "string"
            ? truncate(stripHtml(record.description), MAX_DESCRIPTION)
            : null,
        author:
          author && typeof author.name === "string" ? author.name : null,
        category: typeof genre === "string" ? genre : null,
        image: typeof image === "string" ? image : null,
        rating: aggregate ? parseRating(aggregate.ratingValue) : null,
        ratingsCount: aggregate ? parseRatingsCount(aggregate.ratingCount) : null,
        ratingValueRaw,
      };
    }
  }

  return null;
}
