// A site that stops answering the reader partway through a sync (round 7: servicetitan.com loaded
// about 40 pages, then 166 of 200 failed with raw timeouts, and the header said "Synced, some pages
// failed"). When most recent loads are timeouts, connection errors or 403s, one sentence says so, the
// site is paused and read more slowly after it, and Review asks for a decision by name about what's
// missing. A slow site that still answers most loads isn't paused. Pure: the worker keeps the watch
// and the console reads the sentence from sync_sources.lastError. (No "@/": the worker imports this.)

// What the browser and the sniffer's own stop (NOT_TRIED in its pace.ts) say when a site doesn't answer.
// A page still waiting when the sync stopped reading the site.
export const NOT_READ = "Not tried: the site stopped answering, so the sync stopped there.";
const NO_ANSWER =
  /net::ERR_(?:CONNECTION_|TIMED_OUT|EMPTY_RESPONSE|SOCKET_|NETWORK_|ADDRESS_UNREACHABLE)|Timeout \d+ms exceeded|ECONNRE|ETIMEDOUT|Not tried: /;
// The same, for a stored page's detail, in Postgres's regular expressions.
export const NO_ANSWER_SQL =
  "net::ERR_(CONNECTION_|TIMED_OUT|EMPTY_RESPONSE|SOCKET_|NETWORK_|ADDRESS_UNREACHABLE)|Timeout [0-9]+ms exceeded|ECONNRE|ETIMEDOUT|Not tried: ";

export const noAnswer = (error: string | null | undefined): boolean => Boolean(error && NO_ANSWER.test(error));
// A page the sniffer didn't try, because the host's last loads got no answer.
export const notTried = (error: string | null | undefined): boolean => Boolean(error?.startsWith("Not tried: "));
// A load the site refused: no answer, or a status that says no to the reader (checkpoint 8: beckhoff.com
// went to 405 on every page). A 404 is a page that's gone, and a 429 or 503 is paced on its own: pace.ts
// in the sniffer.
export const REFUSED_STATUS = [401, 403, 405, 406, 451];
export const refusedLoad = (page: { error?: string | undefined; status: number }): boolean =>
  noAnswer(page.error) || REFUSED_STATUS.includes(page.status);

// Of the last WINDOW loads, this many refused: a site refusing. After a pause, the first PROBE loads
// all refused: still refusing. Pauses, then it stops and waits for a person.
const WINDOW = 10;
const REFUSED = 8;
const PROBE = 3;
export const PAUSES_MS = [5 * 60_000, 15 * 60_000];
// Pages a run for a site that refused, once its pause is over.
export const REFUSED_PAGES = 3;

export interface LoadWatch {
  loaded: number;
  recent: boolean[];
  pauses: number;
  at: number;
  // The last run alone showed a refusal.
  run?: boolean;
}

// The watch after a run's loads, in the order they were asked for. refused: one per load. A run's
// batches load side by side, so its last loads asked for aren't its last loads made (checkpoint 8: 20
// pages, then 37 refused, and fewer than 8 of the last 10 asked for): a run also shows a refusal by
// itself, when most of it was refused or the sniffer stopped trying the host (silent).
export function watchLoads(watch: LoadWatch | undefined, refused: readonly boolean[], now: number, silent = false): LoadWatch {
  const recent = [...(watch?.recent ?? []), ...refused].slice(-WINDOW);
  const said = refused.filter(Boolean).length;
  return {
    loaded: (watch?.loaded ?? 0) + refused.length - said,
    recent,
    run: said >= REFUSED && (silent || said * 2 > refused.length),
    // A full window of pages: it's over, and the next refusal starts from the top.
    pauses: recent.length === WINDOW && !recent.some(Boolean) ? 0 : (watch?.pauses ?? 0),
    at: now,
  };
}

export function isRefusing(watch: LoadWatch): boolean {
  if (watch.pauses) return watch.recent.length >= PROBE && watch.recent.slice(-PROBE).every(Boolean);
  return watch.run === true || watch.recent.filter(Boolean).length >= REFUSED;
}

