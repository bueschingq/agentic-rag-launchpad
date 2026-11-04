// extractContent in a real browser: folded content (Sitefinity's List accordion, Bootstrap tabs
// and collapses, <details>) is kept, while overlays and navigation are dropped, and the page's
// own dates are read.
//   npx playwright install chromium && npm run test:browser --workspace @launchpad/sniffer

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, describe, it } from "node:test";
import { type Browser, chromium } from "playwright";
import { extractContent } from "../src/content.ts";
import { operateToggles, withBillingViews, withToggleViews } from "../src/pages.ts";

// Pages as the sites served them on 30 Oct 2026, their text replaced by a short stand-in.
const fixture = (name: string) => readFileSync(new URL(`fixtures/${name}`, import.meta.url), "utf8");

const PAGE = `<!doctype html>
<html lang="en"><head><title>Headless support in Sitefinity | Progress</title></head>
<body>
<header><nav><button aria-controls="menu" aria-expanded="false">Menu</button>
  <div id="menu" style="display:none">Products Pricing Partners</div></nav></header>
<main id="Contentplaceholder1_C001_Col00" class="sf_colsIn">
  <h1>Headless support in Sitefinity</h1>
  <p>Answers to the questions developers ask most about using Sitefinity as a headless CMS.</p>
  <ul class="sf-list-accordion">
    <li>
      <a href="javascript:void(0)" data-sf-role="toggleLink">Do I need Sitefinity development skills to create different client-side applications?</a>
      <div style="display:none;" class="sf-list-content collapse">
        Sitefinity's headless CMS architecture lets you play to your frontend development strengths.
      </div>
    </li>
  </ul>
  <div class="tab-content">
    <div class="tab-pane active" role="tabpanel" id="tab-saas">SaaS: Sitefinity Cloud is hosted and managed by Progress.</div>
    <div class="tab-pane" role="tabpanel" id="tab-onprem" hidden>On premises: you host Sitefinity on your own servers.</div>
  </div>
  <button aria-controls="pricing-more" aria-expanded="false">Read more</button>
  <div id="pricing-more" aria-hidden="true" style="display:none">Licences are priced per site and environment.</div>
  <details><summary>Which .NET versions are supported?</summary><p>.NET 8 and later for the ASP.NET Core renderer.</p></details>
  <div style="display:none">Internal tracking placeholder.</div>
</main>
<div role="dialog" aria-modal="true" class="consent" style="display:none">We use cookies. Accept all?</div>
<footer>© Progress Software</footer>
</body></html>`;

