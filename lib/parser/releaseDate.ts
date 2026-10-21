/**
 * Play's **first release** date — when the listing was published, not when it
 * was last updated.
 *
 * The store keeps it in the detail page's app-info block, the `ds:5` blob
 * Play embeds next to the listing. That block is a sparse array with a fixed
 * leading layout (measured over 14 live listings):
 *
 *   [0]  the app title
 *   [9]  the content-rating row ("Everyone" + its icon)
 *   [10] the release date — ["Jun 5, 2025", [1749168247, 0]]
 *   [13] the install row ("10+", 10, 25, "10+")
 *
 * The release row is `null` for listings old enough that Play no longer
 * records one (a 2011 app), which is exactly the answer the "newly
 * published" filter wants: no date means the listing is not provably new.
 *
 * The date row has two forms — a printed "Jun 5, 2025" and the epoch it
 * stands for. The epoch is preferred: it needs no locale or month-name
 * guessing. The store keeps it as [seconds, nanoseconds]; only the whole
 * seconds are kept, because a publish date means a day, not an instant.
 */

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
  january: 0, february: 1, march: 2, april: 3, june: 5,
  july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
};

const PRINTED_DATE = /^([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})$/;

/**
 * Epoch bounds for a plausible Play listing: 2010-01-01 to 2035-01-01, in
 * both seconds and milliseconds. Anything outside is a misread, not a date.
 */
const MIN_EPOCH_SECONDS = 1_262_304_000;
const MAX_EPOCH_SECONDS = 2_051_222_400;

/**
 * Reads the epoch out of the release row. The row is
 * `["Jun 5, 2025", [1749168247, 0]]` — the epoch in seconds with the
 * nanosecond remainder beside it — but some listings carry the seconds
 * directly.
 */
function readEpochSeconds(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) && value >= MIN_EPOCH_SECONDS && value <= MAX_EPOCH_SECONDS
      ? value
      : null;
  }
  if (Array.isArray(value) && typeof value[0] === "number") {
    return readEpochSeconds(value[0]);
  }
  return null;
}

/**
 * Reads a printed "Jun 5, 2025" as UTC midnight. The store prints the date
 * in the storefront's locale, so the day is the only part that can be
 * trusted — the time of day is not printed at all.
 */
function readPrintedDate(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = PRINTED_DATE.exec(value.trim());
  if (!match) return null;
  const month = MONTHS[match[1].toLowerCase()];
  if (month === undefined) return null;
  const day = Number(match[2]);
  const year = Number(match[3]);
  if (day < 1 || day > 31) return null;
  const stamp = Date.UTC(year, month, day);
  if (!Number.isFinite(stamp)) return null;
  // Reject impossible dates like "Feb 31" (Date.UTC rolls them over).
  const round = new Date(stamp);
  if (round.getUTCMonth() !== month || round.getUTCDate() !== day) return null;
  return stamp;
}

/**
 * Parses Play's release row into epoch milliseconds, or null when the row
 * holds no date (an old listing) or something this parser does not
 * understand.
 */
export function parseReleaseDate(row: unknown): number | null {
  if (!Array.isArray(row) || row.length === 0) return null;

  // The epoch is the precise answer; take it when both are present.
  const seconds = readEpochSeconds(row[1]);
  if (seconds !== null) return seconds * 1000;

  const printed = readPrintedDate(row[0]);
  if (printed !== null) return printed;

  // Some layouts put the epoch first and the printed date second.
  const flipped = readEpochSeconds(row[0]);
  if (flipped !== null) return flipped * 1000;
  return readPrintedDate(row[1]);
}

/**
 * Reads the release date out of the `ds:5` app-info block. The block is
 * addressed as `data[1][2]`; the release row is index 10 of it.
 */
export function readReleaseDateFromAppInfo(appInfo: unknown): number | null {
  if (!Array.isArray(appInfo)) return null;
  return parseReleaseDate(appInfo[10]);
}
