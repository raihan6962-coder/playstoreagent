export interface InstallParseResult {
  raw: string | null;
  value: number | null;
  upperBound: number | null;
  approximate: boolean;
  ok: boolean;
}

/**
 * Play Store install counts are bucketed and rendered with a trailing "+"
 * (e.g. "10,000+", "10K+", "1.000.000+", "50 000 000+").
 *
 * `value` is the bucket's lower bound (10_000 for "10,000+"), `upperBound` is
 * the exclusive upper edge of that bucket so callers can tell when a bucket
 * straddles the configured install ceiling.
 */
const KNOWN_BUCKETS = [
  0, 1, 5, 10, 50, 100, 500, 1_000, 5_000, 10_000, 50_000, 100_000, 500_000,
  1_000_000, 5_000_000, 10_000_000, 50_000_000, 100_000_000, 500_000_000,
  1_000_000_000, 5_000_000_000, 10_000_000_000,
];

const MISSING_VALUES = new Set([
  "",
  "-",
  "n/a",
  "na",
  "none",
  "null",
  "unknown",
  "varies with device",
  "varieswithdevice",
  "unrated",
]);

const SUFFIX_MULTIPLIERS: Record<string, number> = {
  k: 1_000,
  m: 1_000_000,
  b: 1_000_000_000,
  tys: 1_000,
  тыс: 1_000,
  mil: 1_000_000,
  mn: 1_000_000,
  млн: 1_000_000,
  mrд: 1_000_000_000,
  млрд: 1_000_000_000,
};

function round(value: number): number {
  return Math.round(value);
}

export function bucketUpperBound(value: number): number | null {
  for (const bucket of KNOWN_BUCKETS) {
    if (bucket > value) return bucket;
  }
  return null;
}

function parseNumericPart(part: string, hasSuffix: boolean): number | null {
  const cleaned = part.replace(/[\s\u00a0\u202f]/g, "");
  if (cleaned === "") return null;
  if (!/\d/.test(cleaned)) return null;

  const dotCount = (cleaned.match(/\./g) || []).length;
  const commaCount = (cleaned.match(/,/g) || []).length;
  const separatorCount = dotCount + commaCount;

  if (separatorCount === 0) {
    const plain = Number(cleaned);
    return Number.isFinite(plain) ? plain : null;
  }

  // "1.5K" / "1,5K" style decimal values only appear together with a suffix.
  if (hasSuffix && separatorCount === 1) {
    const separator = dotCount === 1 ? "." : ",";
    const decimals = cleaned.length - cleaned.lastIndexOf(separator) - 1;
    if (decimals > 0 && decimals <= 2) {
      const decimal = Number(cleaned.replace(separator, "."));
      return Number.isFinite(decimal) ? decimal : null;
    }
  }

  // Thousands separators: "10,000", "1.000.000", "1 000 000".
  const digits = cleaned.replace(/[.,]/g, "");
  if (!/^\d+$/.test(digits)) return null;
  const plain = Number(digits);
  return Number.isFinite(plain) ? plain : null;
}

export function parseInstallCount(input: unknown): InstallParseResult {
  if (input === null || input === undefined) {
    return { raw: null, value: null, upperBound: null, approximate: false, ok: false };
  }

  if (typeof input === "number") {
    if (!Number.isFinite(input) || input < 0) {
      return { raw: String(input), value: null, upperBound: null, approximate: false, ok: false };
    }
    const value = round(input);
    return {
      raw: String(input),
      value,
      upperBound: bucketUpperBound(value),
      approximate: false,
      ok: true,
    };
  }

  const raw = String(input).trim();
  const stripped = raw.replace(/\+/g, "").trim();
  const normalized = stripped.toLowerCase().replace(/[.,\s\u00a0\u202f]/g, "");
  if (MISSING_VALUES.has(normalized)) {
    return { raw, value: null, upperBound: null, approximate: false, ok: false };
  }

  const match = /^([\d.,\s\u00a0\u202f]+)([a-zA-Z\u0430-\u044f\u0410-\u042f]+)?$/.exec(stripped);
  if (!match) {
    return { raw, value: null, upperBound: null, approximate: false, ok: false };
  }

  const suffixToken = (match[2] || "").toLowerCase();
  const multiplier = suffixToken ? SUFFIX_MULTIPLIERS[suffixToken] : undefined;
  if (suffixToken && multiplier === undefined) {
    return { raw, value: null, upperBound: null, approximate: false, ok: false };
  }

  const base = parseNumericPart(match[1], multiplier !== undefined);
  if (base === null || !Number.isFinite(base) || base < 0) {
    return { raw, value: null, upperBound: null, approximate: false, ok: false };
  }

  const value = round(base * (multiplier ?? 1));

  return {
    raw,
    value,
    upperBound: bucketUpperBound(value),
    approximate: raw.includes("+") || Boolean(suffixToken),
    ok: true,
  };
}