describe("extractContent in a browser", () => {
  let browser: Browser;
  before(async () => {
    browser = await chromium.launch();
  });
  after(async () => {
    await browser.close();
  });

  it("keeps accordion, tab, read-more and details content, and drops overlays and plain hidden elements", async () => {
    const page = await browser.newPage();
    await page.setContent(PAGE);
    const raw = await page.evaluate(extractContent);
    await page.close();
    assert.equal(raw.root, "main");
    for (const kept of [
      "Do I need Sitefinity development skills",
      "Sitefinity's headless CMS architecture lets you play to your frontend development strengths.",
      "On premises: you host Sitefinity on your own servers.",
      "Licences are priced per site and environment.",
      ".NET 8 and later for the ASP.NET Core renderer.",
    ]) {
      assert.ok(raw.markdown.includes(kept), `missing: ${kept}\n---\n${raw.markdown}`);
    }
    for (const dropped of ["We use cookies", "Products Pricing Partners", "Internal tracking placeholder", "© Progress"]) {
      assert.ok(!raw.markdown.includes(dropped), `should be left out: ${dropped}`);
    }
    // Folded text kept: the extract is about as long as the content area, hidden text included.
    assert.ok(raw.textChars >= raw.rootChars / 2, `${raw.textChars} of ${raw.rootChars}`);
  });

  it("reads the page's own dates: JSON-LD first, then article meta tags, then <time itemprop>", async () => {
    const read = async (html: string) => {
      const page = await browser.newPage();
      await page.setContent(html);
      const raw = await page.evaluate(extractContent);
      await page.close();
      return { published: raw.datePublished, modified: raw.dateModified, type: raw.articleType };
    };
    // whatsupgold.com closes the publisher's braces after the dates, and its <time> says 2021.
    assert.deepEqual(await read(fixture("whatsupgold-es-blog.html")), {
      published: "2016-10-11T13:00:00",
      modified: "2026-09-25T12:42:14",
      type: "BlogPosting",
    });
    assert.deepEqual(await read(fixture("telerik-whitepaper.html")), {
      published: "2016-01-04T12:39:59+00:00",
      modified: undefined,
      type: undefined,
    });
    const page = (head: string, body = "<main><h1>A page</h1><p>Text.</p></main>") =>
      `<!doctype html><html><head><title>A page</title>${head}</head><body>${body}</body></html>`;
    assert.deepEqual(
      await read(page("", '<main><h1>Post</h1><time itemprop="datePublished" datetime="2019-06-28">28 June 2019</time></main>')),
      { published: "2019-06-28", modified: undefined, type: undefined },
    );
    // An Event's dates are when it happens; the page's own come from its WebPage.
    const graph = {
      "@context": "https://schema.org",
      "@graph": [
        { "@type": "Event", name: "DevReach", startDate: "2025-09-10", datePublished: "2030-01-01" },
        { "@type": "WebPage", datePublished: "2024-02-01", dateModified: "2025-03-01" },
      ],
    };
    assert.deepEqual(await read(page(`<script type="application/ld+json">${JSON.stringify(graph)}</script>`)), {
      published: "2024-02-01",
      modified: "2025-03-01",
      type: undefined,
    });
    // Broken JSON still gives its dates.
    assert.deepEqual(
      await read(page('<script type="application/ld+json">{"@type": "NewsArticle", "datePublished": "2018-05-04",}</script>')),
      { published: "2018-05-04", modified: undefined, type: undefined },
    );
    assert.deepEqual(await read(page("")), { published: undefined, modified: undefined, type: undefined });
  });

  it("measures what extraction lost, for the short-text flag, and the share of link text", async () => {
    const answers = Array.from(
      { length: 12 },
      (_, i) => `<p>Answer ${i}: a long explanation of how the product handles case number ${i}.</p>`,
    ).join("");
    const listing = Array.from(
      { length: 12 },
      (_, i) => `<li><a href="/blog/post-${i}">Blog post number ${i} with a long title</a></li>`,
    ).join("");
    const page = await browser.newPage();
    // Tabs the extraction doesn't recognise (a custom class, display:none) hide most of the text.
    await page.setContent(`<!doctype html><html><body><main><h1>Plans</h1><p>Compare our plans.</p>
      <div class="custom-tab" style="display:none">${answers}</div></main></body></html>`);
    const hidden = await page.evaluate(extractContent);
    assert.ok(hidden.textChars < hidden.rootChars / 2, `${hidden.textChars} of ${hidden.rootChars}`);
    await page.setContent(`<!doctype html><html><body><main><h1>Blog Listing</h1><ul>${listing}</ul></main></body></html>`);
    const overview = await page.evaluate(extractContent);
    await page.close();
    assert.ok(overview.linkShare > 0.5, String(overview.linkShare));
  });
});

