export class PlayHttpError extends Error {
  readonly status: number;
  readonly retryable: boolean;

  constructor(message: string, status: number, retryable: boolean) {
    super(message);
    this.name = "PlayHttpError";
    this.status = status;
    this.retryable = retryable;
  }
}

export class PlayTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlayTimeoutError";
  }
}

export class PlayRateLimitError extends Error {
  constructor(message = "Play Store temporarily rejected requests.") {
    super(message);
    this.name = "PlayRateLimitError";
  }
}

export class PlayParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlayParseError";
  }
}

export interface PlayClientOptions {
  timeoutMs?: number;
  retries?: number;
  /** Minimum delay between outgoing request starts. */
  intervalMs?: number;
  /** How many requests may be in flight at the same time. */
  concurrency?: number;
  userAgent?: string;
}

export interface PlayResponse {
  status: number;
  body: string;
  url: string;
}

const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Serialises request starts so we never hammer Play with parallel bursts. */
class RateGate {
  private chain: Promise<void> = Promise.resolve();
  private nextStartAt = 0;
  private readonly baseIntervalMs: number;
  private intervalMs: number;
  private rewarded = 0;

  constructor(intervalMs: number) {
    this.baseIntervalMs = intervalMs;
    this.intervalMs = intervalMs;
  }

  async wait(): Promise<void> {
    const run = this.chain.then(async () => {
      const delay = Math.max(0, this.nextStartAt - Date.now());
      if (delay > 0) await sleep(delay);
      this.nextStartAt = Date.now() + this.intervalMs;
    });
    this.chain = run.catch(() => undefined);
    return run;
  }

  /** Play pushed back: slow down, up to a ceiling. */
  penalize(): void {
    this.intervalMs = Math.min(Math.max(this.intervalMs * 2, 400), 4_000);
    this.rewarded = 0;
  }

  /** Steady success: creep back towards the configured pace. */
  reward(): void {
    this.rewarded += 1;
    if (this.rewarded < 10 || this.intervalMs <= this.baseIntervalMs) return;
    this.intervalMs = Math.max(this.baseIntervalMs, Math.round(this.intervalMs / 2));
    this.rewarded = 0;
  }
}

/** Bounds how many requests run simultaneously across all concurrent workers. */
class Semaphore {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolve) => this.waiting.push(resolve));
  }

  release(): void {
    const next = this.waiting.shift();
    if (next) next();
    else this.active -= 1;
  }
}

function looksBlocked(body: string, status: number): boolean {
  if (status === 429) return true;
  if (status === 503 && /unusual traffic|captcha|sorry/i.test(body)) return true;
  if (body.length > 0 && body.length < 4_000 && /unusual traffic|not a robot|captcha/i.test(body)) {
    return true;
  }
  return false;
}

/**
 * Small, polite HTTP client for Google Play's public web pages: timeouts,
 * bounded retries with exponential backoff, jitter, and a global start rate
 * limit so a burst of parallel requests cannot trip Play's defences.
 */
export class PlayClient {
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly userAgent: string;
  private readonly gate: RateGate;
  private readonly semaphore: Semaphore;
  private requestCount = 0;
  private rateLimitCount = 0;

  constructor(options: PlayClientOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 12_000;
    this.retries = options.retries ?? 2;
    this.userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
    this.gate = new RateGate(options.intervalMs ?? 300);
    this.semaphore = new Semaphore(Math.max(1, options.concurrency ?? 1));
  }

  get requests(): number {
    return this.requestCount;
  }

  /** How often Play pushed back with a 429/captcha during this session. */
  get rateLimitHits(): number {
    return this.rateLimitCount;
  }

  async get(url: string, extraHeaders: Record<string, string> = {}): Promise<PlayResponse> {
    return this.send("GET", url, undefined, extraHeaders);
  }

  async postForm(
    url: string,
    body: string,
    extraHeaders: Record<string, string> = {},
  ): Promise<PlayResponse> {
    return this.send("POST", url, body, {
      "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
      ...extraHeaders,
    });
  }

  private async send(
    method: "GET" | "POST",
    url: string,
    body?: string,
    extraHeaders: Record<string, string> = {},
  ): Promise<PlayResponse> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= this.retries; attempt += 1) {
      if (attempt > 0) {
        const backoff =
          lastError instanceof PlayRateLimitError
            ? 1_500 * attempt
            : 400 * 2 ** (attempt - 1) + Math.floor(Math.random() * 250);
        await sleep(Math.min(backoff, 8_000));
      }

      await this.semaphore.acquire();
      try {
        await this.gate.wait();
        this.requestCount += 1;

        let response: Response;
        let text: string;
        try {
          const controller = new AbortController();
          // The timer must cover the body read too: a throttled Play
          // connection that sends headers and then stalls the payload would
          // otherwise block `response.text()` forever, holding its semaphore
          // slot until every window deadlocks (measured: one step hung for
          // 13 minutes this way). Aborting after headers destroys the body
          // stream, so `text()` rejects instead of waiting on a dead socket.
          const timer = setTimeout(() => controller.abort(), this.timeoutMs);
          try {
            response = await fetch(url, {
              method,
              redirect: "follow",
              signal: controller.signal,
              body,
              headers: {
                "user-agent": this.userAgent,
                "accept-language": "en-US,en;q=0.9",
                accept:
                  "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                ...extraHeaders,
              },
            });
            text = await response.text();
          } finally {
            clearTimeout(timer);
          }
        } catch (error) {
          if (error instanceof Error && error.name === "AbortError") {
            lastError = new PlayTimeoutError("Timed out while contacting the Play Store.");
            continue;
          }
          lastError =
            error instanceof Error
              ? new PlayHttpError(error.message, 0, true)
              : new PlayHttpError("Unknown network error.", 0, true);
          continue;
        }

        const status = response.status;

        if (status === 429 || looksBlocked(text, status)) {
          this.rateLimitCount += 1;
          this.gate.penalize();
          lastError = new PlayRateLimitError();
          continue;
        }

        if (RETRYABLE_STATUSES.has(status)) {
          lastError = new PlayHttpError(`Play Store responded with ${status}.`, status, true);
          continue;
        }

        if (status >= 400) {
          throw new PlayHttpError(`Play Store responded with ${status}.`, status, false);
        }

        if (text.length === 0) {
          lastError = new PlayHttpError("Empty response from Play Store.", status, true);
          continue;
        }

        this.gate.reward();
        return { status, body: text, url };
      } catch (error) {
        if (error instanceof PlayHttpError && !error.retryable) throw error;

        lastError =
          error instanceof Error
            ? new PlayHttpError(error.message, 0, true)
            : new PlayHttpError("Unknown network error.", 0, true);
      } finally {
        this.semaphore.release();
      }
    }

    if (lastError instanceof PlayRateLimitError) throw lastError;
    if (lastError instanceof PlayTimeoutError) throw lastError;
    if (lastError) throw lastError;
    throw new PlayHttpError("Request failed.", 0, true);
  }

  async getHtml(
    url: string,
    validate: (body: string) => boolean,
    parseErrorMessage: string,
  ): Promise<PlayResponse> {
    const response = await this.get(url);
    if (!validate(response.body)) {
      throw new PlayParseError(parseErrorMessage);
    }
    return response;
  }
}
