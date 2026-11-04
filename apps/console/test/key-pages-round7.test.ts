// Key pages by what the page is, after the round 7 release checks: buzzsprout.com's "Directory
// Contacts" and "Episode Order", planetmagpie.com's /it-support services, wartsila.com's technical
// support and events, mews.com's customer story, bynder.com's other languages and upcoming event.
// Each shape also on a made-up address, and the small notes the plan, the card and Review show.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { uniqueReasons } from "../src/lib/content.ts";
import {
  announcesUpcoming,
  capKeyIntents,
  fleetRateLimitedNote,
  intentOf,
  isPricingPage,
  noPriceTableNote,
  type PlanEntry,
  rankPages,
  ruleLeaveOut,
  sitemapFilesNote,
} from "../src/lib/content-plan.ts";
import { buildPriceTable, pricingGap, replacesTable } from "../src/lib/price-table.ts";

const TODAY = new Date("2026-11-02T12:00:00Z");
const at = (path: string, more: Omit<PlanEntry, "url"> = {}): PlanEntry => ({ url: `https://www.example.com${path}`, ...more });
const filler = Array.from({ length: 30 }, (_, i) => at(`/products/p${i}`, { lastmod: "2026-06-01" }));
const plan = (entries: PlanEntry[], served = ["en"], languages?: string[]) =>
  rankPages({
    entries: [...entries, ...filler],
    served,
    ...(languages && { languages }),
    rules: ["conversion", "duplicate", "archive", "year", "versions", "old"],
    include: [],
    exclude: [],
    budget: 200,
    today: TODAY,
  });
const url = (path: string) => `https://www.example.com${path}`;
const taken = (ranking: ReturnType<typeof plan>) => ranking.keyPages.taken.map((k) => [k.path, k.intent]);

describe("what a page's address says it is", () => {
  it("a help article with an intent word in its title isn't that intent's page", () => {
    assert.equal(intentOf(url("/help/130-directory-contacts")), "support");
    assert.equal(intentOf(url("/help/49-episode-order")), "support");
    assert.equal(intentOf(url("/directory-contacts")), undefined);
    assert.equal(intentOf(url("/episode-order")), undefined);
    assert.equal(intentOf(url("/kb/12-billing-contact")), undefined);
  });

  it("contact and buying pages still read as such", () => {
    for (const path of ["/contact", "/contact-us", "/about/contact-us", "/sales-contact", "/de/kontakt"])
      assert.equal(intentOf(url(path)), "contact", path);
    for (const path of ["/buy", "/how-to-buy", "/shop", "/online-shop"]) assert.equal(intentOf(url(path)), "buy", path);
  });

  it("support by what the page is, not a word in a service's name", () => {
    for (const path of [
      "/it-support",
      "/it-support/it-office-moves",
      "/it-support/disaster-recovery",
      "/it-support/it-support-services",
      "/managed-support",
    ]) {
      assert.equal(intentOf(url(path)), undefined, path);
    }
    for (const path of [
      "/support",
      "/help",
      "/technical-support",
      "/customer-service",
      "/service-desk",
      "/marine/services/technical-support",
      "/energy/services/customer-support",
    ]) {
      assert.equal(intentOf(url(path)), "support", path);
    }
    assert.equal(intentOf(url("/marine/services/support")), undefined);
  });

  it("a customer story isn't a buying page, whatever its slug starts with", () => {
    assert.equal(intentOf(url("/en/customers/boutique-hotel-orangerie")), undefined);
    assert.equal(intentOf(url("/case-studies/store-rollout")), undefined);
    assert.equal(intentOf(url("/en/boutique")), "buy");
  });

  it("keeps taking /shop/ and a page titled for buying as pricing", () => {
    assert.ok(isPricingPage("https://www.alfredapp.com/shop/", "Buy the Alfred Powerpack"));
    assert.ok(isPricingPage(url("/pricing"), "Pricing"));
  });
});

