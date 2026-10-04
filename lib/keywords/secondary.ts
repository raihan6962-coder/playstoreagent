/**
 * Secondary-keyword generation for the lead pipeline.
 *
 * Phase one scrapes Play with the user's main keyword. Phase two asks an LLM
 * (Groq) for the search phrases a user would type to find apps in the same
 * category neighbourhood, and the crawler runs the exact same scrape → filter
 * → verify flow over those phrases as well. One run therefore covers the main
 * keyword first and the AI-generated phrases afterwards, because
 * {@link buildPlanQueries} appends them after the primary queries.
 *
 * Every failure mode (no API key, timeout, non-2xx, unparseable body) returns
 * an empty list: a keyword-generation hiccup must never fail a run, the run
 * simply continues with the primary plan.
 */

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const MODEL = "openai/gpt-oss-120b";

/** Hard cap on how many secondary phrases one run may add to the plan. */
export const MAX_SECONDARY = 100;
/** Per-phrase length cap (matches the suggestion length budget in cursor.ts). */
export const MAX_SECONDARY_LENGTH = 80;

function promptFor(keyword: string): string {
  return [
    `You are an app-marketplace keyword planner.`,
    `The main search keyword is: "${keyword}".`,
    `List ${MAX_SECONDARY} distinct search phrases a Play Store user would type to find apps in the same app category or product neighbourhood as this keyword.`,
    `Prefer niche long-tail phrases over the main keyword: specific features, use cases, adjectives and platforms (for example "offline budget tracker", "budget tracker for students", "tiny expense tracker").`,
    `Each phrase must be 1-4 words, plain search-box style, no quotes, no punctuation, and must not be the main keyword itself.`,
    `Return ONLY a JSON array of strings, nothing else.`,
  ].join(" ");
}

/** Best-effort extraction of the first JSON array inside a model response. */
function parseArray(text: string): string[] {
  const unfenced = text.replace(/```(?:json)?/gi, "");
  const start = unfenced.indexOf("[");
  const end = unfenced.lastIndexOf("]");
  if (start === -1 || end <= start) return [];
  const parsed: unknown = JSON.parse(unfenced.slice(start, end + 1));
  return Array.isArray(parsed) ? parsed : [];
}

/**
 * Normalises whatever the model returned: strings only, trimmed, length
 * bounds, deduplicated (case-insensitive) and the main keyword excluded so it
 * never duplicates a primary query.
 */
export function normalizeSecondary(raw: string[], keyword: string): string[] {
  const own = keyword.trim().toLowerCase();
  const seen = new Set<string>([own]);
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const phrase = item.trim().replace(/\s+/g, " ");
    if (phrase.length < 2 || phrase.length > MAX_SECONDARY_LENGTH) continue;
    const key = phrase.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(phrase);
    if (out.length >= MAX_SECONDARY) break;
  }
  return out;
}

/**
 * Asks Groq for secondary search phrases related to `keyword`.
 * Resolves to `[]` on any error — never rejects.
 */
export async function generateSecondaryKeywords(keyword: string): Promise<string[]> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey || apiKey.length === 0) return [];

  try {
    const response = await fetch(GROQ_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: "user", content: promptFor(keyword) }],
        temperature: 0.4,
        max_completion_tokens: 6000,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return [];

    const body = (await response.json()) as {
      choices?: Array<{ message?: { content?: unknown } }>;
    };
    const content = body.choices?.[0]?.message?.content;
    if (typeof content !== "string" || content.length === 0) return [];

    return normalizeSecondary(parseArray(content), keyword);
  } catch {
    return [];
  }
}
