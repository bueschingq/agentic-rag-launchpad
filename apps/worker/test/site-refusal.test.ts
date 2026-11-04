// A site that stops answering partway through a sync is named, paused and read more slowly, and
// Review asks for a decision by name (round 7: servicetitan.com, 166 of 200 pages with raw timeouts).

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { missingPagesLine, reviewLines } from "../../console/src/lib/review.ts";
import {
  GONE,
  isRefusalNote,
  isRefusing,
  type LoadWatch,
  missingNeedsDecision,
  noAnswer,
  pageProblem,
  REFUSED_PAGES,
  refusalNote,
  refusalStep,
  refusedLoad,
  retryNote,
  syncHeadline,
  watchLoads,
} from "../../console/src/lib/site-refusal.ts";
import { SilentHosts } from "../../sniffer/src/pace.ts";
import { pacedSelection } from "../src/jobs/content.ts";

const T0 = Date.parse("2026-11-03T14:00:00Z");
const TIMEOUT = "page.goto: net::ERR_CONNECTION_TIMED_OUT at https://www.x.example/a";
const load = (watch: LoadWatch | undefined, refused: boolean[]) => watchLoads(watch, refused, T0);
const ok = (n: number) => Array.from({ length: n }, () => false);
const no = (n: number) => Array.from({ length: n }, () => true);

describe("what counts as a refusal", () => {
  it("timeouts, connection errors and 403s; never a 404, a 200 or a script error", () => {
    assert.equal(refusedLoad({ error: TIMEOUT, status: 0 }), true);
    assert.equal(refusedLoad({ error: "page.goto: Timeout 20000ms exceeded.", status: 0 }), true);
    assert.equal(refusedLoad({ error: "page.goto: net::ERR_CONNECTION_RESET at u", status: 0 }), true);
    assert.equal(refusedLoad({ error: "page.goto: net::ERR_EMPTY_RESPONSE at u", status: 0 }), true);
    assert.equal(refusedLoad({ status: 403 }), true);
    assert.equal(refusedLoad({ status: 404 }), false);
    assert.equal(refusedLoad({ status: 200 }), false);
    assert.equal(refusedLoad({ error: "page.evaluate: TypeError: x", status: 0 }), false);
  });
});

