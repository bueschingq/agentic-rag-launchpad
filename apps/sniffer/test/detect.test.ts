import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { countSitemapPages, detectPlatform, parseSitemap, sitemapsFromRobots } from "../src/detect.ts";

describe("detectPlatform", () => {
  it("reads the version when the generator tag is present", () => {
    const guess = detectPlatform('<head><meta name="Generator" content="Sitefinity 15.4.8630.0 DX" /></head>');
    assert.equal(guess.platform, "sitefinity");
    assert.equal(guess.version, "15.4.8630");
  });

  it("recognises Sitefinity from markup when the tag is stripped (crayola.com in M0)", () => {
    const html = `<div data-sf-element="Row" data-sf-role="x"></div><link href="/ResourcePackages/Crayola/assets/dist/main.css">`;
    const guess = detectPlatform(html);
    assert.equal(guess.platform, "sitefinity");
    assert.equal(guess.version, undefined);
    assert.deepEqual(guess.evidence, ["data-sf- attributes: 2", "Sitefinity resource paths: 1"]);
  });

  it("recognises other common platforms", () => {
    assert.equal(detectPlatform('<link href="/wp-content/themes/x/style.css">').platform, "wordpress");
    assert.equal(detectPlatform('<img src="/sites/default/files/a.png">').platform, "drupal");
    assert.equal(detectPlatform("<p>hello</p>").platform, "unknown");
  });
});

describe("sitemaps", () => {
  it("takes Sitemap lines from robots.txt, else /sitemap.xml", () => {
    const robots = "User-agent: *\nDisallow: /cart\nSitemap: https://www.crayola.com/sitemap/sitemap.xml\nsitemap: /news.xml\n";
    assert.deepEqual(sitemapsFromRobots(robots, "https://www.crayola.com"), [
      "https://www.crayola.com/sitemap/sitemap.xml",
      "https://www.crayola.com/news.xml",
    ]);
    assert.deepEqual(sitemapsFromRobots("User-agent: *", "https://a.example"), ["https://a.example/sitemap.xml"]);
  });

  it("parses url sets and indexes, including CDATA and entities", () => {
    const urlset = `<?xml version="1.0"?><urlset xmlns="x"><url><loc>https://a.example/</loc></url><url><loc><![CDATA[https://a.example/p?a=1&amp;b=2]]></loc></url></urlset>`;
    assert.deepEqual(parseSitemap(urlset), { kind: "urlset", locs: ["https://a.example/", "https://a.example/p?a=1&b=2"] });
    assert.equal(parseSitemap("<sitemapindex><sitemap><loc>https://a.example/1.xml</loc></sitemap></sitemapindex>").kind, "index");
  });

  it("counts pages through one level of index", async () => {
    const files: Record<string, string> = {
      "https://a.example/index.xml": "<sitemapindex><sitemap><loc>https://a.example/1.xml</loc></sitemap><sitemap><loc>https://a.example/2.xml</loc></sitemap></sitemapindex>",
      "https://a.example/1.xml": "<urlset><url><loc>https://a.example/a</loc></url><url><loc>https://a.example/b</loc></url></urlset>",
      "https://a.example/2.xml": "<urlset><url><loc>https://a.example/c</loc></url></urlset>",
    };
    const fetchText = async (url: string) => files[url] ?? "";
    assert.deepEqual(await countSitemapPages("https://a.example/index.xml", fetchText), { pages: 3, truncated: false });
    assert.deepEqual(await countSitemapPages("https://a.example/index.xml", fetchText, 1), { pages: 2, truncated: true });
  });
});
