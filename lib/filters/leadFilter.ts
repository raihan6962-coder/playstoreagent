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
  /**
   * Significant keyword terms found in the app's card text. Empty on
   * duplicates. Lets the crawler tell a partial hit (worth one detail-page
   * fetch — the description may carry the missing term) from no hit at all.
   */
  matchedTerms: string[];
  /**
   * The subset of {@link matchedTerms} found in the title or description.
   * The crawler only queues a *partial* hit for a detail fetch when it comes
   * from here: developer- and category-only hits proved unable to complete
   * into a match (the detail re-check reads title + description only), so
   * they would burn a request on a rejection the card already predicted.
   */
  primaryTerms: string[];
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
    email: app.email ?? null,
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
    return { status: "reject", reasons: ["duplicate"], lead: null, matchedTerms: [], primaryTerms: [] };
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
    return {
      status: "match",
      reasons: [],
      lead: toLead(app, filters),
      matchedTerms: relevance.matchedTerms,
      primaryTerms: relevance.primaryTerms,
    };
  }

  return { status, reasons, lead: null, matchedTerms: relevance.matchedTerms, primaryTerms: relevance.primaryTerms };
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

/**
 * Slack a **foreign** storefront's printed rating gets before the crawler
 * stops spending a detail fetch on it.
 *
 * Negative by half a star. Measured live (research R9): at a 4.0 ceiling,
 * foreign cards printed 3.6–4.0 passed 0 of 2 verifications at home, cards
 * printed 3.1–3.5 passed 1 of 2, and home-storefront cards passed 2 of 2 —
 * home storefronts rate these apps *higher* than foreign ones, so a foreign
 * card printed just under the ceiling is a near-certain miss. Only cards at
 * or below `maxRating - 0.5` earn a foreign fetch; home cards (final
 * storefront) keep the full ceiling.
 */
export const FOREIGN_RATING_WINDOW = -0.5;

/**
 * Decides whether fetching this card's detail page could still change its
 * verdict. `countryFinal` means the card already shows the run's own
 * storefront: its rating is final, and anything above the ceiling can only be
 * repeated by the detail page. Foreign cards must sit a half-star **below**
 * the ceiling ({@link FOREIGN_RATING_WINDOW} is negative) because home
 * storefronts rate the same apps higher (research R9). Install buckets are
 * global (Play prints the same bucket everywhere), so an over-cap bucket is
 * always final.
 */
export function cardCanStillQualify(
  app: Pick<StoreApp, "rating" | "installs">,
  filters: LeadFilters,
  countryFinal: boolean,
): boolean {
  if (app.installs !== null && app.installs > filters.maxInstalls) return false;
  if (app.rating !== null) {
    const printed = roundRating(app.rating);
    const ceiling = countryFinal ? filters.maxRating : filters.maxRating + FOREIGN_RATING_WINDOW;
    if (printed > ceiling) return false;
  }
  return true;
}
