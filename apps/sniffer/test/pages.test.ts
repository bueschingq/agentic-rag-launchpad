import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { SNIFFER_EXTRACTOR } from "../../console/src/lib/content-plan.ts";
import { EXTRACTOR_VERSION } from "../src/content.ts";
import {
  cleanTitle,
  figuresIn,
  findKeyPages,
  hreflangFolders,
  KEY_PAGE_REQUESTS,
  listSitemapPages,
  pathMatches,
  readSitemaps,
  SitemapFetchError,
  wantedPage,
  withBillingViews,
  withToggleViews,
} from "../src/pages.ts";

// Files as the sites served them on 30 Oct 2026. kemptechnologies.com/sitemap.xml is a 1-in-50
// sample of the 7,553 pages it listed (2,292 marked English); www.chef.io's is its first 12.
const fixture = (path: string) => readFileSync(new URL(`fixtures/${path}`, import.meta.url), "utf8");

describe("pathMatches", () => {
  it("treats a plain path as that section and everything under it", () => {
    assert.ok(pathMatches("https://a.example/blog", ["/blog"]));
    assert.ok(pathMatches("https://a.example/blog/2026/hello", ["/blog/"]));
    assert.ok(!pathMatches("https://a.example/blogger", ["/blog"]));
  });

  it("supports * anywhere, ignoring case", () => {
    assert.ok(pathMatches("https://a.example/EN/Careers/Jobs", ["/*/careers/*"]));
    assert.ok(pathMatches("https://a.example/default.aspx", ["*.aspx"]));
    assert.ok(!pathMatches("https://a.example/about", ["/*/careers/*", " "]));
  });
});

describe("wantedPage", () => {
  it("keeps same-site pages, www or not, and drops files", () => {
    assert.ok(wantedPage("https://example.com/about", "www.example.com"));
    assert.ok(!wantedPage("https://other.example/about", "www.example.com"));
    assert.ok(!wantedPage("https://www.example.com/brochure.PDF", "www.example.com"));
    assert.ok(!wantedPage("mailto:a@example.com", "www.example.com"));
  });

  it("applies include, then exclude", () => {
    const rules = { include: ["/en"], exclude: ["/en/search"] };
    assert.ok(wantedPage("https://www.example.com/en/products", "www.example.com", rules));
    assert.ok(!wantedPage("https://www.example.com/es/productos", "www.example.com", rules));
    assert.ok(!wantedPage("https://www.example.com/en/search?q=x", "www.example.com", rules));
  });
});

