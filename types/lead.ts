export interface StoreApp {
  packageName: string;
  title: string;
  developer: string | null;
  rating: number | null;
  ratingRaw: string | null;
  ratingsCount: number | null;
  installsRaw: string | null;
  installs: number | null;
  installsUpper: number | null;
  category: string | null;
  summary: string | null;
  description: string | null;
  icon: string | null;
  urlPath: string | null;
}

export type InstallCertainty = "exact" | "bucket" | "unknown";

export interface Lead extends StoreApp {
  playStoreUrl: string;
  keyword: string;
  relevanceScore: number;
  relevanceTerms: string[];
  installCertainty: InstallCertainty;
}

export interface LeadFilters {
  keyword: string;
  maxRating: number;
  maxInstalls: number;
  limit: number;
  /**
   * Two-letter Play Store country whose ratings, links and detail pages the
   * run must use. The same app carries different ratings per storefront
   * (measured: 2.1 US / 2.2 BD / 4.5 KR for one app), so every number the
   * table shows has to come from this one country to match what the user
   * sees on play.google.com.
   */
  country: string;
}

export type SessionPhase = "suggest" | "search" | "expand" | "enrich" | "done";

export type PriceFilter = "all" | "free" | "paid";

export type QueryKind =
  | "primary"
  | "suggestion"
  | "variant"
  | "token"
  | "modifier"
  | "locale"
  | "price";

export interface QueryPlanEntry {
  query: string;
  hl: string;
  gl: string;
  price?: PriceFilter;
  kind: QueryKind;
}

export interface SimilarSeed {
  p: string;
  i: number | null;
}

export interface SessionCounters {
  discovered: number;
  evaluated: number;
  matched: number;
  duplicates: number;
  queriesRun: number;
  pagesFetched: number;
  requests: number;
  /** Play 429 / block responses seen across the session (diagnostics). */
  rateLimitHits: number;
  lowestRatingSeen: number | null;
}

export interface GenerationStats extends SessionCounters {
  keyword: string;
  target: number;
  queriesTotal: number;
  currentQuery: string | null;
  phase: SessionPhase;
  /** Extra query waves appended so far (0 = the base plan). */
  wave: number;
  elapsedMs: number;
}

export interface SessionCursor {
  /** Keyword the session was started for; guards against mismatched resumes. */
  keyword: string;
  /**
   * Play suggest queries discovered so far. The full search plan is rebuilt
   * from these on every step, which keeps the cursor small enough to round
   * trip through the browser on every resume.
   */
  suggestions: string[];
  /** Position in the deterministic suggest-prefix queue. */
  suggestIndex: number;
  /** Index into the query × storefront cross product (see queryPlan.ts). */
  planIndex: number;
  /**
   * How many extra query waves have been appended to the plan. The session
   * keeps generating until the lead limit is hit: when the base plan runs
   * out, the next wave appends fresh long-tail queries (appended, never
   * reordered, so `planIndex` stays valid across resumes).
   */
  wave: number;
  /** `discovered` count when the current wave started (stagnation guard). */
  waveDiscovered: number;
  phase: SessionPhase;
  /** Package names already evaluated (dedupe + resume bookkeeping). */
  seen: string[];
  /** Leads already counted towards the target (guards against double counting). */
  emitted: string[];
  /** Relevant apps whose "similar apps" have not been expanded yet. */
  similarQueue: SimilarSeed[];
  /** Packages whose detail page has already been used for expansion. */
  expanded: string[];
  /** Confirmed leads that still need a ratings count from their detail page. */
  enrichQueue: string[];
  counters: SessionCounters;
}

export type DoneReason =
  | "target-reached"
  | "plan-exhausted"
  | "budget-exhausted"
  | "no-results"
  | "rate-limited"
  | "failed";

export type GenerationEvent =
  | { type: "progress"; stats: GenerationStats; message: string }
  | { type: "lead"; lead: Lead; stats: GenerationStats }
  | { type: "lead-update"; app: StoreApp }
  /** The detail page no longer satisfies the filters; drop the lead. */
  | { type: "lead-remove"; packageName: string }
  | { type: "warning"; message: string }
  | {
      type: "done";
      reason: DoneReason;
      message: string;
      stats: GenerationStats;
      cursor: SessionCursor | null;
    }
  | { type: "error"; message: string };

export interface GenerateRequest {
  keyword: string;
  maxRating: number;
  maxInstalls: number;
  limit: number;
  /** Two-letter Play Store country; defaults to the requester's region. */
  country?: string;
  cursor?: SessionCursor | null;
}
