import { PlayClient, PlayParseError } from "./client";

const DEFAULT_BUILD_LABEL = "boq_playuiserver_20260928.09_p0";

export function extractBuildLabel(html: string): string {
  const match = /"cfb2h"\s*:\s*"([^"]+)"/.exec(html);
  return match ? match[1] : DEFAULT_BUILD_LABEL;
}

function encodeSuggestionsBody(term: string): string {
  const encoded = encodeURIComponent(term);
  return (
    "f.req=%5B%5B%5B%22IJ4APc%22%2C%22%5B%5Bnull%2C%5B%5C%22" +
    encoded +
    "%5C%22%5D%2C%5B10%5D%2C%5B2%5D%2C4%5D%5D%22%5D%5D%5D"
  );
}

/**
 * Best-effort related-search suggestions from Play's own suggest endpoint.
 * Failures are non-fatal: the crawler simply runs its deterministic plan.
 */
export async function fetchSearchSuggestions(
  client: PlayClient,
  term: string,
  hl = "en",
  gl = "US",
  buildLabel = DEFAULT_BUILD_LABEL,
  limit = 12,
): Promise<string[]> {
  const url =
    `https://play.google.com/_/PlayStoreUi/data/batchexecute?rpcids=IJ4APc` +
    `&f.sid=-697906427155521722&bl=${encodeURIComponent(buildLabel)}` +
    `&hl=${hl}&gl=${gl}&authuser&soc-app=121&soc-platform=1&soc-device=1` +
    `&_reqid=${Math.floor(Math.random() * 1_000_000_000)}`;

  const { body } = await client.postForm(url, encodeSuggestionsBody(term), {
    referer: "https://play.google.com/",
  });

  if (!body.startsWith(")]}'")) {
    throw new PlayParseError("Unexpected suggest response.");
  }

  const payload: unknown = JSON.parse(body.slice(body.indexOf("\n") + 1));
  const envelope = payload as unknown[][];
  const rawData = envelope?.[0]?.[2];
  if (typeof rawData !== "string") return [];

  const data = JSON.parse(rawData) as Array<Array<[string, ...unknown[]]>>;
  const rows = data?.[0]?.[0];
  if (!Array.isArray(rows)) return [];

  const out: string[] = [];
  for (const row of rows) {
    const label = Array.isArray(row) ? row[0] : null;
    if (typeof label === "string" && label.trim().length > 0) {
      out.push(label.trim());
    }
    if (out.length >= limit) break;
  }
  return out;
}