describe("readSitemaps", () => {
  const files: Record<string, string> = {
    "https://www.example.com/robots.txt": "Sitemap: https://www.example.com/sitemap/sitemap.xml",
    "https://www.example.com/sitemap/sitemap.xml":
      "<sitemapindex><sitemap><loc>https://www.example.com/sitemap/en.xml</loc></sitemap><sitemap><loc>https://www.example.com/sitemap/es.xml</loc></sitemap><sitemap><loc>https://www.example.com/sitemap/nested.xml</loc></sitemap></sitemapindex>",
    "https://www.example.com/sitemap/en.xml":
      "<urlset><url><loc>https://www.example.com/en/</loc><lastmod>2026-01-02</lastmod></url><url><loc>https://www.example.com/en/pricing</loc></url><url><loc>https://www.example.com/files/a.pdf</loc></url></urlset>",
    "https://www.example.com/sitemap/es.xml":
      "<urlset><url><loc>https://www.example.com/es/</loc></url><url><loc>https://cdn.other.example/x</loc></url><url><loc>https://www.example.com/en</loc></url></urlset>",
    "https://www.example.com/sitemap/nested.xml":
      "<sitemapindex><sitemap><loc>https://www.example.com/sitemap/deep.xml</loc></sitemap><sitemap><loc>https://www.example.com/sitemap/en.xml</loc></sitemap></sitemapindex>",
    "https://www.example.com/sitemap/deep.xml": "<urlset><url><loc>https://example.com/deep/page</loc></url></urlset>",
  };
  const fetchText = async (url: string) => {
    // Out of order on purpose: the result keeps sitemap order whatever finishes first.
    await new Promise((resolve) => setTimeout(resolve, url.includes("en.xml") ? 20 : 1));
    return files[url] ?? "";
  };

  it("follows nested indexes, keeps same-site pages once, in sitemap order", async () => {
    const read = await readSitemaps("https://www.example.com/", fetchText);
    assert.deepEqual(
      read.entries.map((e) => e.url),
      ["https://www.example.com/en/", "https://www.example.com/en/pricing", "https://www.example.com/es/", "https://example.com/deep/page"],
    );
    assert.equal(read.entries[0]!.lastmod, "2026-01-02");
    assert.deepEqual(read.sitemaps, ["https://www.example.com/sitemap/sitemap.xml"]);
    assert.equal(read.files, 5);
    assert.equal(read.truncated, false);
  });

  it("stops at the page cap, the file cap and the deadline, and says so", async () => {
    assert.equal((await readSitemaps("https://www.example.com/", fetchText, { maxPages: 2 })).truncated, true);
    assert.equal((await readSitemaps("https://www.example.com/", fetchText, { maxFiles: 2 })).truncated, true);
    const slow = async (url: string) => {
      if (url.endsWith("robots.txt")) return files[url]!;
      await new Promise((resolve) => setTimeout(resolve, 200));
      return files[url] ?? "";
    };
    const started = Date.now();
    const late = await readSitemaps("https://www.example.com/", slow, { deadlineMs: 50 });
    assert.ok(Date.now() - started < 150);
    assert.equal(late.truncated, true);
  });

  it("tries a failed file again, and never takes a failure for an empty file (round 6: teamleader.eu)", async () => {
    let refusals = 0;
    const limited = async (url: string) => {
      // The Spanish file is rate-limited once, then served; the nested index never answers.
      if (url.endsWith("es.xml") && refusals++ === 0) throw new SitemapFetchError("429", 429);
      if (url.endsWith("nested.xml")) throw new SitemapFetchError("503", 503);
      return files[url] ?? "";
    };
    const read = await readSitemaps("https://www.example.com/", limited);
    assert.ok(read.entries.some((e) => e.url === "https://www.example.com/es/"));
    assert.deepEqual(read.failed, [{ url: "https://www.example.com/sitemap/nested.xml", status: 503, reason: "the site answered 503" }]);
    assert.deepEqual(read.unread, []);
    // A usual place that isn't there is no failure.
    const none = await readSitemaps("https://a.example/", async () => {
      throw new SitemapFetchError("404", 404);
    });
    assert.deepEqual(none.failed, []);
  });

  it("lists the files not reached before the deadline", async () => {
    const slow = async (url: string) => {
      if (url.endsWith("robots.txt") || url.endsWith("sitemap/sitemap.xml")) return files[url]!;
      await new Promise((resolve) => setTimeout(resolve, 300));
      return files[url] ?? "";
    };
    const late = await readSitemaps("https://www.example.com/", slow, { deadlineMs: 100 });
    assert.ok(late.unread.includes("https://www.example.com/sitemap/en.xml"));
  });

  it("says which files gave the pages, and that robots.txt listed them", async () => {
    const read = await readSitemaps("https://www.example.com/", fetchText);
    assert.deepEqual(read.discovery, { how: "robots", elsewhere: [], used: ["https://www.example.com/sitemap/sitemap.xml"] });
  });
});

