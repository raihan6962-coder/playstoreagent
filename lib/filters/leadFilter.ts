import { scoreRelevance, tokenizeKeyword } from "./relevance";
import { roundRating } from "@/lib/parser/rating";
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
    rating: roundRating(app.rating),
    // `gl` pins the link to the country whose ratings the run filtered on, so
    // opening the lead shows the same numbers the table printed.
    playStoreUrl: buildPlayStoreUrl(app.packageName, "en", filters.country),
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
  } else if (roundRating(app.rating) > filters.maxRating) {
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

/**
 * Re-checks a lead that is already on screen against the filters in force.
 *
 * This is the last line of defence before a row is rendered or exported: a
 * user who tightens the ceiling between steps, or a detail-page merge that
 * changed the numbers, can never leave a lead behind that breaks the rules the
 * run is collecting under. Ratings are compared at the one-decimal precision
 * Play prints (see {@link roundRating}).
 */
export function leadPassesFilters(lead: Lead, filters: LeadFilters): boolean {
  if (lead.rating === null || roundRating(lead.rating) > filters.maxRating) return false;
  if (lead.installs === null || lead.installs > filters.maxInstalls) return false;

  const tokens = tokenizeKeyword(filters.keyword);
  const relevance = scoreRelevance(
    {
      title: lead.title,
      developer: lead.developer,
      category: lead.category,
      text: [lead.summary, lead.description].filter(Boolean).join(" "),
    },
    tokens,
  );
  return relevance.relevant;
}

/** Drops every lead that no longer satisfies the current filters. */
export function filterLeads(leads: Lead[], filters: LeadFilters): Lead[] {
  return leads.filter((lead) => leadPassesFilters(lead, filters));
}

/**
 * Checks the numeric fields of a freshly fetched detail page before it is
 * merged into a lead the user can already see.
 *
 * The detail page reports the precise rating behind the rounded search-card
 * value, so a merge can otherwise push a lead over the rating ceiling (4.03
 * behind a printed "4.0"). A missing rating no longer qualifies: the card value
 * came from whichever storefront first surfaced the app, and without a rating
 * from the run's own country there is nothing to prove the row matches what the
 * user sees on the Play Store. Only the ceilings are re-checked here: whether
 * the listing still carries the keyword is decided on the merged record, which
 * combines the search snippet that qualified the lead with the detail page's
 * own description — {@link leadPassesFilters} does that on the client.
 */
export function detailAppQualifies(app: StoreApp, filters: LeadFilters): boolean {
  if (app.rating === null) return false;
  if (roundRating(app.rating) > filters.maxRating) return false;
  if (app.installs !== null && app.installs > filters.maxInstalls) return false;
  return true;
}
