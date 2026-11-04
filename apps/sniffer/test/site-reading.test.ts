// The sync's site reading against the fixture site (fixture-site.ts): a gzipped sitemap index of
// gzipped sitemaps behind a rate limit of 2 requests a second, and a bot-protected site. Round 6:
// HMS Networks' gzipped sitemap was never read, its 429s became final failures, and a
// bot-protected site waited 93 s for the plan.

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { gzipSync } from "node:zlib";
import { botProtection } from "../src/blocked.ts";
import { decodeBody, retryAfterMs } from "../src/net.ts";
import { HostPacer } from "../src/pace.ts";
import { fetchSitemapFile, readSitemaps, retryPause } from "../src/pages.ts";
import { type FixtureSite, startFixtureSite } from "./fixture-site.ts";

process.env.SNIFFER_ALLOW_LOOPBACK = "1";

describe("gzipped sitemaps", () => {
  it("decodes a gzipped body, and leaves plain text alone", () => {
    assert.equal(decodeBody(gzipSync("<urlset></urlset>")), "<urlset></urlset>");
    assert.equal(decodeBody(Buffer.from("<urlset/>")), "<urlset/>");
  });

  it("refuses a gzipped body that unpacks past the cap", () => {
    assert.throws(() => decodeBody(gzipSync("x".repeat(10_000)), 1_000), /gzipped body/);
  });
});

describe("Retry-After", () => {
  it("reads seconds and HTTP dates", () => {
    assert.equal(retryAfterMs("2"), 2000);
    assert.equal(retryAfterMs("Wed, 21 Oct 2026 07:28:30 GMT", Date.parse("Wed, 21 Oct 2026 07:28:00 GMT")), 30_000);
    assert.equal(retryAfterMs("soon"), undefined);
    assert.equal(retryAfterMs(undefined), undefined);
  });

  it("waits the site's pause when it gives one, up to 20 s", () => {
    assert.equal(retryPause(0), 1000);
    assert.equal(retryPause(0, 5000), 5000);
    assert.equal(retryPause(1, 120_000), 20_000);
    assert.equal(retryPause(3, 1000), undefined);
  });
});

describe("the fixture site: a gzipped sitemap behind 429s above 2 requests a second", () => {
  let site: FixtureSite;
  before(async () => {
    site = await startFixtureSite({ rate: 2 });
  });
  after(() => site.close());

  it("reads every page of the gzipped index and its gzipped files, waiting out the 429s", async () => {
    const read = await readSitemaps(site.origin, (url) => fetchSitemapFile(url), { deadlineMs: 25_000 });
    assert.equal(read.entries.length, site.pages.length);
    assert.deepEqual(
      read.entries.map((e) => e.url),
      site.pages,
    );
    assert.deepEqual(read.failed, []);
    assert.deepEqual(read.unread, []);
    assert.equal(read.blocked, undefined);
    assert.equal(read.discovery.how, "robots");
    assert.deepEqual(read.discovery.used, [`${site.origin}/sitemap/sitemap.gz`]);
    // The limit was met and waited out, not taken for empty files.
    assert.ok(site.stats.limited > 0, "the fixture rate-limited the read");
    assert.ok((read.rateLimited ?? 0) > 0);
  });

  it("loads the start page and every page through the pacer: 429s are waited out, none is final", async () => {
    const pacer = new HostPacer({ maxWaitMs: 15_000 });
    const before = site.stats.limited;
    const load = async (url: string) => {
      const res = await fetch(url);
      await res.text();
      return { status: res.status, ...(res.status === 429 && { retryAfterMs: retryAfterMs(res.headers.get("retry-after")) }) };
    };
    // Three loads side by side, as the sniffer's sync lane does.
    const urls = [site.origin + "/", ...site.pages.slice(1, 12)];
    const results: { status: number; tries: number }[] = [];
    let next = 0;
    await Promise.all(
      Array.from({ length: 3 }, async () => {
        while (next < urls.length) {
          const url = urls[next++]!;
          const paced = await pacer.run(url, () => load(url));
          assert.ok(!("skipped" in paced), "no wait was longer than a load waits");
          if (!("skipped" in paced)) results.push({ status: paced.result.status, tries: paced.tries });
        }
      }),
    );
    assert.equal(results.length, urls.length);
    assert.deepEqual(
      results.map((r) => r.status),
      urls.map(() => 200),
    );
    assert.ok(site.stats.limited > before, "the fixture rate-limited the loads");
    assert.ok(pacer.paced(site.origin));
  });
});

describe("bot protection", () => {
  it("stops the read at robots.txt and says who blocked it, within seconds", async () => {
    const site = await startFixtureSite({ blocked: true });
    try {
      const started = Date.now();
      const read = await readSitemaps(site.origin, (url) => fetchSitemapFile(url), { deadlineMs: 25_000 });
      assert.ok(Date.now() - started < 10_000, `took ${Date.now() - started} ms`);
      assert.equal(read.blocked?.by, "Cloudflare");
      assert.equal(read.blocked?.status, 403);
      assert.equal(read.blocked?.url, `${site.origin}/robots.txt`);
      assert.equal(read.entries.length, 0);
      // Asked once: a block page isn't tried again.
      assert.equal(site.stats.byPath.get("/robots.txt"), 1);
    } finally {
      await site.close();
    }
  });

  it("names the firewall from its block page, and leaves ordinary answers alone", () => {
    const html = (title: string, body = "") => `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`;
    const h = (more: Record<string, string> = {}) => ({ "content-type": "text/html", ...more });
    assert.equal(botProtection({ status: 403, headers: h({ "cf-mitigated": "challenge" }), text: html("Just a moment...") }), "Cloudflare");
    assert.equal(
      botProtection({ status: 403, headers: h({ server: "AkamaiGHost" }), text: html("Access Denied", "Reference #18.2f") }),
      "Akamai",
    );
    assert.equal(botProtection({ status: 403, headers: h(), text: html("Request unsuccessful", "Incapsula incident ID: 123") }), "Imperva");
    assert.equal(botProtection({ status: 403, headers: h({ "x-datadome": "protected" }), text: html("") }), "DataDome");
    assert.equal(
      botProtection({ status: 200, headers: h(), text: html("Before you continue", "We use cookies and consent…") }, "text"),
      "a cookie wall",
    );
    // An ordinary page on a Cloudflare site carries its challenge-platform script: not a block.
    assert.equal(
      botProtection({
        status: 200,
        headers: h({ server: "cloudflare", "cf-ray": "1" }),
        text: html("Pricing", '<script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js"></script>'),
      }),
      undefined,
    );
    assert.equal(botProtection({ status: 404, headers: h(), text: html("Not found") }, "text"), undefined);
    // A sitemap path a server forbids isn't a firewall; the start page answering 403 is.
    assert.equal(botProtection({ status: 403, headers: h(), text: html("403 Forbidden") }, "text"), undefined);
    assert.equal(botProtection({ status: 403, headers: h(), text: html("403 Forbidden") }, "html"), "bot protection");
    assert.equal(
      botProtection({ status: 200, headers: { "content-type": "application/xml" }, text: "<urlset></urlset>" }, "text"),
      undefined,
    );
  });
});
