const MISSING_RATINGS = new Set(["", "-", "new", "nr", " unrated", "not rated", "no ratings"]);

/**
 * Play renders the rating as a one decimal string ("4.5") in most locales but
 * some locales use a decimal comma ("4,5"). Ratings that cannot be resolved to
 * a value in (0, 5] are reported as missing so they never qualify as a lead.
 */
export function parseRating(input: unknown): number | null {
  if (input === null || input === undefined) return null;

  if (typeof input === "number") {
    return Number.isFinite(input) && input > 0 && input <= 5
      ? Math.round(input * 100) / 100
      : null;
  }

  const raw = String(input).trim();
  if (MISSING_RATINGS.has(raw.toLowerCase())) return null;

  const normalized = raw.replace(/\s/g, "").replace(/(\d),(\d)/, "$1.$2");
  if (!/^\d+(\.\d+)?$/.test(normalized)) return null;

  const value = Number(normalized);
  if (!Number.isFinite(value) || value <= 0 || value > 5) return null;
  return Math.round(value * 100) / 100;
}

export function parseRatingsCount(input: unknown): number | null {
  if (input === null || input === undefined) return null;
  const value =
    typeof input === "number" ? input : Number(String(input).replace(/[^\d.]/g, ""));
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.round(value);
}