// Round 7: pricing pages as transistor.fm, alfredapp.com and buzzsprout.com served them on 1 Nov
// 2026 (fixtures/pricing, scripts and icons removed), and a synthetic page per shape.
describe("pricing pages (extractor 3)", () => {
  let browser: Browser;
  before(async () => {
    browser = await chromium.launch();
  });
  after(async () => {
    await browser.close();
  });
  const pricing = (name: string) => readFileSync(new URL(`fixtures/pricing/${name}.html`, import.meta.url), "utf8");
  // A page served at its own address (so its forms resolve), other views of it by query.
  const load = async (url: string, html: string, views: Record<string, string> = {}) => {
    const page = await browser.newPage();
    await page.route("**/*", (route) => {
      const at = new URL(route.request().url());
      const body = at.search ? views[at.search] : at.href === url ? html : undefined;
      return body ? route.fulfill({ contentType: "text/html; charset=utf-8", body }) : route.abort();
    });
    await page.goto(url);
    return page;
  };

  it("keeps a plan card's name held in a heading's button, and writes out data-yearly figures (transistor.fm)", async () => {
    const page = await load("https://transistor.fm/pricing/", pricing("transistor"));
    const raw = await page.evaluate(extractContent);
    await page.close();
    for (const kept of ["## Starter\n\n$19 /mo\n\n$190 per year", "## Professional", "## Enterprise 1\n\n$199 /mo\n\n$1990 per year"]) {
      assert.ok(raw.markdown.includes(kept), `missing: ${kept}\n---\n${raw.markdown}`);
    }
    assert.ok(raw.markdown.includes("Transcription (5 hrs per month) $50 per year"));
    // The billing buttons and "select" controls outside headings stay out.
    assert.ok(!/^Monthly$|^Yearly/m.test(raw.markdown));
  });

  it("reads a card wrapped in a link as its own headings (alfredapp.com)", async () => {
    const page = await load("https://www.alfredapp.com/shop/", pricing("alfred"));
    const raw = await page.evaluate(extractContent);
    await page.close();
    assert.ok(raw.markdown.includes("## Single License\n\n### £34"), raw.markdown);
    assert.ok(raw.markdown.includes("## Mega Supporter\n\n### £59"), raw.markdown);
  });

  it("keeps the plan cards inside a form, and finds the billing toggle that reloads the page (buzzsprout.com)", async () => {
    const page = await load("https://www.buzzsprout.com/pricing", pricing("buzzsprout"), {
      "?period=monthly": pricing("buzzsprout-monthly"),
    });
    const raw = await page.evaluate(extractContent);
    assert.ok(raw.markdown.includes("### Audio + Video"), raw.markdown);
    assert.ok(raw.markdown.includes("$25 / month"));
    assert.equal(raw.billingShown, "annual");
    assert.deepEqual(raw.billingViews, [{ period: "monthly", url: "https://www.buzzsprout.com/pricing?period=monthly" }]);
    await page.goto(raw.billingViews![0]!.url);
    const monthly = await page.evaluate(extractContent);
    await page.close();
    const text = withBillingViews(raw.markdown, raw.billingShown, [{ period: "monthly", markdown: monthly.markdown }]);
    assert.ok(text.includes("$25 / month, billed annually"), text);
    assert.ok(text.includes("## Prices billed monthly\n\n### Audio\n\n$18 / month, billed monthly"), text);
    assert.ok(text.includes("### Multi-Podcast\n\n$36 / month, billed monthly"), text);
  });

  it("synthetic: a form's prices and labels stay, its controls and a newsletter form go", async () => {
    const page = await load(
      "https://example.com/plans",
      `<!doctype html><html><body><main><h1>Plans</h1>
      <form action="/checkout" method="post"><div class="card"><h2>Basic</h2><label>Seats <input name="seats" value="1"></label>
      <p>€8 per month</p><button type="submit">Choose Basic</button></div></form>
      <form class="signup"><label>Email</label><input type="email"><button>Subscribe</button></form>
      <section><span data-monthly="12" data-yearly="120">€12</span> <span>/mo</span></section>
      </main></body></html>`,
    );
    const raw = await page.evaluate(extractContent);
    await page.close();
    assert.ok(raw.markdown.includes("## Basic"), raw.markdown);
    assert.ok(raw.markdown.includes("€8 per month"), raw.markdown);
    assert.ok(raw.markdown.includes("Seats"));
    assert.ok(!raw.markdown.includes("Choose Basic"));
    assert.ok(!raw.markdown.includes("Subscribe"));
    assert.ok(!raw.markdown.includes("Email"));
    assert.ok(raw.markdown.includes("€120 per year"), raw.markdown);
    assert.equal(raw.billingViews, undefined);
  });
});

