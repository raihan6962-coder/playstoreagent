import { after } from "next/server";
import {
  createRun,
  kickTick,
  storeErrorResponse,
} from "@/lib/server/runs";
import { allowRequest, clientIp } from "@/lib/server/rateLimit";
import {
  parseInstallInput,
  validateCountry,
  validateKeyword,
  validateLimit,
  validateMaxRating,
} from "@/lib/validation/input";
import type { CreateRunResponse } from "@/types/run";

export const maxDuration = 60;

function jsonError(status: number, error: string): Response {
  return Response.json({ error }, { status });
}

/**
 * Create a run and kick its first tick. The response returns immediately;
 * the whole search then runs server-side, chained tick to tick, so closing
 * the browser does not stop it — the client only polls the snapshot route.
 */
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
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return jsonError(400, "Request body must be a JSON object.");
  }
  const body = raw as Record<string, unknown>;

  const keyword = validateKeyword(body.keyword as string);
  if (!keyword.ok) return jsonError(400, keyword.error);
  const maxRating = validateMaxRating(body.maxRating as number);
  if (!maxRating.ok) return jsonError(400, maxRating.error);
  const maxInstalls = parseInstallInput(body.maxInstalls as number | string);
  if (!maxInstalls.ok) return jsonError(400, maxInstalls.error);
  const limit = validateLimit(body.limit as number);
  if (!limit.ok) return jsonError(400, limit.error);
  // The form has no country field: Vercel's geo header decides the
  // storefront, falling back to the default.
  const geoCountry = request.headers.get("x-vercel-ip-country");
  const country = validateCountry(geoCountry ?? undefined);
  if (!country.ok) return jsonError(400, country.error);

  try {
    const created = await createRun({
      keyword: keyword.value,
      maxRating: maxRating.value,
      maxInstalls: maxInstalls.value,
      limit: limit.value,
      country: country.value,
    });
    const origin = new URL(request.url).origin;
    after(() => kickTick(origin, created.runId, created.token));
    const payload: CreateRunResponse = { ok: true, runId: created.runId, token: created.token };
    return Response.json(payload, { status: 201 });
  } catch (error) {
    return storeErrorResponse(error) ?? jsonError(500, "Could not create the run.");
  }
}