describe("finding the site's own sitemap", () => {
  const served =
    (files: Record<string, string>, asked: string[] = []) =>
    async (url: string) => {
      asked.push(url);
      return files[url] ?? "";
    };

  it("uses the site's /sitemap.xml when robots.txt points at another site's (kemptechnologies.com → www.chef.io)", async () => {
    const asked: string[] = [];
    const read = await readSitemaps(
      "https://kemptechnologies.com/",
      served(
        {
          "https://kemptechnologies.com/robots.txt": fixture("kemptechnologies.com/robots.txt"),
          "https://www.chef.io/sitemap.xml": fixture("www.chef.io/sitemap.xml"),
          "https://kemptechnologies.com/sitemap.xml": fixture("kemptechnologies.com/sitemap.xml"),
        },
        asked,
      ),
    );
    assert.deepEqual(read.discovery, {
      how: "fallback",
      why: "elsewhere",
      elsewhere: ["https://www.chef.io/sitemap.xml", "https://www.chef.io/sitemap_video.xml"],
      used: ["https://kemptechnologies.com/sitemap.xml"],
    });
    assert.equal(read.entries.length, 152);
    assert.ok(read.entries.every((e) => new URL(e.url).hostname === "kemptechnologies.com"));
    // Languages come from each page's own hreflang link.
    const langs = new Set(read.entries.map((e) => e.lang));
    for (const lang of ["en", "de", "fr", "es", "ja"]) assert.ok(langs.has(lang), lang);
    // chef.io's files were read too (they could have listed kemptechnologies.com pages), in one pass.
    assert.ok(asked.includes("https://www.chef.io/sitemap.xml") && asked.includes("https://kemptechnologies.com/sitemap_index.xml"));
  });

  it("tries the usual places when robots.txt names no sitemap, and finds nothing on a site that has none", async () => {
    const asked: string[] = [];
    const read = await readSitemaps("https://a.example/", served({}, asked));
    assert.deepEqual(asked, [
      "https://a.example/robots.txt",
      "https://a.example/sitemap.xml",
      "https://a.example/sitemap/sitemap.xml",
      "https://a.example/sitemap_index.xml",
    ]);
    assert.equal(read.entries.length, 0);
    assert.deepEqual(read.discovery, { how: "fallback", why: "none-listed", elsewhere: [], used: [] });
    assert.equal(read.truncated, false);
  });

  it("keeps only this site's pages from an index that mixes hosts", async () => {
    const read = await readSitemaps(
      "https://www.example.com/",
      served({
        "https://www.example.com/robots.txt": "Sitemap: https://www.example.com/sitemap_index.xml",
        "https://www.example.com/sitemap_index.xml":
          "<sitemapindex><sitemap><loc>https://cdn.example.net/sitemaps/shop.xml</loc></sitemap><sitemap><loc>https://www.example.com/pages.xml</loc></sitemap></sitemapindex>",
        "https://cdn.example.net/sitemaps/shop.xml":
          "<urlset><url><loc>https://shop.example.net/cart</loc></url><url><loc>https://example.com/shop/gift-cards</loc></url></urlset>",
        "https://www.example.com/pages.xml":
          "<urlset><url><loc>https://www.example.com/about</loc></url><url><loc>https://blog.example.com/news</loc></url></urlset>",
      }),
    );
    assert.deepEqual(
      read.entries.map((e) => e.url),
      ["https://example.com/shop/gift-cards", "https://www.example.com/about"],
    );
    assert.equal(read.discovery.how, "robots");
  });

  it("tries the usual places when robots.txt's own sitemap lists none of the site's pages", async () => {
    const read = await readSitemaps(
      "https://www.example.com/",
      served({
        "https://www.example.com/robots.txt": "Sitemap: https://www.example.com/sitemaps/empty.xml",
        "https://www.example.com/sitemaps/empty.xml": "<urlset></urlset>",
        "https://www.example.com/sitemap/sitemap.xml": "<urlset><url><loc>https://www.example.com/visit</loc></url></urlset>",
      }),
    );
    assert.deepEqual(read.discovery, {
      how: "fallback",
      why: "no-pages",
      elsewhere: [],
      used: ["https://www.example.com/sitemap/sitemap.xml"],
    });
    assert.equal(read.entries.length, 1);
  });

  it("reads a sitemap address the partner entered, and only it", async () => {
    const asked: string[] = [];
    const files = {
      "https://www.example.com/robots.txt": "Sitemap: https://www.example.com/sitemap.xml",
      "https://www.example.com/sitemap.xml": "<urlset><url><loc>https://www.example.com/a</loc></url></urlset>",
      "https://www.example.com/en/sitemap.xml":
        "<urlset><url><loc>https://www.example.com/en/a</loc></url><url><loc>https://www.example.com/en/b</loc></url></urlset>",
    };
    const read = await readSitemaps("https://www.example.com/", served(files, asked), {
      sitemap: "https://www.example.com/en/sitemap.xml",
    });
    assert.deepEqual(asked, ["https://www.example.com/en/sitemap.xml"]);
    assert.equal(read.entries.length, 2);
    assert.deepEqual(read.discovery, { how: "given", elsewhere: [], used: ["https://www.example.com/en/sitemap.xml"] });
    // One that lists none of the site's pages is said so, and the site's own are read instead.
    const wrong = await readSitemaps("https://www.example.com/", served(files), { sitemap: "https://www.example.com/missing.xml" });
    assert.equal(wrong.discovery.givenEmpty, "https://www.example.com/missing.xml");
    assert.equal(wrong.discovery.how, "robots");
    // A language's own sitemap, which robots.txt doesn't name, is read too (fix cycle 7c).
    assert.deepEqual(
      wrong.entries.map((e) => e.url),
      ["https://www.example.com/a", "https://www.example.com/en/a", "https://www.example.com/en/b"],
    );
  });
});