describe("the watch on a host's loads", () => {
  it("names a site that turns from pages into timeouts", () => {
    const step = refusalStep(load(load(undefined, ok(40)), no(9)), T0);
    assert.equal(step.kind, "pause");
    assert.ok(step.kind === "pause");
    assert.equal(step.until, T0 + 5 * 60_000);
    const note = refusalNote("www.x.example", step.watch.loaded, step);
    assert.equal(isRefusalNote(note), true);
    assert.match(note, /^www\.x\.example stopped answering our reader after about 40 pages\. It may be limiting us/);
    assert.match(note, /tries again, more slowly, at 14:05 UTC/);
    assert.match(note, /LaunchpadSniffer/);
  });

  it("doesn't pause a slow site that still answers most loads", () => {
    let watch: LoadWatch | undefined;
    // One load in three times out, run after run.
    for (let run = 0; run < 20; run++) {
      watch = load(watch, [false, false, true, false, true, false, false, true, false]);
      assert.equal(isRefusing(watch), false);
      assert.equal(refusalStep(watch, T0).kind, "none");
    }
  });

  it("doesn't pause over a few failures in a row", () => {
    assert.equal(refusalStep(load(load(undefined, ok(30)), no(7)), T0).kind, "none");
  });

  it("names a site that never answered, without a page count", () => {
    const step = refusalStep(load(undefined, no(10)), T0);
    assert.equal(step.kind, "pause");
    assert.match(
      refusalNote("x.example", step.watch.loaded, step as { kind: "pause"; until: number }),
      /^x\.example stopped answering our reader\. It may/,
    );
  });

  it("slows after the pause, then pauses longer, then stops for a person", () => {
    const first = refusalStep(load(load(undefined, ok(40)), no(10)), T0);
    assert.equal(first.kind, "pause");
    // The pause over, the first few pages a run all refuse.
    const second = refusalStep(load(first.watch, no(REFUSED_PAGES)), T0);
    assert.equal(second.kind, "pause");
    assert.ok(second.kind === "pause");
    assert.equal(second.until, T0 + 15 * 60_000);
    const third = refusalStep(load(second.watch, no(REFUSED_PAGES)), T0);
    assert.equal(third.kind, "stop");
    const note = refusalNote("www.x.example", third.watch.loaded, third as { kind: "stop" });
    assert.match(note, /after about 40 pages and didn't start again, so the sync stopped there/);
    assert.match(note, /then retry the failed pages/);
  });

  it("goes on slowly once it answers again, and says so", () => {
    const first = refusalStep(load(load(undefined, ok(40)), no(10)), T0);
    const after = refusalStep(load(first.watch, [false, true, false]), T0);
    assert.equal(after.kind, "slow");
    assert.match(refusalNote("x.example", after.watch.loaded, after as { kind: "slow" }), /the sync goes on slowly, a few pages a minute/);
  });

  it("a full window of pages after a pause ends it: stray timeouts don't pause the site again", () => {
    const first = refusalStep(load(load(undefined, ok(40)), no(10)), T0);
    const recovered = load(first.watch, ok(10));
    assert.equal(recovered.pauses, 0);
    assert.equal(refusalStep(load(recovered, no(3)), T0).kind, "none");
  });

  it("a paused host sends nothing until its pause ends, then a few pages a run", () => {
    const pages = Array.from({ length: 10 }, (_, i) => ({ page: { url: `https://www.x.example/${i}` } }));
    const hosts = new Map([["x.example", { until: T0 + 300_000, slowUntil: T0 + 1_200_000, pages: REFUSED_PAGES }]]);
    assert.equal(pacedSelection(pages, 60, T0 + 60_000, hosts).length, 0);
    assert.equal(pacedSelection(pages, 60, T0 + 301_000, hosts).length, REFUSED_PAGES);
    assert.equal(pacedSelection(pages, 60, T0 + 1_300_000, hosts).length, 10);
  });

  it("a person's Retry keeps the sentence and says it goes slowly", () => {
    const note = refusalNote("www.x.example", 40, { kind: "pause", until: T0 });
    const retry = retryNote(note);
    assert.equal(isRefusalNote(retry), true);
    assert.equal(
      retry,
      "www.x.example stopped answering our reader after about 40 pages, so the retry goes slowly, after any pause still running: a few pages a minute.",
    );
  });
});

describe("the sniffer's stop on a silent host", () => {
  it("stops after 6 no-answers in a row for a minute, and any answer starts the count again", () => {
    let now = T0;
    const hosts = new SilentHosts(() => now);
    const url = "https://www.x.example/a";
    for (let i = 0; i < 5; i++) hosts.noAnswer(url);
    assert.equal(hosts.stopped(url), false);
    hosts.answered(url);
    for (let i = 0; i < 5; i++) hosts.noAnswer(url);
    assert.equal(hosts.stopped(url), false);
    hosts.noAnswer(url);
    assert.equal(hosts.stopped("https://x.example/b"), true);
    assert.equal(hosts.stopped("https://y.example/b"), false);
    now += 61_000;
    assert.equal(hosts.stopped(url), false);
  });
});

describe("what a person reads", () => {
  it("folds a raw error away, and a 404 is a page that's gone", () => {
    const timeout = pageProblem(`Didn't load: ${TIMEOUT}`);
    assert.equal(timeout?.words, "The site didn't answer when we read this page.");
    assert.match(timeout?.raw ?? "", /ERR_CONNECTION_TIMED_OUT/);
    assert.deepEqual(pageProblem("The site answered 404."), { words: "This page is gone: the site answered 404." });
    assert.deepEqual(pageProblem("Marked noindex, so it's left out."), { words: "Marked noindex, so it's left out." });
    assert.equal(GONE.test("The site answered 500."), false);
    assert.equal(noAnswer("The site answered 500."), false);
  });

  it("one 404 doesn't read as a failure; a failure a person can act on does", () => {
    assert.deepEqual(syncHeadline("partial", { failed: 1, gone: 1, answerable: 49, total: 50 }), [
      "good",
      "Synced: 49 of 50 pages answerable, 1 page gone (404)",
    ]);
    assert.equal(syncHeadline("partial", { failed: 2, gone: 1, answerable: 48, total: 50 }), undefined);
    assert.equal(syncHeadline("ok", { failed: 0, gone: 0, answerable: 50, total: 50 }), undefined);
    const note = refusalNote("x.example", 40, { kind: "stop" });
    assert.deepEqual(syncHeadline("partial", { failed: 96, gone: 0, answerable: 104, total: 200, note }), [
      "warning",
      "Synced, but the site stopped answering",
    ]);
    assert.deepEqual(syncHeadline("running", { failed: 0, gone: 0, answerable: 40, total: 200, note }), [
      "warning",
      "Syncing slowly: the site stopped answering",
    ]);
  });
});

describe("Review's line for pages not read", () => {
  const base = "/customers/c/deployments/d";
  const keys = [
    { url: "https://x.example/pricing", intent: "price" as const },
    { url: "https://x.example/contact", intent: "contact" as const },
  ];

  it("names the pages and the key pages, and holds sign-off until a person decides by name", () => {
    const line = missingPagesLine(base, { missing: 96, planned: 200, keys }, undefined);
    assert.equal(line?.state, "todo");
    assert.equal(line?.required, true);
    assert.match(
      line?.detail ?? "",
      /^96 of the 200 planned pages aren't in the chat\. Key pages among them: .*\(\/pricing\), .*\(\/contact\)\./,
    );
    assert.equal(line?.skip?.kind, "missingPages");
    assert.equal(line?.skip?.count, 96);
  });

  it("a decision holds while no more pages are missing, and names who took it", () => {
    const decided = { by: null, name: "Sam", at: "2026-11-03T15:00:00.000Z", verified: true, count: 96 };
    const line = missingPagesLine(base, { missing: 90, planned: 200, keys }, decided);
    assert.equal(line?.state, "skipped");
    assert.match(line?.detail ?? "", /Going ahead without 90 of the 200 planned pages, by choice \(Sam, 2026-11-03 15:00 UTC\)/);
    assert.equal(missingPagesLine(base, { missing: 97, planned: 200, keys }, decided)?.state, "todo");
  });

  it("doesn't ask over a timeout or two", () => {
    assert.equal(missingNeedsDecision({ missing: 2, planned: 50, keys: [], refused: false }), false);
    assert.equal(missingPagesLine(base, { missing: 1, planned: 200, keys: [] }, undefined), undefined);
    assert.equal(missingPagesLine(base, { missing: 0, planned: 200, keys: [], note: "x" }, undefined), undefined);
    assert.equal(missingNeedsDecision({ missing: 1, planned: 50, keys: [{}], refused: false }), true);
    assert.equal(missingNeedsDecision({ missing: 1, planned: 50, keys: [], refused: true }), true);
  });

  it("sits among Review's lines", () => {
    const lines = reviewLines({
      base,
      settings: {} as never,
      language: "en",
      brand: "confirmed",
      confirmations: {},
      leadDelivery: {},
      validation: null,
      domainsLocked: true,
      content: { indexed: 104, total: 200 },
      missingPages: { missing: 96, planned: 200, keys },
    });
    assert.equal(lines.find((l) => l.key === "missing")?.state, "todo");
  });
});

describe("a refusal inside one run (checkpoint 8)", () => {
  // 51 pages in three side-by-side batches: the site answered 20, and the last 10 asked for include loads it answered.
  const mixed = [...no(29), ...no(8), ...ok(14)];
  it("is seen when most of the run was refused, whatever the last ten asked for", () => {
    const watch = watchLoads(undefined, [...mixed.slice(0, 44), ...ok(7)], T0);
    assert.equal(watch.recent.filter(Boolean).length < 8, true);
    assert.equal(refusalStep(watch, T0).kind, "pause");
  });
  it("is seen at the end of a run when the sniffer stopped trying the host", () => {
    assert.equal(refusalStep(watchLoads(undefined, [...no(5), ...ok(40), ...no(3), ...ok(2)], T0, true), T0).kind, "pause");
  });
  it("isn't seen on a slow site that answers most loads and was never given up on", () => {
    assert.equal(refusalStep(watchLoads(undefined, [...no(9), ...ok(41)], T0), T0).kind, "none");
  });
  it("needs a real number of refusals, even if the sniffer stopped trying", () => {
    assert.equal(refusalStep(watchLoads(undefined, [...ok(40), ...no(6)], T0, true), T0).kind, "none");
  });
  it("counts a 405 as a refusal, and a 404 not", () => {
    assert.equal(refusedLoad({ status: 405 }), true);
    assert.equal(refusedLoad({ status: 404 }), false);
    assert.equal(refusedLoad({ status: 410 }), false);
  });
  it("starts its next window clean after the pause", () => {
    const step = refusalStep(watchLoads(undefined, [...ok(20), ...no(31)], T0), T0);
    assert.equal(step.watch.run, false);
    assert.equal(refusalStep(load(step.watch, [false, false, false]), T0).kind, "slow");
  });
});