describe("the plan's key pages", () => {
  it("states prices before quote forms, and takes one quote form while it has such a page", () => {
    const ranking = plan([at("/pricing"), at("/request-a-quote"), at("/get-a-quote"), at("/quote")]);
    const paths = taken(ranking)
      .filter(([, intent]) => intent === "price")
      .map(([path]) => path);
    assert.equal(paths[0], "/pricing");
    assert.equal(paths.length, 2);
  });

  it("takes the quote forms when they are all there is", () => {
    const ranking = plan([at("/request-a-quote"), at("/get-a-quote")]);
    assert.equal(taken(ranking).filter(([, intent]) => intent === "price").length, 2);
  });

  it("only in the deployment's languages, even when the plan's languages say every one (bynder.com)", () => {
    const ranking = plan(
      [at("/en/pricing"), at("/de/preise"), at("/fr/tarifs"), at("/en/trial"), at("/dk/book-demo"), at("/se/boka-demo"), at("/nl/trial")],
      ["en"],
      [],
    );
    assert.deepEqual(
      taken(ranking)
        .map(([path]) => path)
        .sort(),
      ["/en/pricing", "/en/trial"],
    );
    const german = plan([at("/en/pricing"), at("/de/preise")], ["en", "de"], []);
    assert.deepEqual(
      taken(german)
        .map(([path]) => path)
        .sort(),
      ["/de/preise", "/en/pricing"],
    );
  });

  it("an unmarked page under a two-letter folder stays when it's the only one of its kind", () => {
    assert.deepEqual(taken(plan([at("/us/pricing")])), [["/us/pricing", "price"]]);
  });

  it("takes an events section under another section, its index first (wartsila.com, mews.com)", () => {
    const ranking = plan([
      at("/contact"),
      at("/media/events"),
      at("/marine/events"),
      at("/media/events/capital-markets-day"),
      at("/media/news/old-event"),
    ]);
    const events = ranking.keyPages.events?.map((e) => e.path) ?? [];
    assert.deepEqual(events.slice(0, 2).sort(), ["/marine/events", "/media/events"]);
    assert.ok(events.includes("/media/events/capital-markets-day"));
    const german = plan([at("/de/ressourcen/events"), at("/de/ressourcen/events/hitec")], ["de"], []);
    assert.deepEqual(
      german.keyPages.events?.map((e) => e.path),
      ["/de/ressourcen/events", "/de/ressourcen/events/hitec"],
    );
  });

  it("leaves room for the events list when the intents fill the key pages", () => {
    const many = ["price", "contact", "support", "buy", "trial", "faq"].flatMap((word, w) =>
      Array.from({ length: 5 }, (_, i) => at(`/${["pricing", "contact", "support", "buy", "trial", "faq"][w]}/${word}${i}`)),
    );
    const ranking = rankPages({
      entries: [...many, at("/media/events")],
      served: ["en"],
      rules: [],
      include: [],
      exclude: [],
      budget: 40,
      today: TODAY,
    });
    assert.deepEqual(
      ranking.keyPages.events?.map((e) => e.path),
      ["/media/events"],
    );
  });

  it("a crawled site's key pages are capped per intent, the shallowest first (alfredapp.com)", () => {
    const listed = [
      ...Array.from({ length: 40 }, (_, i) => ({ url: url(`/help/section/article-${i}`), intent: "support" as const })),
      { url: url("/help"), intent: "support" as const },
      { url: url("/contact"), intent: "contact" as const },
      { url: url("/about"), intent: null },
    ];
    const capped = capKeyIntents(listed);
    assert.equal(capped.filter((l) => l.intent === "support").length, 4);
    assert.equal(capped.find((l) => l.url === url("/help"))?.intent, "support");
    assert.equal(capped.find((l) => l.url === url("/contact"))?.intent, "contact");
    assert.equal(capped.length, listed.length);
  });
});

describe("the age rules and an event still to come", () => {
  const page = (text: string) => ({
    url: url("/en/events/ondam-paris-2026"),
    title: "OnDAM Paris 2026",
    published: new Date("2025-07-23T00:00:00Z"),
    articleType: "BlogPosting",
    text,
  });

  it("never leaves out a page announcing a future event by its age (bynder.com's OnDAM Paris)", () => {
    const upcoming = page("# OnDAM Paris 2026\n\nJoin our conference on 19 November 2026 in Paris.");
    assert.ok(announcesUpcoming(upcoming, TODAY));
    assert.equal(ruleLeaveOut(upcoming, [], ["archive", "old"], TODAY), undefined);
  });

  it("still leaves out one whose event is over", () => {
    const past = page("# OnDAM Paris\n\nThe conference took place on 19 November 2024 in Paris.");
    assert.ok(!announcesUpcoming(past, TODAY));
    assert.match(ruleLeaveOut(past, [], ["archive", "old"], TODAY) ?? "", /over 12 months old/);
  });

  // Fix cycle 7c: any date still to come counts, on any line and in any supported language. A past
  // one doesn't, nor a number that isn't a date.
  it("any date still to come counts, whatever its line says", () => {
    assert.ok(announcesUpcoming(page("We are exhibiting at NATO EDGE, November 17 - 19 2026, Stand: B53"), TODAY));
    assert.ok(announcesUpcoming(page("26. November 2026 - 27. November 2026"), TODAY));
    assert.ok(announcesUpcoming(page("17-19 November 2026"), TODAY));
    assert.ok(announcesUpcoming(page("vom 5. bis 7. Dezember 2026"), TODAY));
    assert.ok(announcesUpcoming(page("del 5 al 7 de diciembre de 2026"), TODAY));
    assert.ok(announcesUpcoming(page("05.12.2026 Neckarsulm"), TODAY));
    assert.ok(announcesUpcoming(page("2026-12-05"), TODAY));
    assert.ok(announcesUpcoming(page("Coming in December 2026"), TODAY));
    assert.ok(!announcesUpcoming(page("May 18 - 20 2026, and 17-19 November 2024"), TODAY));
    assert.ok(!announcesUpcoming(page("Version 12.11.2 of 40 000 units"), TODAY));
  });
});

