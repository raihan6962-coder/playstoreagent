import { scoreRelevance, tokenizeKeyword } from "./relevance";
import type { InstallCertainty, Lead, LeadFilters, StoreApp } from "@/types/lead";

export type RejectReason =
  | "missing-rating"
  | "rating-too-high"
  | "missing-installs"
  | "unparseable-installs"
  | "installs-too-high"
  | "not-relevant"
  | "duplicate";

export type EvaluationStatus = "match" | "reject" | "uncertain";

export interface Evaluation {
  status: EvaluationStatus;
  reasons: RejectReason[];
  lead: Lead | null;
}

export const PLAY_BASE_URL = "https://play.google.com";

export function buildPlayStoreUrl(packageName: string, hl = "en", gl = "US"): string {
  return `${PLAY_BASE_URL}/store/apps/details?id=${encodeURIComponent(packageName)}&hl=${hl}&gl=${gl}`;
}

export function toLead(app: StoreApp, filters: LeadFilters): Lead {
  const tokens = tokenizeKeyword(filters.keyword);
  const relevance = scoreRelevance(
    {
      title: app.title,
      developer: app.developer,
      category: app.category,
      text: [app.summary, app.description].filter(Boolean).join(" "),
    },
    tokens,
  );

  const installCertainty: InstallCertainty =
    app.installs === null
      ? "unknown"
      : (app.installsRaw ?? "").includes("+")
        ? "bucket"
        : "exact";

  return {
    ...app,
    playStoreUrl: buildPlayStoreUrl(app.packageName),
    keyword: filters.keyword,
    relevanceScore: relevance.score,
    relevanceTerms: relevance.matchedTerms,
    installCertainty,
  };
}

/**
 * Applies the qualification rules:
 *   rating <= maxRating AND installs <= maxInstalls AND keyword relevance.
 *
 * Missing rating, missing installs and unparseable install values never
 * qualify as a confirmed lead.
 */
export function evaluateApp(
  app: StoreApp,
  filters: LeadFilters,
  seen: ReadonlySet<string>,
): Evaluation {
  const reasons: RejectReason[] = [];

  if (seen.has(app.packageName)) {
    return { status: "reject", reasons: ["duplicate"], lead: null };
  }

  const tokens = tokenizeKeyword(filters.keyword);
  const relevance = scoreRelevance(
    {
      title: app.title,
      developer: app.developer,
      category: app.category,
      text: [app.summary, app.description].filter(Boolean).join(" "),
    },
    tokens,
  );

  if (!relevance.relevant) {
    reasons.push("not-relevant");
  }

  if (app.rating === null) {
    reasons.push("missing-rating");
  } else if (app.rating > filters.maxRating) {
    reasons.push("rating-too-high");
  }

  let status: EvaluationStatus = reasons.length === 0 ? "match" : "reject";

  if (app.installs === null) {
    if (app.installsRaw && app.installsRaw.trim().length > 0) {
      reasons.push("unparseable-installs");
      if (status === "match") status = "uncertain";
    } else {
      reasons.push("missing-installs");
      status = "reject";
    }
  } else if (app.installs > filters.maxInstalls) {
    reasons.push("installs-too-high");
    status = "reject";
  }

  if (reasons.length > 0 && status === "match") status = "reject";

  if (status === "match") {
    return { status: "match", reasons: [], lead: toLead(app, filters) };
  }

  return { status, reasons, lead: null };
}