describe("findKeyPages: a pricing or contact page no sitemap lists", () => {
  const site = (pages: Record<string, { status?: number; text?: string; url?: string } | "error">) => {
    const asked: string[] = [];
    const fetchText = async (url: string) => {
      asked.push(url);
      const page = pages[new URL(url).pathname] ?? { status: 404 };
      if (page === "error") throw new Error("timed out");
      return { url: page.url ?? url, status: page.status ?? 200, text: page.text ?? "" };
    };
    return { asked, fetchText };
  };
  const origin = "https://www.example.com";

  it("takes the home page's link first, and asks no more than it needs", async () => {
    const s = site({
      "/": {
        text: '<a href="/en/pricing-plans">Plans</a><a href="/about">About</a><a href="https://other.example/pricing">x</a><a href="/contact-us">Contact</a>',
      },
      "/en/pricing-plans": { text: "Starter $9 per month" },
      "/contact-us": { text: "Write to us" },
    });
    const got = await findKeyPages(origin, [`${origin}/about`], s.fetchText);
    assert.deepEqual(got, { found: [`${origin}/en/pricing-plans`, `${origin}/contact-us`], unreached: [] });
    assert.equal(s.asked.length, 3);
  });

  it("tries the common addresses when the home page links to none (buzzsprout.com's /pricing)", async () => {
    const s = site({ "/": { text: "<a href='/help'>Help</a>" }, "/plans": { text: "Plans and prices" }, "/contact": {} });
    const got = await findKeyPages(origin, [`${origin}/help/130-directory-contacts`, `${origin}/help/49-episode-order`], s.fetchText);
    assert.deepEqual(got.found, [`${origin}/plans`, `${origin}/contact`]);
    assert.ok(s.asked.length <= KEY_PAGE_REQUESTS);
  });

  it("asks nothing when the listed addresses already name them", async () => {
    const s = site({});
    const got = await findKeyPages(origin, [`${origin}/en/pricing/`, `${origin}/about/contact-us`], s.fetchText);
    assert.deepEqual(got, { found: [], unreached: [] });
    assert.deepEqual(s.asked, []);
  });

  it("doesn't take a redirect home, a page that doesn't read as pricing, or more than a handful of requests", async () => {
    const s = site({
      "/": { text: "" },
      "/pricing": { url: `${origin}/`, text: "$9" },
      "/plans": { text: "Floor plans of our office" },
      "/price": { status: 404 },
      "/contact": { status: 404 },
    });
    const got = await findKeyPages(origin, [`${origin}/about`], s.fetchText);
    assert.deepEqual(got.found, []);
    assert.ok(s.asked.length <= KEY_PAGE_REQUESTS, String(s.asked.length));
  });

  it("says what it couldn't reach, so the listing isn't taken as the whole site", async () => {
    const s = site({ "/": "error", "/pricing": { status: 503 } });
    const got = await findKeyPages(origin, [`${origin}/about`, `${origin}/contact`], s.fetchText);
    assert.deepEqual(got.found, []);
    assert.ok(got.unreached.includes(`${origin}/`));
    assert.ok(got.unreached.includes(`${origin}/pricing`));
  });
});