describe("when there's no table", () => {
  const NOW = new Date("2026-11-02T12:00:00Z");
  const shop = "https://www.example.com/shop/";

  it("a pricing page stating figures with no rows read is named as unread", () => {
    const pages = [{ url: shop, facts: { prices: [{ figure: "$12", line: "We think this offer of $12 is the one you want." }] } }];
    const t = buildPriceTable(pages, NOW);
    assert.deepEqual(t.rows, []);
    assert.deepEqual(t.gap, { kind: "unread", url: shop, figures: 1 });
    assert.match(noPriceTableNote(t), /A pricing page was found \(\/shop\/\), but no prices could be read from it/);
    assert.doesNotMatch(noPriceTableNote(t), /no pricing page was found/i);
    assert.equal(replacesTable(undefined, t, undefined), true);
  });

  it("a pricing page with no figures, or only tailored ones, is by quote; no page is no page", () => {
    assert.deepEqual(pricingGap([{ url: shop, facts: {} }]), { kind: "quote", url: shop });
    assert.deepEqual(
      pricingGap([{ url: shop, facts: { prices: [{ figure: "USD 1,495", line: "Packages starting under USD 1,495 per month." }] } }]),
      {
        kind: "quote",
        url: shop,
      },
    );
    assert.equal(pricingGap([]), undefined);
    assert.match(noPriceTableNote(buildPriceTable([{ url: shop, facts: {} }], NOW)), /by quote/);
    assert.equal(noPriceTableNote(undefined), "No price table: no pricing page was found.");
    assert.equal(replacesTable(undefined, buildPriceTable([], NOW), undefined), false);
  });

  it("a stored empty table is replaced when its reason changes, and left alone when it doesn't", () => {
    const quote = buildPriceTable([{ url: shop, facts: {} }], NOW);
    const unread = buildPriceTable([{ url: shop, facts: { prices: [{ figure: "$12", line: "An offer of $12 today." }] } }], NOW);
    assert.equal(replacesTable(quote, unread, undefined), true);
    assert.equal(replacesTable(quote, buildPriceTable([{ url: shop, facts: {} }], new Date()), undefined), false);
  });
});

describe("small lines", () => {
  it("the plan says when it read gzipped sitemaps", () => {
    assert.equal(sitemapFilesNote(16), "16 sitemap files");
    assert.equal(sitemapFilesNote(1), "1 sitemap file");
    assert.equal(sitemapFilesNote(1, 1), "1 gzipped sitemap file");
    assert.equal(sitemapFilesNote(16, 3), "16 sitemap files (3 gzipped)");
  });

  it("Review says one reason once, whichever addresses share it", () => {
    const why = "/shop/checkout/ has almost no text (38 words): the chat can't answer from it.";
    const pages = [
      { url: url("/shop/checkout/?type=single"), why },
      { url: url("/shop/checkout/?type=mega"), why },
      { url: url("/contact"), why: "another" },
    ];
    assert.deepEqual(
      uniqueReasons(pages).map((p) => p.url),
      [url("/shop/checkout/?type=single"), url("/contact")],
    );
  });

  it("Fleet names how many deployments a rate limit touches", () => {
    assert.equal(
      fleetRateLimitedNote(1, 1),
      "1 deployment's site rate-limited the sync (429) on 1 page; they're tried again, more slowly.",
    );
    assert.match(fleetRateLimitedNote(1200, 3), /3 deployments' sites rate-limited the sync \(429\) on 1,200 pages/);
  });
});
