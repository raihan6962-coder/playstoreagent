/**
 * Best-effort, in-memory rate limiter. There is no database in this project by
 * design, so this protects a single warm instance rather than the whole fleet.
 * Shared by the SSE generate route and the run-control routes.
 */

const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT = 12;

const hits = new Map<string, number[]>();

export function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return request.headers.get("x-real-ip") ?? "unknown";
}

export function allowRequest(ip: string): boolean {
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((at) => now - at < RATE_WINDOW_MS);
  if (recent.length >= RATE_LIMIT) {
    hits.set(ip, recent);
    return false;
  }
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 1_000) {
    for (const [key, timestamps] of hits) {
      if (timestamps.every((at) => now - at >= RATE_WINDOW_MS)) hits.delete(key);
    }
  }
  return true;
}
