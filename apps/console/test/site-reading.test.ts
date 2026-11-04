// Site reading (round 6, item 2), the console's half: gzipped sitemap addresses, key pages chosen
// by what the page is, the events section's pages, what the plan says about a blocked or
// rate-limiting site, and the held-answer panel's "Adding pages won't help" only after a complete
// sitemap read.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { syncedAnswerNote } from "../src/lib/content.ts";
import { parseSitemapAddress } from "../src/lib/content-form.ts";
import {
  blockedNote,
  intentOf,
  isSitemapAddress,
  keyPagesNote,
  type PlanEntry,
  RATE_LIMITED,
  rankPages,
  rateLimitedDetail,
  rateLimitedNote,
  rateLimitNote,
  rateLimitTries,
  sitemapFileLanguage,
} from "../src/lib/content-plan.ts";

const TODAY = new Date("2026-11-01T12:00:00Z");
const at = (path: string, more: Omit<PlanEntry, "url"> = {}): PlanEntry => ({ url: `https://www.example.com${path}`, ...more });
const plan = (entries: PlanEntry[], budget = 200, unusable: string[] = []) =>
  rankPages({
    entries,
    served: ["en"],
    rules: ["conversion", "duplicate", "archive", "year", "versions", "old"],
    include: [],
    exclude: [],
    budget,
    today: TODAY,
    unusable: new Set(unusable.map((p) => `https://www.example.com${p}`.toLowerCase())),
  });

describe("gzipped sitemap addresses", () => {
  it("accepts .gz and .xml.gz as sitemap addresses (hms-networks.com/sitemap/sitemap.gz)", () => {
    assert.ok(isSitemapAddress("https://www.hms-networks.com/sitemap/sitemap.gz"));
    assert.ok(isSitemapAddress("https://www.example.com/sitemap.xml.gz"));
    assert.ok(isSitemapAddress("https://www.example.com/sitemap.xml"));
    assert.ok(!isSitemapAddress("https://www.example.com/en/"));
    assert.deepEqual(parseSitemapAddress("www.hms-networks.com/sitemap/sitemap.gz"), {
      sitemap: "https://www.hms-networks.com/sitemap/sitemap.gz",
    });
    assert.match(parseSitemapAddress("https://www.example.com/sitemap.txt").error ?? "", /\.xml or \.gz/);
  });

  it("reads a language from a gzipped file's name", () => {
    assert.equal(sitemapFileLanguage("https://www.example.com/sitemap-de.xml.gz"), "de");
    assert.equal(sitemapFileLanguage("https://www.example.com/sitemap_sv.gz"), "sv");
  });
});

describe("key pages by what the page is", () => {
  it("takes /plans as the pricing page (sharefile.com)", () => {
    assert.equal(intentOf("https://www.sharefile.com/plans"), "price");
    const ranked = plan([at("/"), at("/plans"), at("/plans/sharefile-premium"), at("/about")]);
    assert.ok(ranked.keyPages.taken.some((k) => k.path === "/plans" && k.intent === "price"));
  });

  it("takes /technical-support as support, not a feature page about support", () => {
    assert.equal(intentOf("https://www.hms-networks.com/technical-support"), "support");
    assert.equal(intentOf("https://www.example.com/customer-support"), "support");
    assert.equal(intentOf("https://www.sharefile.com/product-feature/regulatory-compliance-support"), undefined);
    const ranked = plan([at("/"), at("/product-feature/regulatory-compliance-support"), at("/technical-support"), at("/contact-us")]);
    const support = ranked.keyPages.taken.filter((k) => k.intent === "support").map((k) => k.path);
    assert.deepEqual(support, ["/technical-support"]);
  });

  it("replaces a key page that didn't load with the next of its intent (sharefile.com's 404 /try pages)", () => {
    const entries = [at("/"), at("/try/advanced-plan"), at("/try/premium-plan"), at("/free-trial")];
    const before = plan(entries)
      .keyPages.taken.filter((k) => k.intent === "trial")
      .map((k) => k.path);
    assert.ok(before.includes("/try/advanced-plan"));
    const after = plan(entries, 200, ["/try/advanced-plan", "/try/premium-plan"]).keyPages.taken.filter((k) => k.intent === "trial");
    assert.deepEqual(
      after.map((k) => k.path),
      ["/free-trial"],
    );
  });

  it("takes the events section's index and own pages after the key pages, not past events (hms-networks.com/events)", () => {
    const ranked = plan([
      at("/"),
      at("/contact-us"),
      at("/events", { lastmod: "2026-10-20" }),
      at("/events/automation-summit-2026", { lastmod: "2026-10-01" }),
      at("/events/open-house", { lastmod: "2026-09-15" }),
      at("/events/expo-2023", { lastmod: "2023-03-01" }),
      ...Array.from({ length: 30 }, (_, i) => at(`/products/p${i}`, { lastmod: "2026-06-01" })),
    ]);
    assert.deepEqual(
      ranked.keyPages.events?.map((e) => e.path),
      ["/events", "/events/automation-summit-2026", "/events/open-house"],
    );
    const firsts = ranked.ranked.slice(0, 4).map((c) => new URL(c.entry.url).pathname);
    assert.deepEqual(firsts, ["/contact-us", "/events", "/events/automation-summit-2026", "/events/open-house"]);
    assert.match(keyPagesNote(ranked.keyPages).taken, /3 pages from the events section/);
  });
});

describe("what the plan says", () => {
  it("names the bot protection and what to ask for", () => {
    const note = blockedNote({ url: "https://www.pella.com/robots.txt", status: 403, by: "Akamai" });
    assert.match(note, /^The site blocked our reader \(Akamai bot protection\): \/robots\.txt answered/);
    assert.match(note, /allow the crawler/);
    assert.match(blockedNote({ url: "https://www.example.com/", status: 403, by: "bot protection" }), /\(bot protection\): the start page/);
  });

  it("says the site rate-limited the read, and that every file came in", () => {
    assert.match(rateLimitNote(3), /rate-limited the sitemap read \(429\) on 3 files/);
  });
});

describe("pages the site rate-limited", () => {
  it("counts the tries in the reason, and says so on Content instead of failed", () => {
    assert.equal(rateLimitTries(null), 0);
    assert.equal(rateLimitTries(rateLimitedDetail(429, 1)), 1);
    assert.equal(rateLimitTries(rateLimitedDetail(429, 3)), 3);
    assert.equal(rateLimitTries(rateLimitedDetail(429, 4)), 4);
    assert.ok(rateLimitedDetail(429, 4).startsWith(RATE_LIMITED));
    assert.equal(rateLimitedNote(60, true), "The site rate-limited the sync (429) on 60 pages; retrying more slowly.");
  });
});

describe("the held-answer panel", () => {
  const inSync = { url: "https://www.hms-networks.com/contact-us", inSync: true, match: "address" as const };
  it("says adding pages won't help only after a complete sitemap read", () => {
    assert.match(syncedAnswerNote([{ ...inSync, readComplete: true }]) ?? "", /Adding pages won't help/);
    const crawled = syncedAnswerNote([{ ...inSync, readComplete: false }]) ?? "";
    assert.doesNotMatch(crawled, /won't help/);
    assert.match(crawled, /use Find a page with its address first/);
  });
});