// What to do about a host after a run: pause it until `until`, stop reading it, go on slowly because
// it answers again after a pause, or carry on. The watch it returns starts its next window.
export type RefusalStep =
  | { kind: "pause"; until: number; watch: LoadWatch }
  | { kind: "stop"; watch: LoadWatch }
  | { kind: "slow"; watch: LoadWatch }
  | { kind: "none"; watch: LoadWatch };
export function refusalStep(watch: LoadWatch, now: number): RefusalStep {
  if (!isRefusing(watch)) return { kind: watch.pauses ? "slow" : "none", watch };
  const pause = PAUSES_MS[watch.pauses];
  const next = { ...watch, recent: [], run: false, pauses: watch.pauses + 1 };
  return pause === undefined ? { kind: "stop", watch: next } : { kind: "pause", until: now + pause, watch: next };
}

// ---- the sentence ----

export const REFUSAL_WORDS = "stopped answering our reader";
export const isRefusalNote = (note: string | null | undefined): boolean => Boolean(note?.includes(REFUSAL_WORDS));

const afterPages = (loaded: number) => (loaded >= 5 ? ` after about ${loaded >= 20 ? Math.round(loaded / 10) * 10 : loaded} pages` : "");
const clock = (at: number) => `${new Date(at).toISOString().slice(11, 16)} UTC`;
const ASK = `ask the client's web team to allow the crawler (its user agent starts "LaunchpadSniffer")`;

export const refusalNote = (host: string, loaded: number, step: { kind: "pause"; until: number } | { kind: "slow" | "stop" }): string => {
  const said = `${host} ${REFUSAL_WORDS}${afterPages(loaded)}`;
  switch (step.kind) {
    case "pause":
      return `${said}. It may be limiting us, so the sync is paused and tries again, more slowly, at ${clock(step.until)}; if it keeps happening, ${ASK}.`;
    case "slow":
      return `${said}, so the sync goes on slowly, a few pages a minute.`;
    default:
      return `${said} and didn't start again, so the sync stopped there: ${ASK}, then retry the failed pages.`;
  }
};

// The note for a person's Retry, from the one standing: its host and page count stay.
export const retryNote = (note: string): string =>
  note.replace(
    new RegExp(`(${REFUSAL_WORDS}(?: after about \\d+ pages)?).*$`, "s"),
    "$1, so the retry goes slowly, after any pause still running: a few pages a minute.",
  );

// ---- what a person reads ----

// A stored failure as plain words, with the browser's raw error kept for a details control. Pure.
export const GONE = /^The site answered 4(?:04|10)\.$/;
export function pageProblem(detail: string | null | undefined): { words: string; raw?: string } | undefined {
  if (!detail) return undefined;
  if (noAnswer(detail)) return { words: "The site didn't answer when we read this page.", raw: detail };
  return { words: GONE.test(detail) ? `This page is gone: ${detail.replace(/^The/, "the")}` : detail };
}

// The Content panel's heading for a finished sync: pages that are simply gone aren't a failure, and
// "some pages failed" is kept for what a person can act on. undefined: the usual words for the status.
export function syncHeadline(
  status: string | null | undefined,
  facts: { failed: number; gone: number; answerable: number; total: number; note?: string | null },
): ["good" | "warning", string] | undefined {
  if (isRefusalNote(facts.note) && (status === "running" || status === "partial")) {
    return ["warning", status === "running" ? "Syncing slowly: the site stopped answering" : "Synced, but the site stopped answering"];
  }
  if (status === "partial" && facts.failed > 0 && facts.gone === facts.failed) {
    return [
      "good",
      `Synced: ${facts.answerable} of ${facts.total} pages answerable, ${facts.gone} ${facts.gone === 1 ? "page" : "pages"} gone (404)`,
    ];
  }
  return undefined;
}

// Whether what's missing needs a decision on Review: a key page, the site refusing, or enough pages
// to matter. One timeout among fifty doesn't ask.
export const missingNeedsDecision = (m: { missing: number; planned: number; keys: readonly unknown[]; refused: boolean }): boolean =>
  m.missing > 0 && (m.refused || m.keys.length > 0 || m.missing >= Math.max(5, Math.ceil(m.planned / 10)));
