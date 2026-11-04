// The sync's honest outcomes (round 6, item 2): a page the site rate-limits is tried again, never a
// final failure on the first 429; a listing that's incomplete takes nothing out of the chat; a sync
// that can't start is "failed" (and alerted) only when the chat has nothing answerable; hosts that
// rate-limited send fewer pages a run.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RATE_LIMIT_TRIES } from "../../console/src/lib/content-plan.ts";
import { listingComplete, pacedSelection, rateLimitedOutcome, startFailure } from "../src/jobs/content.ts";

const NOW = new Date("2026-11-01T14:30:00Z");

describe("a page the site rate-limited", () => {
  it("waits for another try, up to the limit", () => {
    let page = { detail: null as string | null, indexedAt: null, contentHash: null };
    for (let i = 1; i < RATE_LIMIT_TRIES; i++) {
      const next = rateLimitedOutcome(page, 429);
      assert.equal(next.status, "queued");
      assert.match(next.detail, new RegExp(`try ${i} of ${RATE_LIMIT_TRIES}`));
      page = { ...page, detail: next.detail };
    }
    const last = rateLimitedOutcome(page, 429);
    assert.equal(last.status, "failed");
    assert.match(last.detail, /the next sync tries it again/);
  });

  it("goes back to answering from its copy when it's in the chat", () => {
    const page = {
      detail: "The site rate-limited the sync (429); trying it again more slowly (try 3 of 4).",
      indexedAt: NOW,
      contentHash: "h",
    };
    assert.equal(rateLimitedOutcome(page, 429).status, "indexed");
  });
});

describe("an incomplete listing", () => {
  it("is a sitemap read with a file failed, unread or blocked, or a crawl that found much less than the chat has", () => {
    assert.equal(listingComplete({ kind: "sitemap", failed: 0, unread: 0, blocked: false }, 200), true);
    assert.equal(listingComplete({ kind: "sitemap", failed: 2, unread: 0, blocked: false }, 200), false);
    assert.equal(listingComplete({ kind: "sitemap", failed: 0, unread: 0, blocked: true }, 200), false);
    // Sync now on hms-networks.com: the crawl's start page answered 429, 0 pages, 28 answering.
    assert.equal(listingComplete({ kind: "crawl", found: 0 }, 28), false);
    assert.equal(listingComplete({ kind: "crawl", found: 85 }, 88), true);
  });
});

describe("a sync that can't start", () => {
  it("fails (the alert) only when nothing is answerable; otherwise its pages are kept", () => {
    assert.deepEqual(startFailure("No pages found.", 0, NOW), { lastJobStatus: "failed", lastError: "No pages found." });
    const kept = startFailure("The site's sitemaps couldn't be read this time (the site answered 429).", 28, NOW);
    assert.equal(kept.lastJobStatus, "partial");
    assert.equal(kept.lastSyncedAt, NOW);
    assert.match(kept.lastError, /The 28 answerable pages are kept; the next sync tries again\./);
  });
});

describe("hosts that rate-limited", () => {
  const page = (url: string) => ({ page: { url } });
  const waiting = [
    ...Array.from({ length: 10 }, (_, i) => page(`https://www.hms-networks.com/p${i}`)),
    ...Array.from({ length: 4 }, (_, i) => page(`https://www.chef.io/p${i}`)),
  ];
  it("wait out their pause, then send a few pages a run; other hosts aren't held up", () => {
    const at = NOW.getTime();
    const paused = new Map([["hms-networks.com", { until: at + 30_000, slowUntil: at + 900_000 }]]);
    assert.deepEqual(
      pacedSelection(waiting, 60, at, paused).map((w) => new URL(w.page.url).hostname),
      ["www.chef.io", "www.chef.io", "www.chef.io", "www.chef.io"],
    );
    const slow = pacedSelection(waiting, 60, at + 60_000, paused);
    assert.equal(slow.filter((w) => w.page.url.includes("hms")).length, 5);
    assert.equal(pacedSelection(waiting, 60, at, new Map()).length, 14);
  });
});
