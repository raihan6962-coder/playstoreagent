import type {
  GenerationEvent,
  GenerateRequest,
  Lead,
  SessionCursor,
  StoreApp,
} from "@/types/lead";

export interface RunOptions {
  request: GenerateRequest;
  onEvent: (event: GenerationEvent) => void;
  signal?: AbortSignal;
}

/**
 * Streams one generation step from the API. Resolves with the terminal event
 * (`done` / `error`) or `null` if the stream ended without one.
 */
export async function runGeneration(options: RunOptions): Promise<GenerationEvent | null> {
  const { request, onEvent, signal } = options;

  let response: Response;
  try {
    response = await fetch("/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
      signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") return null;
    onEvent({ type: "error", message: "Could not reach the server. Check your connection." });
    return null;
  }

  if (!response.ok) {
    let message = `Request failed with status ${response.status}.`;
    try {
      const payload = (await response.json()) as { error?: string };
      if (payload?.error) message = payload.error;
    } catch {
      // Keep the status message.
    }
    const event: GenerationEvent = { type: "error", message };
    onEvent(event);
    return event;
  }

  if (!response.body) {
    const event: GenerationEvent = {
      type: "error",
      message: "Streaming is not supported by this browser.",
    };
    onEvent(event);
    return event;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let terminal: GenerationEvent | null = null;

  const handleLine = (line: string): void => {
    if (!line.startsWith("data:")) return;
    const payload = line.slice(5).trim();
    if (!payload) return;
    let event: GenerationEvent;
    try {
      event = JSON.parse(payload) as GenerationEvent;
    } catch {
      return;
    }
    onEvent(event);
    if (event.type === "done" || event.type === "error") terminal = event;
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const chunk = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      for (const line of chunk.split("\n")) handleLine(line);
      boundary = buffer.indexOf("\n\n");
    }
  }

  for (const line of buffer.split("\n")) handleLine(line);
  return terminal;
}

/** Fills fields the detail page knows about without dropping search data. */
export function mergeLead(base: Lead, patch: StoreApp): Lead {
  return {
    ...base,
    title: patch.title || base.title,
    developer: patch.developer ?? base.developer,
    rating: patch.rating ?? base.rating,
    ratingRaw: patch.ratingRaw ?? base.ratingRaw,
    ratingsCount: patch.ratingsCount ?? base.ratingsCount,
    installsRaw: patch.installsRaw ?? base.installsRaw,
    installs: patch.installs ?? base.installs,
    installsUpper: patch.installsUpper ?? base.installsUpper,
    category: patch.category ?? base.category,
    // The search snippet is what qualified the lead for the keyword; the
    // detail page's own description lands in `description` below, so the
    // merged record keeps both texts the store published for this app.
    summary: base.summary ?? patch.summary,
    description: patch.description ?? base.description,
    icon: patch.icon ?? base.icon,
    urlPath: patch.urlPath ?? base.urlPath,
  };
}

export type { SessionCursor };
