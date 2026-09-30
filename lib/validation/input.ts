import { parseInstallCount } from "@/lib/parser/installs";

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

export const MAX_LEADS = 1_000;
export const MIN_RATING = 0.5;
export const MAX_RATING = 5;
export const MAX_INSTALLS = 1_000_000_000;
/** Ratings/links default to the storefront most of this app's users open. */
export const DEFAULT_COUNTRY = "BD";

/**
 * Play Store country code (ISO 3166-1 alpha-2). Ratings differ per storefront
 * for the same app, so this pins every displayed number — and the link the
 * table opens — to one country.
 */
export function validateCountry(input: unknown): ValidationResult<string> {
  if (input === undefined || input === null || input === "") {
    return { ok: true, value: DEFAULT_COUNTRY };
  }
  if (typeof input !== "string") {
    return { ok: false, error: "Country must be a two-letter Play Store code." };
  }
  const code = input.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) {
    return {
      ok: false,
      error: "Country must be a two-letter code like BD, US or GB.",
    };
  }
  return { ok: true, value: code };
}

export function validateKeyword(input: unknown): ValidationResult<string> {
  if (typeof input !== "string") {
    return { ok: false, error: "Keyword must be a string." };
  }
  const keyword = input.replace(/\s+/g, " ").trim();
  if (keyword.length < 2) {
    return { ok: false, error: "Keyword must be at least 2 characters." };
  }
  if (keyword.length > 80) {
    return { ok: false, error: "Keyword must be 80 characters or fewer." };
  }
  if (!/[\p{L}\p{N}]/u.test(keyword)) {
    return { ok: false, error: "Keyword must contain letters or numbers." };
  }
  if (/[\u0000-\u001f\u007f]/.test(keyword)) {
    return { ok: false, error: "Keyword contains invalid characters." };
  }
  return { ok: true, value: keyword };
}

export function validateMaxRating(input: unknown): ValidationResult<number> {
  const value = typeof input === "string" ? Number(input.replace(",", ".")) : input;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return { ok: false, error: "Maximum rating must be a number." };
  }
  const rounded = Math.round(value * 10) / 10;
  if (rounded < MIN_RATING || rounded > MAX_RATING) {
    return {
      ok: false,
      error: `Maximum rating must be between ${MIN_RATING} and ${MAX_RATING}.`,
    };
  }
  return { ok: true, value: rounded };
}

export function parseInstallInput(input: unknown): ValidationResult<number> {
  if (typeof input === "number") {
    if (!Number.isFinite(input) || input <= 0) {
      return { ok: false, error: "Maximum installs must be a positive number." };
    }
    const value = Math.round(input);
    if (value > MAX_INSTALLS) {
      return { ok: false, error: `Maximum installs cannot exceed ${MAX_INSTALLS.toLocaleString("en-US")}.` };
    }
    return { ok: true, value };
  }

  if (typeof input !== "string") {
    return { ok: false, error: "Maximum installs must be a number (10K, 1M, 10000 …)." };
  }

  const text = input.trim();
  if (text.length === 0) {
    return { ok: false, error: "Maximum installs is required." };
  }

  const parsed = parseInstallCount(text);
  if (!parsed.ok || parsed.value === null || parsed.value <= 0) {
    return {
      ok: false,
      error: "Maximum installs must look like 10000, 10,000, 10K or 1M.",
    };
  }
  if (parsed.value > MAX_INSTALLS) {
    return { ok: false, error: `Maximum installs cannot exceed ${MAX_INSTALLS.toLocaleString("en-US")}.` };
  }
  return { ok: true, value: parsed.value };
}

export function validateLimit(input: unknown): ValidationResult<number> {
  const value = typeof input === "string" ? Number(input) : input;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return { ok: false, error: "Number of leads must be a number." };
  }
  const rounded = Math.round(value);
  if (rounded < 1 || rounded > MAX_LEADS) {
    return { ok: false, error: `Number of leads must be between 1 and ${MAX_LEADS}.` };
  }
  return { ok: true, value: rounded };
}
