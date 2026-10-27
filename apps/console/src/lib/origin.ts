// Origin checks, CORS headers and rate limiting for the public widget routes. Kept free of
// framework and database imports so it can be unit-tested on its own.

export function normaliseOrigin(value: string): string | undefined {
  try {
    const u = new URL(value);
    return u.protocol === "https:" || u.protocol === "http:" ? u.origin : undefined;
  } catch {
    return undefined;
  }
}

// Exact origin match (scheme + host + port) against the deployment's domains.
export function isAllowedOrigin(origin: string | null, domains: string[]): origin is string {
  const o = origin && origin !== "null" ? normaliseOrigin(origin) : undefined;
  return !!o && o === origin && domains.some((d) => normaliseOrigin(d) === o);
}

export function corsHeaders(origin: string): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };
}

// Behind a reverse proxy, the first X-Forwarded-For entry is the visitor. Configure the
// proxy to overwrite (not append to) this header, or visitors can choose their own key.
export function clientIp(headers: Headers): string {
  return headers.get("x-forwarded-for")?.split(",")[0]?.trim() || headers.get("x-real-ip") || "unknown";
}

// Fixed-window limiter, per server process. Enough for one instance; a multi-instance
// deployment needs a shared store (Postgres or Redis).
export class RateLimiter {
  readonly #windows = new Map<string, { start: number; count: number }>();
  readonly #max: number;
  readonly #windowMs: number;
  readonly #now: () => number;

  constructor(max: number, windowMs: number, now: () => number = Date.now) {
    this.#max = max;
    this.#windowMs = windowMs;
    this.#now = now;
  }

  allow(key: string): boolean {
    const now = this.#now();
    const w = this.#windows.get(key);
    if (!w || now - w.start >= this.#windowMs) {
      this.#windows.set(key, { start: now, count: 1 });
      if (this.#windows.size > 10_000) this.#sweep(now);
      return true;
    }
    w.count += 1;
    return w.count <= this.#max;
  }

  #sweep(now: number) {
    for (const [k, v] of this.#windows) if (now - v.start >= this.#windowMs) this.#windows.delete(k);
  }
}