// Fix cycle 7c: client-side toggles, as smugmug.com/plans and kemptechnologies.com/pricing build them
// (seen in their rendered pages on 2 Nov 2026), reduced to the markup that matters.
describe("operateToggles in a real browser", () => {
  let browser: Browser;
  before(async () => {
    browser = await chromium.launch();
  });
  after(async () => {
    await browser.close();
  });
  const SWAPPED = `<!doctype html><html><body><main>
    <div class="wrap"><div class="toggle_txt" data-m>MONTHLY</div><div class="toggle_txt is-active" data-y>YEARLY</div></div>
    <style>.toggle_txt{cursor:pointer}</style>
    <h2>Direct</h2><p><span id="d">$ 20.00</span> /MO</p>
    <h2>Pro</h2><p><span id="p">$ 37.00</span></p>
    <a href="/signup"><span style="cursor:pointer">Start my trial</span></a><a href="/signup2"><span style="cursor:pointer">Other</span></a>
    <script>document.querySelector('[data-m]').onclick=()=>{d.textContent='$ 29.00';p.textContent='$ 52.00'};
    document.querySelector('[data-y]').onclick=()=>{d.textContent='$ 20.00';p.textContent='$ 37.00'};</script>
  </main></body></html>`;
  const SHOWN = `<!doctype html><html><body><main>
    <button class="is-active" id="sub">Subscription</button><button id="perp">Perpetual</button>
    <section class="s"><h3>Standard</h3><h5>$ 4,500</h5></section>
    <section class="o" style="display:none"><ul><li>24x7 Live Support</li></ul><h5>$ 4,620</h5></section>
    <ul class="tabs" style="cursor:pointer"><li class="is-active" style="cursor:pointer">Virtual</li><li id="hw" style="cursor:pointer">Hardware</li></ul>
    <section class="h" style="display:none"><p>24x7 Customer Support</p><h5>$ 2,860</h5></section>
    <script>perp.onclick=()=>{document.querySelector('.s').style.display='none';document.querySelector('.o').style.display='block'};
    hw.onclick=()=>{document.querySelector('.h').style.display='block'};</script>
  </main></body></html>`;
  const read = async (html: string) => {
    const page = await browser.newPage();
    await page.route("https://toggle.test/**", (r) => r.fulfill({ contentType: "text/html", body: html }));
    await page.goto("https://toggle.test/plans");
    const raw = await page.evaluate(extractContent);
    const toggled = await operateToggles(page, raw);
    const url = page.url();
    await page.close();
    return { text: withToggleViews(raw.markdown, toggled.shown, toggled.views), url, toggled };
  };

  it("clicks a switch of plain divs, whatever it says, and reads the other figures", async () => {
    const { text, url } = await read(SWAPPED);
    assert.match(text, /\$ 29\.00/);
    assert.match(text, /\$ 52\.00/);
    assert.match(text, /The prices above are with "YEARLY" selected/);
    assert.match(text, /Prices with "MONTHLY" selected/);
    assert.equal(url, "https://toggle.test/plans", "a link's text is never clicked");
  });

  it("clicks tabs that show hidden blocks, once each, reading hidden elements afresh", async () => {
    const { text } = await read(SHOWN);
    assert.match(text, /Prices with "Perpetual" selected[\s\S]*24x7 Live Support[\s\S]*\$ 4,620/);
    assert.match(text, /Prices with "Hardware" selected[\s\S]*\$ 2,860/);
  });

  it("does nothing on a page that states no figure", async () => {
    const { toggled } = await read(SWAPPED.replace(/\$ \d+\.\d+/g, "soon"));
    assert.deepEqual(toggled.views, []);
  });
});
