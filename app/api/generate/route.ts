import { generateSecondaryKeywords, primeRoundOne } from "@/lib/keywords/secondary";
import { createInitialCursor, runGenerationStep } from "@/lib/playstore/crawler";
import { buildPlanQueries, planSize } from "@/lib/playstore/queryPlan";
import { allowRequest, clientIp } from "@/lib/server/rateLimit";
import { sanitizeCursor } from "@/lib/validation/cursor";
import {
  parseInstallInput,
  validateCountry,
  validateKeyword,
  validateLimit,
  validateMaxRating,
} from "@/lib/validation/input";
import type {
  GenerateRequest,
  GenerationStats,
  LeadFilters,
  SessionCursor,
} from "@/types/lead";

export const maxDuration = 300;

/** Longest step: leaves 35s of headroom below `maxDuration` for the platform. */
const DEFAULT_BUDGET_MS = 265_000;
const MIN_BUDGET_MS = 5_000;
const MAX_BUDGET_MS = 265_000;

const encoder = new TextEncoder();

function jsonError(status: number, error: string): Response {
  return Response.json({ error }, { status });
}

function resolveBudgetMs(): number {
  const raw = Number(process.env.GENERATION_BUDGET_MS);
  if (!Number.isFinite(raw)) return DEFAULT_BUDGET_MS;
  return Math.min(Math.max(raw, MIN_BUDGET_MS), MAX_BUDGET_MS);
}

type ParsedRequest =
  | { ok: true; filters: LeadFilters; cursor: SessionCursor | null }
  | { ok: false; error: string };

function parseRequest(input: unknown, fallbackCountry: string | null): ParsedRequest {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, error: "Request body must be a JSON object." };
  }
  const body = input as GenerateRequest;

  const keyword = validateKeyword(body.keyword);
  if (!keyword.ok) return { ok: false, error: keyword.error };

  const maxRating = validateMaxRating(body.maxRating);
  if (!maxRating.ok) return { ok: false, error: maxRating.error };

  const maxInstalls = parseInstallInput(body.maxInstalls);
  if (!maxInstalls.ok) return { ok: false, error: maxInstalls.error };

  const limit = validateLimit(body.limit);
  if (!limit.ok) return { ok: false, error: limit.error };

  // The country decides which storefront's ratings the table shows. Prefer the
  // form value, then Vercel's geo header, then the default.
  const country = validateCountry(body.country ?? fallbackCountry ?? undefined);
  if (!country.ok) return { ok: false, error: country.error };

  return {
    ok: true,
    filters: {
      keyword: keyword.value,
      maxRating: maxRating.value,
      maxInstalls: maxInstalls.value,
      limit: limit.value,
      country: country.value,
    },
    cursor: sanitizeCursor(body.cursor, keyword.value),
  };
}

function initialStats(cursor: SessionCursor, filters: LeadFilters): GenerationStats {
  return {
    ...cursor.counters,
    keyword: filters.keyword,
    target: filters.limit,
    queriesTotal: planSize(
      buildPlanQueries(cursor.keyword, cursor.suggestions, cursor.secondary, cursor.extraTail),
    ),
    currentQuery: null,
    phase: cursor.phase,
    wave: cursor.wave,
    elapsedMs: 0,
  };
}

export async function POST(request: Request): Promise<Response> {
  if (!allowRequest(clientIp(request))) {
    return jsonError(429, "Too many requests. Please wait a moment and try again.");
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return jsonError(400, "Request body must be valid JSON.");
  }

  // Country the requester is browsing from (Vercel sets this per request).
  const geoCountry = request.headers.get("x-vercel-ip-country");
  const parsed = parseRequest(raw, geoCountry);
  if (!parsed.ok) return jsonError(400, parsed.error);

  const { filters } = parsed;
  const cursor = parsed.cursor ?? createInitialCursor(filters.keyword);
  const budgetMs = resolveBudgetMs();

  let cancelled = false;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const send = (event: unknown): void => {
        if (cancelled) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {
          cancelled = true;
        }
      };

      // SSE comment heartbeat: keeps idle proxies and clients from declaring
      // the stream dead between generation events (a silent stretch longer
      // than their body timeout kills the connection mid-run).
      const heartbeat = setInterval(() => {
        if (cancelled || closed) return;
        try {
          controller.enqueue(encoder.encode(`: keep-alive\n\n`));
        } catch {
          cancelled = true;
        }
      }, 15_000);

      try {
        send({
          type: "progress",
          stats: initialStats(cursor, filters),
          message: `Searching Play Store for “${filters.keyword}”…`,
        });

        // Round one of the keyword-generation loop: once per run, ask Groq
        // for the search phrases that find apps in the same category
        // neighbourhood. The plan puts them right after the primary queries,
        // so this run scrapes the main keyword first and then repeats the
        // exact same filter flow over the secondary phrases. While the target
        // is still open and the plan runs dry, the crawler fires the remaining
        // rounds itself (see StepOptions.generateSecondary). A failure simply
        // leaves the list empty — the run continues with the primary plan.
        if (cursor.secondary.length === 0 && !cursor.secondaryTried) {
          send({
            type: "progress",
            stats: initialStats(cursor, filters),
            message: `Generating related search keywords for “${filters.keyword}”…`,
          });
          const roundOne = await primeRoundOne(cursor);
          if (roundOne.generated > 0) {
            send({
              type: "progress",
              stats: initialStats(cursor, filters),
              message: `Queued ${roundOne.generated} related keywords to search as well.`,
            });
          }
        }

        await runGenerationStep({
          filters,
          cursor,
          budgetMs,
          emit: send,
          aborted: () => cancelled,
          generateSecondary: generateSecondaryKeywords,
        });
      } catch (error) {
        send({
          type: "error",
          message: error instanceof Error ? error.message : "Unexpected server error.",
        });
      } finally {
        clearInterval(heartbeat);
        closed = true;
        cancelled = true;
        try {
          controller.close();
        } catch {
          // Already closed by the consumer.
        }
      }
    },
    cancel() {
      cancelled = true;
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