describe("withToggleViews: a toggle the page's own script handles", () => {
  const base = "## Direct\n\n$ 20.00 /MO\n\nbilled annually\n\n## Portfolio\n\n$ 23.50\n\n- A feature";
  const monthly = "## Direct\n\n$ 29.00 /MO\n\nbilled monthly\n\n## Portfolio\n\n$ 35.50\n\n- A feature";

  it("adds what the other setting shows, under its headings, and names the settings", () => {
    const text = withToggleViews(base, "YEARLY", [{ label: "MONTHLY", markdown: monthly }]);
    assert.match(text, /The prices above are with "YEARLY" selected\./);
    assert.match(
      text,
      /## Prices with "MONTHLY" selected\n\n## Direct\n\n\$ 29\.00 \/MO, billed monthly\n\n## Portfolio\n\n\$ 35\.50, billed monthly/,
    );
    assert.match(text, /## Portfolio\n\n\$ 23\.50, billed annually/, "the setting shown first says so too");
    assert.match(text, /\$ 20\.00 \/MO\n\nbilled annually/, "a price that says it already isn't said twice");
    assert.ok(!text.split("selected\n")[1]?.includes("A feature"), "only the prices are repeated");
  });
  it("says billing only of a setting that names a cycle, in any language", () => {
    const de = withToggleViews("$ 9", "Jährlich", [{ label: "Monatlich", markdown: "$ 12" }]);
    assert.match(de, /\$ 9, billed annually/);
    assert.match(de, /\$ 12, billed monthly/);
    assert.doesNotMatch(withToggleViews("$ 9", "Subscription", [{ label: "Perpetual", markdown: "$ 12" }]), /billed/);
  });
  it("a figure alone keeps the lines above it that name it", () => {
    const view = "- 24x7 Live Support\n\nstarting from\n\n$ 4,620";
    assert.match(
      withToggleViews("Plan: $ 9", undefined, [{ label: "Perpetual", markdown: view }]),
      /24x7 Live Support\n\nstarting from\n\n\$ 4,620/,
    );
  });
  it("a setting that adds no figure adds nothing, and works out nothing", () => {
    assert.equal(withToggleViews(base, "YEARLY", [{ label: "Compare", markdown: base }]), base);
    assert.equal(withToggleViews(base, undefined, []), base);
    assert.equal(figuresIn("$ 9, 10 € and 2.205 USD").size, 3);
  });
});

describe("a language's own sitemap, and a blocked file", () => {
  const served =
    (files: Record<string, string>, asked: string[] = []) =>
    async (url: string) => {
      asked.push(url);
      return files[url] ?? "";
    };
  const urls = (...paths: string[]) => `<urlset>${paths.map((p) => `<url><loc>https://www.example.com${p}</loc></url>`).join("")}</urlset>`;
  it("finds /de/sitemap.xml, which robots.txt doesn't name, so the plan can offer German", async () => {
    const asked: string[] = [];
    const read = await readSitemaps(
      "https://www.example.com/",
      served(
        {
          "https://www.example.com/robots.txt": "Sitemap: https://www.example.com/sitemap.xml",
          "https://www.example.com/sitemap.xml": urls("/a", "/b"),
          "https://www.example.com/de/sitemap.xml": urls("/de/a", "/de/b"),
        },
        asked,
      ),
    );
    assert.deepEqual(
      read.entries.map((e) => e.url.replace("https://www.example.com", "")),
      ["/a", "/b", "/de/a", "/de/b"],
    );
    assert.ok(read.discovery.used.includes("https://www.example.com/de/sitemap.xml"));
    assert.deepEqual(read.failed, [], "a language with no sitemap is no failure");
    assert.equal(read.truncated, false);
    assert.equal(asked.filter((u) => u.endsWith("/de/sitemap.xml")).length, 1, "read once");
  });
  it("reads the folders the home page's hreflang links name", () => {
    const html = `<link rel="alternate" hreflang="ja" href="/ja/"><link rel="alternate" hreflang="pt-br" href="https://www.example.com/pt-br/x"><link href="/en/" hreflang="en" rel="alternate">`;
    assert.deepEqual(hreflangFolders(html, "https://www.example.com"), ["ja", "pt-br", "en"]);
  });
  it("doesn't take an HTML page at that address for a sitemap", async () => {
    const read = await readSitemaps(
      "https://www.example.com/",
      served({
        "https://www.example.com/robots.txt": "Sitemap: https://www.example.com/sitemap.xml",
        "https://www.example.com/sitemap.xml": urls("/a"),
        "https://www.example.com/de/sitemap.xml": "<html><body>Seite nicht gefunden</body></html>",
      }),
    );
    assert.equal(read.entries.length, 1);
    assert.deepEqual(read.failed, []);
  });
  it("one blocked file among others that read isn't the site blocking us", async () => {
    const wall = new SitemapFetchError("x answered with a cookie wall's block page", 200, { blocked: "a cookie wall" });
    const read = await readSitemaps("https://www.example.com/", async (url) => {
      if (url.endsWith("/robots.txt"))
        return "Sitemap: https://www.example.com/jobsite/sitemap.xml\nSitemap: https://www.example.com/sitemap.xml";
      if (url.endsWith("/jobsite/sitemap.xml")) throw wall;
      if (url === "https://www.example.com/sitemap.xml") return urls("/a", "/b");
      throw new SitemapFetchError("not found", 404);
    });
    assert.equal(read.blocked, undefined);
    assert.equal(read.entries.length, 2);
    assert.match(read.failed[0]?.reason ?? "", /blocked by a cookie wall/);
  });
  it("every file blocked, with nothing read, is the site blocking us", async () => {
    const wall = new SitemapFetchError("x answered with a block page", 403, { blocked: "Cloudflare" });
    const read = await readSitemaps("https://www.example.com/", async (url) => {
      if (url.endsWith("/robots.txt"))
        return "Sitemap: https://www.example.com/a.xml\nSitemap: https://www.example.com/b.xml\nSitemap: https://www.example.com/c.xml";
      throw wall;
    });
    assert.equal(read.blocked?.by, "Cloudflare");
    assert.equal(read.entries.length, 0);
  });
});

describe("withBillingViews: a billing toggle that reloads the page", () => {
  const annual =
    "### Audio\n\n- Upload 72 hrs / yr\n\n$15 / month\n\nWhen billed annually\n\n### Video\n\n$25 / month\n\n## FAQ\n\nAn archive plan is $5/month.";
  const monthly = "### Audio\n\n- Upload 72 hrs / yr\n\n$18 / month\n\n### Video\n\n$30 / month\n\n## FAQ\n\nAn archive plan is $5/month.";

  it("says the billing each price is shown for, and adds the other view's prices under their plans", () => {
    const text = withBillingViews(annual, "annual", [{ period: "monthly", markdown: monthly }]);
    assert.ok(text.includes("$15 / month\n\nWhen billed annually"));
    assert.ok(text.includes("$25 / month, billed annually"));
    assert.ok(
      text.endsWith("## Prices billed monthly\n\n### Audio\n\n$18 / month, billed monthly\n\n### Video\n\n$30 / month, billed monthly"),
      text,
    );
    // A sentence's figure is left as it is.
    assert.ok(text.includes("An archive plan is $5/month."));
  });

  it("adds nothing for a view whose prices are the page's", () => {
    assert.equal(withBillingViews(annual, undefined, [{ period: "monthly", markdown: annual }]), annual);
  });
});

describe("the extractor's version", () => {
  // The sync's EXTRACTOR_VERSION also counts what it does to the text afterwards (chrome lines).
  it("is the one the sync treats as current, so pages it reads aren't read again", () => {
    assert.equal(EXTRACTOR_VERSION, SNIFFER_EXTRACTOR);
  });
});

describe("listSitemapPages", () => {
  it("keeps pages within the rules, shallowest first, up to the budget", () => {
    const read = {
      sitemaps: ["https://www.example.com/sitemap.xml"],
      files: 1,
      truncated: false,
      discovery: { how: "robots" as const, elsewhere: [], used: ["https://www.example.com/sitemap.xml"] },
      entries: ["https://www.example.com/en/pricing", "https://www.example.com/en/", "https://www.example.com/es/"].map((url) => ({ url })),
      failed: [],
      unread: [],
    };
    assert.deepEqual(listSitemapPages(read, { limit: 10 }).urls, [
      "https://www.example.com/en/",
      "https://www.example.com/es/",
      "https://www.example.com/en/pricing",
    ]);
    assert.deepEqual(listSitemapPages(read, { limit: 1, include: ["/en"] }), {
      sitemaps: ["https://www.example.com/sitemap.xml"],
      urls: ["https://www.example.com/en/"],
      total: 2,
    });
  });
});

describe("cleanTitle", () => {
  it("drops the brand after the last separator", () => {
    assert.equal(
      cleanTitle({ title: "One CMS Unifying Content | Progress Sitefinity" }, "https://a.example/x"),
      "One CMS Unifying Content",
    );
    assert.equal(cleanTitle({ title: "Pricing - Plans - Acme" }, "https://a.example/x"), "Pricing - Plans");
    assert.equal(cleanTitle({ title: "Home" }, "https://a.example/"), "Home");
    assert.equal(cleanTitle({ title: "", h1: "Visiting hours" }, "https://a.example/visit"), "Visiting hours");
    assert.equal(cleanTitle({ title: "" }, "https://a.example/visit"), "/visit");
  });
});
