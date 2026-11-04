// Per-host pacing for page loads. A site that answers 429 (or 503) is loaded one page at a time
// from then on, a gap apart, and the page is tried again after its Retry-After (round 6: HMS
// Networks rate-limited the sync's batches, loaded side by side with no pause, and 60 of 88 pages
// failed "The site answered 429"). A wait longer than maxWaitMs isn't waited out here: the page
// comes back rate-limited, and the sync tries it again on a later run. Hosts that never rate-limit
// are loaded as fast as before.

const RATE_LIMITED = new Set([429, 503]);

interface HostState {
  // The gap between loads once the host rate-limited (0: not paced), and when the next may start.
  gap: number;
  next: number;
  gate: Promise<void>;
  // When it last rate-limited: loads already under way when it did don't widen the gap again.
  limitedAt: number;
}

export interface PaceOptions {
  maxWaitMs?: number;
  minGapMs?: number;
  maxGapMs?: number;
  // The default pause after a 429 without a Retry-After.
  pauseMs?: number;
  tries?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export type PacedResult<T> = { result: T; tries: number; rateLimited: boolean } | { skipped: true; retryAfterMs: number };

export class HostPacer {
  private readonly hosts = new Map<string, HostState>();
  private readonly opts: Required<PaceOptions>;

  constructor(opts: PaceOptions = {}) {
    this.opts = {
      maxWaitMs: 15_000,
      minGapMs: 600,
      maxGapMs: 5_000,
      pauseMs: 2_000,
      tries: 3,
      now: Date.now,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      ...opts,
    };
  }

  private state(url: string): HostState {
    const host = new URL(url).hostname.replace(/^www\./, "").toLowerCase();
    let st = this.hosts.get(host);
    if (!st) {
      st = { gap: 0, next: 0, gate: Promise.resolve(), limitedAt: 0 };
      this.hosts.set(host, st);
    }
    return st;
  }

  // Whether a host is being paced now (it rate-limited recently).
  paced(url: string): boolean {
    return this.state(url).gap > 0;
  }

  // Loads url with load(), paced per host. retryAfterMs on the result: the site's Retry-After.
  async run<T extends { status: number; retryAfterMs?: number }>(url: string, load: () => Promise<T>): Promise<PacedResult<T>> {
    const { now, sleep } = this.opts;
    const st = this.state(url);
    let limited = false;
    for (let attempt = 1; ; attempt++) {
      let result: T;
      let sent = now();
      if (st.gap === 0 && st.next <= now()) result = await load();
      else {
        // One at a time per paced host, each a gap after the last.
        const before = st.gate;
        let release = () => {};
        st.gate = new Promise((resolve) => {
          release = resolve;
        });
        await before;
        try {
          const wait = st.next - now();
          if (wait > this.opts.maxWaitMs) return { skipped: true, retryAfterMs: wait };
          if (wait > 0) await sleep(wait);
          sent = now();
          result = await load();
        } finally {
          st.next = Math.max(st.next, now() + st.gap);
          release();
        }
      }
      if (!RATE_LIMITED.has(result.status)) {
        // The site lets loads through again: the gap shrinks slowly, back to unpaced.
        if (st.gap > 0) st.gap = Math.max(0, st.gap - 25);
        return { result, tries: attempt, rateLimited: limited };
      }
      limited = true;
      // Widened once per rate limit: loads sent before the last one was known don't widen it again.
      if (sent >= st.limitedAt) st.gap = Math.min(this.opts.maxGapMs, Math.max(this.opts.minGapMs, st.gap * 2));
      st.limitedAt = now();
      const pause = result.retryAfterMs ?? this.opts.pauseMs * attempt;
      st.next = Math.max(st.next, now() + pause);
      if (attempt >= this.opts.tries || pause > this.opts.maxWaitMs) return { result, tries: attempt, rateLimited: true };
    }
  }
}

// What a load's error says when the site gave no answer, and what a page not tried comes back with
// (the console's lib/site-refusal.ts reads both).
export const NO_ANSWER = /net::ERR_(?:CONNECTION_|TIMED_OUT|EMPTY_RESPONSE|SOCKET_|NETWORK_|ADDRESS_UNREACHABLE)|Timeout \d+ms exceeded/;
export const NOT_TRIED = "Not tried: the site had stopped answering.";

// Hosts whose last loads got no answer: at STOP_AFTER in a row, none is tried until a minute after the
// last. Loads under way when it stops finish, and any answer starts the count again.
const STOP_AFTER = 6;
const QUIET_MS = 60_000;
export class SilentHosts {
  private readonly hosts = new Map<string, { row: number; last: number }>();
  private readonly now: () => number;
  constructor(now: () => number = Date.now) {
    this.now = now;
  }
  private key = (url: string) => new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  stopped(url: string): boolean {
    const host = this.hosts.get(this.key(url));
    if (!host || host.row < STOP_AFTER) return false;
    if (this.now() - host.last < QUIET_MS) return true;
    this.hosts.delete(this.key(url));
    return false;
  }
  noAnswer(url: string): void {
    const key = this.key(url);
    this.hosts.set(key, { row: (this.hosts.get(key)?.row ?? 0) + 1, last: this.now() });
  }
  answered(url: string): void {
    this.hosts.delete(this.key(url));
  }
}
