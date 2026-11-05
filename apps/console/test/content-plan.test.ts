import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  answeringIntents,
  chromeLines,
  commercialContent,
  commercialNote,
  crawlNote,
  dateAnchor,
  defaultLanguages,
  discoveryNote,
  dropChrome,
  entryLanguage,
  errorPage,
  factsLine,
  figureValue,
  formatPlanDay,
  incompleteNote,
  intentLine,
  intentOf,
  isEvergreenUrl,
  isOverviewUrl,
  isTopLevelUrl,
  joinFigures,
  KEEP_ASKED,
  KEEP_ASKED_LIVE,
  keepAsked,
  keepRule,
  keptKind,
  keptSummary,
  keyIntentFor,
  keyPageLimit,
  keyPagesNote,
  labelFilter,
  labelsFor,
  leaveOutLabel,
  PAGE_LABELS,
  PAGE_LABELSET,
  type PlanEntry,
  type PlanInput,
  pageDate,
  pageFlags,
  pageLabel,
  pageLabels,
  pageLanguage,
  pageMetadata,
  pathLanguage,
  placeDates,
  placeYear,
  planContent,
  planRules,
  planSummary,
  questionIntents,
  questionLanguage,
  rankPages,
  ruleLeaveOut,
  sameFigure,
  selectPages,
  shownDetail,
  sitemapFileLanguage,
  stampNote,
  statedFacts,
  storedFacts,
  storedFlags,
  takesKeyPages,
  urlDate,
  withoutTracking,
} from "../src/lib/content-plan.ts";

// Sitemap entries as the sites listed them on 30 Oct 2026 (see each file's note).
const fixture = <T>(name: string): T => JSON.parse(readFileSync(new URL(`fixtures/${name}`, import.meta.url), "utf8")) as T;

const TODAY = new Date("2026-10-30T12:00:00Z");
const site = (path: string, more: Omit<PlanEntry, "url"> = {}): PlanEntry => ({ url: `https://www.example.com${path}`, ...more });
const input = (entries: PlanEntry[], over: Partial<PlanInput> = {}): PlanInput => ({
  entries,
  served: ["en"],
  rules: ["conversion", "duplicate", "archive", "year", "versions", "old"],
  include: [],
  exclude: [],
  budget: 200,
  today: TODAY,
  ...over,
});

describe("languages", () => {
  it("reads a language from the path, including the country codes sites use", () => {
    assert.equal(pathLanguage("https://www.whatsupgold.com/jp/blog/general-it"), "ja");
    assert.equal(pathLanguage("https://www.whatsupgold.com/tw/blog/general-it"), "zh-tw");
    assert.equal(pathLanguage("https://www.crayola.com/es-mx/products"), "es-mx");
    assert.equal(pathLanguage("https://www.progress.com/sitefinity-cms/it/trasforma"), "it");
    assert.equal(pathLanguage("https://www.example.com/products/marker/de"), undefined);
    assert.equal(pathLanguage("https://www.example.com/blog/it-pros"), undefined);
  });

  it("trusts hreflang sets, but not a lone self-link the path contradicts", () => {
    // progress.com marks its Italian /sitefinity-cms/it/ pages hreflang="en" with no other alternates.
    assert.equal(entryLanguage({ url: "https://www.progress.com/sitefinity-cms/it/x", lang: "en", alternates: 1 }), "it");
    assert.equal(entryLanguage({ url: "https://www.whatsupgold.com/jp/blog", lang: "ja", alternates: 7 }), "ja");
    assert.equal(entryLanguage({ url: "https://www.whatsupgold.com/blog", lang: "en", alternates: 7 }), "en");
    assert.equal(entryLanguage({ url: "https://www.telerik.com/blazor-ui" }), "und");
  });

  it("selects the served language's largest group, and the unmarked pages", () => {
    const wug = new Map([
      ["en", 2401],
      ["ja", 1813],
      ["de", 1607],
      ["zh-tw", 1211],
      ["und", 3],
    ]);
    assert.deepEqual(defaultLanguages(wug, ["en"]), ["und", "en"]);
    // Unmarked pages that outnumber a regional variant are the site's own: crayola.com and en-gb.
    assert.deepEqual(
      defaultLanguages(
        new Map([
          ["und", 5000],
          ["en-gb", 40],
        ]),
        ["en"],
      ),
      ["und"],
    );
    assert.deepEqual(
      defaultLanguages(
        new Map([
          ["en", 10],
          ["es", 8],
          ["ja", 9],
        ]),
        ["en", "es", "it"],
      ),
      ["en", "es"],
    );
  });
});

describe("planContent", () => {
  // Shaped like telerik.com: old campaigns, DevReach years, a conversion page and an A/B variant.
  const telerik = [
    site("/", { lastmod: "2026-10-01" }),
    site("/campaigns/kendo-ui-2026-q3-release-webinar", { lastmod: "2026-08-01" }),
    site("/campaigns/wb-telerik-r2-2021-release-webinar", { lastmod: "2022-02-10" }),
    site("/campaigns/reliableweb", { lastmod: "2022-02-10" }),
    site("/devreach-2022/agenda", { lastmod: "2026-07-02" }),
    site("/devreach-2023/code-of-conduct", { lastmod: "2023-05-15" }),
    site("/devreach-2025/agenda", { lastmod: "2025-05-15" }),
    site("/download/thank-you", { lastmod: "2026-01-01" }),
    site("/contact", { lastmod: "2026-01-01" }),
    site("/contact-m", { lastmod: "2026-01-01" }),
    site("/blazor-ui", { lastmod: "2026-09-01" }),
    site("/blazor-ui/grid", { lastmod: "2026-09-02" }),
    site("/blazor-power", { lastmod: "2022-07-18" }),
  ];

  it("counts sections with their newest and oldest dates", () => {
    const plan = planContent(input(telerik));
    assert.equal(plan.total, 13);
    const campaigns = plan.sections.find((s) => s.path === "/campaigns")!;
    assert.deepEqual(
      { pages: campaigns.pages, newest: campaigns.newest, oldest: campaigns.oldest, old: campaigns.old },
      { pages: 3, newest: "2026-08-01", oldest: "2022-02-10", old: 2 },
    );
    // Top-level pages without children share one section; folders get their own.
    assert.deepEqual(plan.sections.find((s) => s.path === "/")!.pages, 4);
    assert.ok(plan.sections.some((s) => s.path === "/blazor-ui" && s.pages === 2));
  });

  it("suggests conversion, duplicate, archive, year and old pages, each with a count, all ticked", () => {
    const plan = planContent(input(telerik));
    const by = Object.fromEntries(plan.suggestions.map((s) => [s.rule, s.pages]));
    // An event's own pages (/devreach-2025/agenda) date like the event: archive after 12 months.
    // /blazor-power, a top-level page, isn't left out by age alone (rules 4).
    assert.deepEqual(by, { conversion: 1, duplicate: 1, archive: 3, year: 3, versions: 0, old: 3 });
    assert.ok(plan.suggestions.every((s) => s.ticked));
    // Sections a rule leaves out whole are named.
    assert.deepEqual(plan.suggestions.find((s) => s.rule === "year")!.wholeSections, []);
    assert.deepEqual(
      planContent(input([...telerik, site("/devreach-2022/speakers", { lastmod: "2022-01-01" })])).suggestions.find(
        (s) => s.rule === "year",
      )!.wholeSections,
      ["/devreach-2022"],
    );
    // devreach-2022 and -2023 are before last year; 2025 isn't.
    const urls = rankPages(input(telerik)).ranked.map((c) => new URL(c.entry.url).pathname);
    assert.ok(!urls.some((u) => u.startsWith("/devreach-2022") || u.startsWith("/devreach-2023")));
    assert.ok(!urls.includes("/devreach-2025/agenda"));
    const withoutArchive = rankPages(input(telerik, { rules: ["conversion", "duplicate", "year", "versions", "old"] })).ranked;
    assert.ok(withoutArchive.some((c) => c.entry.url.endsWith("/devreach-2025/agenda")));
    assert.ok(!urls.includes("/download/thank-you") && !urls.includes("/contact-m") && urls.includes("/contact"));
    // Nothing taken is over two years old unless a person unticked it, or it's a top-level page
    // (rules 4: /blazor-power isn't left out by age alone).
    assert.deepEqual(
      rankPages(input(telerik))
        .ranked.filter((c) => c.date && c.date < "2024-10-30")
        .map((c) => new URL(c.entry.url).pathname),
      ["/blazor-power"],
    );
    assert.equal(plan.eligible, 6);
  });

  it("takes the unticked suggestions back in", () => {
    const plan = planContent(input(telerik, { rules: ["conversion", "duplicate"] }));
    assert.equal(plan.eligible, 11);
    assert.equal(plan.oldestTaken, "2022-02-10");
    assert.deepEqual(planRules(planSummary(plan, TODAY)), ["conversion", "duplicate"]);
  });

  it("labels a filtered number with what it's filtered to", () => {
    const entries = [
      site("/sitefinity-cms"),
      site("/sitefinity-cms/pricing"),
      site("/sitefinity-cms/faq/a"),
      site("/sitefinity-cms/faq/b"),
      site("/blogs/x"),
    ];
    const plan = planContent(input(entries, { include: ["/sitefinity-cms"] }));
    assert.equal(plan.total, 5);
    assert.equal(plan.inScope, 4);
    assert.equal(plan.scope, "under /sitefinity-cms");
    assert.deepEqual(
      plan.sections.map((s) => [s.path, s.pages]),
      [
        ["/sitefinity-cms", 2],
        ["/sitefinity-cms/faq", 2],
      ],
    );
  });

  it("lists every language, selects the served one and labels the unsupported", () => {
    const entries = [
      site("/a", { lang: "en", alternates: 3 }),
      site("/b", { lang: "en", alternates: 3 }),
      site("/de/a", { lang: "de", alternates: 3 }),
      site("/jp/a", { lang: "ja", alternates: 3 }),
      site("/tw/a", { lang: "zh-TW".toLowerCase(), alternates: 3 }),
    ];
    const plan = planContent(input(entries));
    assert.deepEqual(
      plan.languages.map((l) => [l.tag, l.selected, l.supported]),
      [
        ["en", true, true],
        ["de", false, true],
        ["ja", false, false],
        ["zh-tw", false, false],
      ],
    );
    assert.equal(plan.languages.find((l) => l.tag === "zh-tw")!.label, "Chinese (Taiwan)");
    assert.equal(plan.eligible, 2);
    assert.equal(planContent(input(entries, { languages: ["en", "de"] })).eligible, 3);
  });

  it("says when the sitemap has no dates, and still applies the year rule", () => {
    const plan = planContent(input([site("/a"), site("/events-2019/b"), site("/c")]));
    assert.equal(plan.dated, 0);
    assert.equal(plan.eligible, 2);
    assert.equal(plan.undatedTaken, 2);
    assert.equal(plan.oldestTaken, undefined);
  });

  it("counts a date after today as unknown: in ranking, the rules, Newest and Oldest, and the oldest taken", () => {
    // crayola.com on 30 Oct 2026 read "Newest 31 Dec 2026, Oldest 31 Dec 2026" and "31 Dec 2026 –
    // 31 Dec 2025"; kemptechnologies.com's /white-papers newest "31 Dec 2048".
    const entries = [
      site("/free-coloring-pages/halloween-2026"),
      site("/free-coloring-pages/autumn-leaves"),
      site("/learning/summer-2025"),
      site("/learning/back-to-school-2026"),
      site("/white-papers/rsa-2048-bit-keys", { lastmod: "2048-01-01" }),
      site("/white-papers/load-balancing", { lastmod: "2026-03-01" }),
      // A lastmod after today gives way to the address's date, as a bulk-stamped one does.
      site("/white-papers/ssl-offload-2024", { lastmod: "2031-05-01" }),
    ];
    const plan = planContent(input(entries, { rules: [] }));
    const section = (path: string) => plan.sections.find((s) => s.path === path)!;
    assert.deepEqual([section("/free-coloring-pages").newest, section("/free-coloring-pages").oldest], [undefined, undefined]);
    assert.deepEqual([section("/learning").newest, section("/learning").oldest], ["2025-12-31", "2025-12-31"]);
    assert.deepEqual([section("/white-papers").newest, section("/white-papers").oldest], ["2026-03-01", "2024-12-31"]);
    assert.deepEqual([plan.oldestTaken, plan.newestTaken, plan.undatedTaken], ["2024-12-31", "2026-03-01", 4]);
    assert.equal(plan.dated, 1);
    // Ranked as undated (after the dated page), and never "old" or "archive" by it.
    const ranked = rankPages(input(entries, { rules: [] })).ranked;
    const paper = ranked.find((c) => c.entry.url.endsWith("/rsa-2048-bit-keys"))!;
    assert.deepEqual([paper.date, paper.matches], [undefined, []]);
    const papers = ranked.filter((c) => c.section === "/white-papers").map((c) => new URL(c.entry.url).pathname);
    assert.deepEqual(papers, ["/white-papers/load-balancing", "/white-papers/ssl-offload-2024", "/white-papers/rsa-2048-bit-keys"]);
    // A sitemap whose only dates are after today has none.
    assert.equal(planContent(input([site("/a", { lastmod: "2030-01-01" })])).dated, 0);
  });

  it("previews what the budget takes", () => {
    const entries = Array.from({ length: 10 }, (_, i) => site(`/p${i}`, { lastmod: `2026-0${(i % 9) + 1}-01` }));
    const plan = planContent(input(entries, { budget: 3 }));
    assert.equal(plan.taken, 3);
    assert.deepEqual([plan.oldestTaken, plan.newestTaken], ["2026-07-01", "2026-09-01"]);
  });
});

describe("rankPages", () => {
  const order = (entries: PlanEntry[], over: Partial<PlanInput> = {}) =>
    rankPages(input(entries, { rules: [], ...over })).ranked.map((c) => new URL(c.entry.url).pathname);

  it("takes the newest first within a depth, then priority, then sitemap order", () => {
    const entries = [
      site("/a", { lastmod: "2024-01-01" }),
      site("/b", { lastmod: "2026-01-01" }),
      site("/c", { priority: 0.9 }),
      site("/d"),
    ];
    assert.deepEqual(order(entries), ["/b", "/a", "/c", "/d"]);
  });

  it("demotes overview pages below every specific page, without dropping them", () => {
    const entries = [site("/blog"), site("/blog/one"), site("/blog/tag/news"), site("/blog/two")];
    assert.deepEqual(order(entries), ["/blog/one", "/blog/two", "/blog", "/blog/tag/news"]);
    // A page an earlier sync found to be mostly links is demoted too.
    const known = new Map([["https://www.example.com/blog/one", ["overview"]]]);
    const demoted = order(entries, { known });
    assert.equal(demoted[0], "/blog/two");
    assert.ok(demoted.indexOf("/blog/one") > demoted.indexOf("/blog"));
  });

  it("puts the served language, and pages nothing marks, before another chosen language", () => {
    const entries = [site("/de/x", { lang: "de", alternates: 2 }), site("/x"), site("/en/y", { lang: "en", alternates: 2 })];
    assert.deepEqual(order(entries, { languages: ["und", "en", "de"] }), ["/x", "/en/y", "/de/x"]);
  });

  it("takes from every section in turn, so a small budget covers the site", () => {
    // crayola.com: 40 pages from 5,000; the newest blog article gets in ahead of the 30th coloring page.
    const entries = [
      ...Array.from({ length: 30 }, (_, i) => site(`/free-coloring-pages/p${i}`)),
      site("/blog-detail/news/2025/12/02/old-news"),
      site("/blog-detail/news/2026/07/17/what-are-alcohol-markers"),
      site("/blog-listing"),
    ];
    const first = order(entries, { budget: 5 }).slice(0, 5);
    assert.ok(first.includes("/blog-detail/news/2026/07/17/what-are-alcohol-markers"));
    assert.ok(!first.includes("/blog-listing"));
  });
});

describe("pageFlags", () => {
  const facts = { url: "https://www.example.com/a", title: "A page" };
  const opts = { served: ["en"], today: TODAY };

  it("flags each kind of page a partner should look at", () => {
    assert.deepEqual(pageFlags({ ...facts, title: "Thank You | Progress" }, opts), ["conversion"]);
    assert.deepEqual(pageFlags({ ...facts, url: "https://www.example.com/products/a", lastModified: new Date("2024-01-01") }, opts), [
      "old",
    ]);
    assert.deepEqual(pageFlags({ ...facts, lang: "it-IT" }, opts), ["other-language"]);
    assert.deepEqual(pageFlags({ ...facts, title: "Blog Listing" }, opts), ["overview"]);
    assert.deepEqual(pageFlags({ ...facts, linkShare: 0.8, textChars: 900 }, opts), ["overview"]);
    assert.deepEqual(pageFlags({ ...facts, rootChars: 5000, textChars: 1200 }, opts), ["short-text"]);
    assert.deepEqual(
      pageFlags({ ...facts, rootChars: 5000, textChars: 4000, lang: "en-US", lastModified: new Date("2026-01-01") }, opts),
      [],
    );
  });

  it("checks the language only when the sync keeps some", () => {
    assert.deepEqual(pageFlags({ ...facts, lang: "it" }, { served: [], today: TODAY }), []);
  });
});

describe("release notes for earlier versions", () => {
  // progress.com dates every release note with the day its sitemap was regenerated.
  const notes = [
    "15-4-8633-(product-update)",
    "15-1-8324-(patch)",
    "14-4-8138-(patch)",
    "13-3-7621-(patch)",
    "10-2-6653-(patch)",
    "9-16100",
  ].map((v) => site(`/sitefinity-cms/release-notes/sitefinity-cms-${v}`, { lastmod: "2026-07-02" }));

  it("suggests leaving out every version before the newest major, whatever the sitemap dates say", () => {
    const plan = planContent(input([site("/sitefinity-cms/release-notes", { lastmod: "2026-07-02" }), ...notes]));
    assert.equal(plan.suggestions.find((s) => s.rule === "versions")!.pages, 4);
    const kept = rankPages(input(notes)).ranked.map((c) => c.entry.url.split("sitefinity-cms-")[1]);
    assert.deepEqual(kept.sort(), ["15-1-8324-(patch)", "15-4-8633-(product-update)"]);
  });

  it("counts a page named for an earlier version of the product as one (the demo's /sitefinity-cms/13-3-lts)", () => {
    const pages = [
      site("/sitefinity-cms/13-3-lts", { lastmod: "2026-07-02" }),
      site("/sitefinity-cms/15-4-whats-new"),
      site("/other/13-3-lts"),
    ];
    const matches = rankPages(input([...notes, ...pages])).inScope.filter((c) => !c.entry.url.includes("release-notes"));
    assert.deepEqual(
      matches.map((c) => c.matches.includes("versions")),
      [true, false, false],
    );
  });

  it("leaves pages outside a release-notes folder, years, and products with few versions alone", () => {
    const docs = ["15-4", "14-4", "13-3"].map((v) => site(`/docs/upgrade-to-${v}`));
    const years = ["r1-2024", "r2-2025", "r3-2026"].map((v) => site(`/support/whats-new/release-history/kendo-ui-${v}`));
    const two = ["2-1", "3-0"].map((v) => site(`/release-notes/widget-${v}`));
    assert.equal(planContent(input([...docs, ...years, ...two])).suggestions.find((s) => s.rule === "versions")!.pages, 0);
  });
});

describe("helpers", () => {
  it("drops ad-click and campaign parameters, keeping the rest", () => {
    assert.equal(
      withoutTracking("https://www.progress.com/sitefinity-cms/cloud?gad_source=1&gad_campaignid=2034&gbraid=0AA&gclid=x"),
      "https://www.progress.com/sitefinity-cms/cloud",
    );
    assert.equal(withoutTracking("https://a.example/p?lang=de&utm_source=x&fbclid=y"), "https://a.example/p?lang=de");
    assert.equal(withoutTracking("https://a.example/p?page=2"), "https://a.example/p?page=2");
  });

  it("reads dates from addresses and formats days", () => {
    assert.equal(urlDate("https://www.crayola.com/blog-detail/news/2026/07/17/what", TODAY), "2026-07-17");
    assert.equal(urlDate("https://a.example/2024/03/", TODAY), "2024-03-01");
    // A quarter, month or year in the address stands for its last day; the latest counts.
    assert.equal(urlDate("https://a.example/products/2024-q1", TODAY), "2024-03-31");
    assert.equal(urlDate("https://www.telerik.com/webinars/maui-ui/22q4-dt-ww-website-webinar-maui", TODAY), "2022-12-31");
    assert.equal(urlDate("https://www.telerik.com/webinars/kendo-angular-ui/kendo-ui-2025-q2-release-webinar", TODAY), "2025-06-30");
    assert.equal(urlDate("https://a.example/events/q3-2024-roadshow", TODAY), "2024-09-30");
    assert.equal(urlDate("https://www.progress.com/sitefinity-cms/top-websites/july-2014", TODAY), "2014-07-31");
    assert.equal(urlDate("https://www.progress.com/sitefinity-cms/website-of-the-year/2017", TODAY), "2017-12-31");
    assert.equal(urlDate("https://www.telerik.com/devreach-2022/agenda", TODAY), "2022-12-31");
    assert.equal(urlDate("https://a.example/support/kendo-ui-r1-2024-to-r3-2025", TODAY), "2025-12-31");
    assert.equal(urlDate("https://a.example/products/14-4-release", TODAY), undefined);
    assert.equal(formatPlanDay("2025-03-14"), "14 Mar 2025");
  });

  it("takes a date in the address after today as unknown", () => {
    // A white paper on 2048-bit keys, and on 30 Oct 2026 a 2026 page (a year stands for 31 Dec).
    assert.equal(urlDate("https://kemptechnologies.com/white-papers/rsa-2048-bit-keys", TODAY), undefined);
    assert.equal(urlDate("https://www.crayola.com/free-coloring-pages/halloween-2026", TODAY), undefined);
    assert.equal(urlDate("https://a.example/blog/2026/11/02/soon", TODAY), undefined);
    // Within a day of now (time zones) stands, and so does an earlier year beside one that can't.
    assert.equal(urlDate("https://a.example/blog/2026/10/31/in-sydney", TODAY), "2026-10-31");
    assert.equal(urlDate("https://a.example/learning/2025-guide-to-2048-bit-keys", TODAY), "2025-12-31");
  });

  it("takes a print view for a conversion page, but not a folder named print", () => {
    const flags = (path: string) => pageFlags({ url: `https://www.crayola.com${path}` }, { served: [], today: TODAY });
    assert.deepEqual(flags("/recipes/cake/print"), ["conversion"]);
    assert.deepEqual(flags("/free-coloring-pages/print/color-your-own-chart"), []);
    assert.deepEqual(flags("/cms-rfp-template/thank-you"), ["conversion"]);
  });

  it("recognises listing addresses", () => {
    for (const path of [
      "/blog",
      "/blogs",
      "/news",
      "/blog/page/2",
      "/tag/marketing",
      "/blog-listing",
      "/resources?page=3",
      "/faqs/search-results",
    ]) {
      assert.ok(isOverviewUrl(`https://a.example${path}`), path);
    }
    for (const path of ["/blog/how-to", "/products/tags-and-labels", "/page"]) assert.ok(!isOverviewUrl(`https://a.example${path}`), path);
  });
});

describe("bulk-stamped sitemap dates", () => {
  const telerik = fixture<{ entries: [string, string | null][] }>("telerik-archive-sitemap.json").entries.map(([path, lastmod]) => ({
    url: `https://www.telerik.com${path}`,
    ...(lastmod && { lastmod }),
  }));

  it("names the folders whose pages share one sitemap date, and treats those dates as unknown", () => {
    const plan = planContent(input(telerik, { served: ["en"] }));
    const notes = plan.stamped.map(stampNote);
    assert.ok(notes.includes("155 pages in /webinars share the sitemap date 29 Jun 2026"), notes.join("\n"));
    assert.ok(notes.some((n) => /pages in \/whitepapers share the sitemap date 25 Jun 2025/.test(n)));
    assert.ok(notes.some((n) => /pages in \/whitepapers share the sitemap date 14 Mar 2022/.test(n)));
    // /campaigns' dates are spread out: they stand.
    assert.ok(!plan.stamped.some((s) => s.section === "/campaigns"));
    const ranked = rankPages(input(telerik)).inScope;
    const page = (path: string) => ranked.find((c) => c.entry.url === `https://www.telerik.com${path}`)!;
    const webinar = page("/webinars/maui-ui/22q4-dt-ww-website-webinar-maui");
    assert.equal(webinar.stamped, true);
    // Ranked and judged by the date in the address instead: 22q4 is old, 2025-q2 over 12 months.
    assert.equal(webinar.date, "2022-12-31");
    assert.deepEqual(webinar.matches, ["archive", "old"]);
    assert.ok(page("/webinars/kendo-angular-ui/kendo-ui-2025-q2-release-webinar").matches.includes("archive"));
    // No date anywhere: the page's own date decides once it's loaded.
    const whitepaper = page("/whitepapers/aspnet-core-ui/asp.net-mvc-6-changes-every-developer-should-know");
    assert.equal(whitepaper.date, undefined);
    assert.ok(page("/devreach/us/speakers").matches.includes("archive"));
  });

  it("takes none of the pages the executive named", () => {
    const taken = rankPages(input(telerik)).ranked.map((c) => new URL(c.entry.url).pathname);
    for (const path of [
      "/webinars/kendo-angular-ui/kendo-ui-2025-q2-release-webinar",
      "/webinars/maui-ui/22q4-dt-ww-website-webinar-maui",
      "/devreach/us/speakers",
    ]) {
      assert.ok(!taken.includes(path), path);
    }
  });

  it("leaves a folder's dates alone when few pages share a day", () => {
    const entries = Array.from({ length: 40 }, (_, i) => site(`/news/n${i}`, { lastmod: `2026-0${(i % 9) + 1}-1${i % 10}` }));
    assert.deepEqual(planContent(input(entries)).stamped, []);
    assert.ok(rankPages(input(entries)).inScope.every((c) => !c.stamped && c.date === c.entry.lastmod));
  });
});

describe("undated sections", () => {
  const paths = fixture<{ paths: string[] }>("crayola-stain-tips-sitemap.json").paths;
  const entries = paths.map((path) => ({ url: `https://www.crayola.com${path}`, priority: 1 }));

  it("are sampled across the section, not the first pages in alphabetical order", () => {
    const first = rankPages(input(entries, { budget: 12 }))
      .ranked.slice(0, 12)
      .map((c) => c.entry.url.split("/stain-tips/")[1]!);
    const words = new Set(first.map((p) => p.split("-")[0]));
    assert.equal(words.size, 12, first.join("\n"));
    assert.ok(first.filter((p) => p.startsWith("acrylic-paint") || p.startsWith("air-dry-clay")).length <= 2);
  });

  it("lists the pages each section of the plan takes", () => {
    const plan = planContent(input(entries, { budget: 12 }));
    const section = plan.sections.find((s) => s.path === "/stain-tips")!;
    assert.equal(section.takes.length, 12);
    assert.ok(section.takes.every((t) => t.path.startsWith("/stain-tips/")));
  });
});

describe("where the plan's pages came from", () => {
  it("says robots.txt pointed elsewhere and which file it used instead", () => {
    assert.equal(
      discoveryNote({
        how: "fallback",
        why: "elsewhere",
        elsewhere: ["https://www.chef.io/sitemap.xml", "https://www.chef.io/sitemap_video.xml"],
        used: ["https://kemptechnologies.com/sitemap.xml"],
      }),
      "robots.txt points to www.chef.io's sitemaps, so the plan used kemptechnologies.com/sitemap.xml instead.",
    );
    assert.equal(
      discoveryNote({ how: "given", elsewhere: [], used: ["https://www.example.com/en/sitemap.xml"] }),
      "Read from the sitemap address given: www.example.com/en/sitemap.xml.",
    );
    assert.equal(discoveryNote({ how: "robots", elsewhere: [], used: ["https://www.example.com/sitemap.xml"] }), undefined);
    assert.equal(
      crawlNote("https://www.example.com/", 200),
      "No usable sitemap: the first sync follows links from https://www.example.com/, up to 200 pages, 3 clicks deep.",
    );
  });

  it("finds the languages of a site that marks them in hreflang and in its paths", () => {
    // kemptechnologies.com: /de/, /fr/, /es/ and /jp/ prefixes, each page with its hreflang set.
    const entries = [
      site("/hybrid-cloud", { lang: "en", alternates: 4 }),
      site("/de/hybrid-cloud", { lang: "de", alternates: 4 }),
      site("/fr/hybrid-cloud", { lang: "fr", alternates: 4 }),
      site("/es/hybrid-cloud", { lang: "es", alternates: 4 }),
      site("/jp/load-balancer"),
      site("/load-balancer"),
    ];
    const plan = planContent(input(entries));
    assert.deepEqual(plan.languages.map((l) => l.tag).sort(), ["de", "en", "es", "fr", "ja", "und"]);
  });
});

describe("a page's own dates", () => {
  const today = TODAY;
  const wug = {
    url: "https://www.whatsupgold.com/es/blog/el-costo-real-de-un-monitoreo-de-redes",
    lang: "es",
    lastModified: new Date("2026-09-25T00:00:00Z"),
    published: new Date("2016-10-11T13:00:00Z"),
    modified: new Date("2026-09-25T12:42:14Z"),
    articleType: "BlogPosting",
    text: "# El costo real\n\nWhatsUp Gold Premium para 300 dispositivos cuesta $7,995.",
  };

  it("goes by an article's published date, and any other page's modified date", () => {
    assert.deepEqual(pageDate(wug), { date: wug.published, kind: "published" });
    const { articleType: _, ...plain } = wug;
    const pricing = { ...plain, url: "https://www.whatsupgold.com/pricing" };
    assert.deepEqual(pageDate(pricing), { date: wug.modified, kind: "modified" });
    assert.deepEqual(pageDate({ url: "https://a.example/x", lastModified: wug.lastModified }), {
      date: wug.lastModified,
      kind: "modified",
    });
  });

  it("flags a stale price, and leaves an article that states one out with the date it was published", () => {
    const flags = pageFlags(wug, { served: ["en", "es", "de"], today });
    assert.deepEqual(flags, ["old", "stale-commercial"]);
    assert.equal(
      ruleLeaveOut(wug, flags, [], today),
      "States a price, published 11 Oct 2016: an article over 12 months old, so its prices, offers and versions may have changed.",
    );
    // A /pricing page published long ago but updated this year is current (rules 5: teamleader.eu's
    // pricing pages, published 2023 and updated 28 Oct 2026, were called stale).
    const { articleType: _, ...plain } = wug;
    const pricing = { ...plain, url: "https://www.whatsupgold.com/pricing", modified: new Date("2026-09-01") };
    assert.deepEqual(pageFlags(pricing, { served: ["en", "es"], today }), []);
    assert.equal(commercialNote(pricing), "Check this: states a price, updated 2026");
    // Not updated since: it stays in, flagged.
    const stale = { ...pricing, modified: new Date("2021-03-01") };
    const staleFlags = pageFlags(stale, { served: ["en", "es"], today });
    assert.deepEqual(staleFlags, ["stale-commercial"]);
    assert.equal(ruleLeaveOut(stale, staleFlags, ["old", "archive"], today), undefined);
    assert.equal(commercialNote(stale), "Check this: states a price, updated 2021");
  });

  it("applies the 2-year and 12-month rules to the page's own date", () => {
    // whatsupgold.com/blog/raspberry-pi-used-to-steal-500mb-of-data-from-nasa: sitemap 9 Oct 2026.
    const post = {
      url: "https://www.whatsupgold.com/blog/raspberry-pi-used-to-steal-500mb-of-data-from-nasa",
      lastModified: new Date("2026-10-09T00:00:00Z"),
      published: new Date("2019-06-28T00:00:00Z"),
      modified: new Date("2026-10-09T11:42:42Z"),
      articleType: "BlogPosting",
      text: "A Raspberry Pi was used to steal data.",
    };
    const flags = pageFlags(post, { served: ["en"], today });
    assert.deepEqual(flags, ["old"]);
    assert.equal(ruleLeaveOut(post, flags, ["old"], today), "Published 28 Jun 2019: older than 2 years, which the plan leaves out.");
    assert.equal(ruleLeaveOut(post, flags, [], today), undefined);
    // A webinar page published 18 months ago is an archive page.
    const webinar = {
      url: "https://www.telerik.com/webinars/kendo-angular-ui/kendo-ui-2025-q2-release-webinar",
      published: new Date("2025-04-25T05:13:16Z"),
    };
    assert.match(
      ruleLeaveOut(webinar, pageFlags(webinar, { served: [], today }), ["archive"], today)!,
      /^Published 25 Apr 2025: a campaign/,
    );
  });

  it("finds prices, offers and versions in the text", () => {
    for (const text of ["Plans start at $29 per user", "Kostet 1.299 € im Jahr", "USD 99 a month", "Precio: 49,90 EUR"])
      assert.equal(commercialContent(text), "a price", text);
    for (const text of ["Save 30% this week", "20% off every licence", "Use the promo code SPRING", "Jetzt mit Rabatt"])
      assert.equal(commercialContent(text), "a discount or offer", text);
    for (const text of ["What's new in version 13.3", "Sitefinity 13.3 LTS is supported", "The R3 2024 release", "Kendo UI 2025 Q2"])
      assert.equal(commercialContent(text), "a version", text);
    for (const text of ["Open 8 am to 6 pm", "Call 555-0100", "We have 300 devices", "Windows 10 support", "Navigate to 1.2"])
      assert.equal(commercialContent(text), undefined, text);
  });

  it("computes flags for pages synced before the rules, from what's stored", () => {
    // The demo: synced without dates or languages, and never flagged.
    const stored = (path: string, title: string) => ({
      url: `https://www.progress.com/sitefinity-cms${path}`,
      title,
      lang: null,
      lastModified: null,
      publishedAt: null,
      pageModifiedAt: null,
      flags: [],
    });
    const opts = { served: ["en"], today };
    assert.deepEqual(storedFlags(stored("/cms-rfp-template/thank-you", "Thank You"), opts), ["conversion"]);
    assert.deepEqual(storedFlags(stored("/it/trasforma-la-digital-experience-e-il-modo-in-cui-la-offri", "Get To Market"), opts), [
      "other-language",
    ]);
    assert.deepEqual(storedFlags(stored("/top-websites/july-2014", "Sitefinity Top 5 Websites"), opts), ["old"]);
    assert.deepEqual(storedFlags(stored("/website-of-the-year/2017", "2017 Sitefinity Website of the Year Awards"), opts), ["old"]);
    assert.deepEqual(storedFlags(stored("/top-websites/2018-q1", "Sitefinity Top 5 websites Q1 2018"), opts), ["old"]);
    assert.deepEqual(storedFlags(stored("/dxp", "Digital Experience Platform"), opts), []);
    // Flags that need the page loaded are kept until it's read again.
    assert.deepEqual(storedFlags({ ...stored("/faq/headless-support-in-sitefinity", "Headless"), flags: ["short-text"] }, opts), [
      "short-text",
    ]);
    // Dates stored after today aren't the page's: the address's stands in.
    const future = {
      ...stored("/top-websites/2018-q1", "Q1 2018"),
      publishedAt: new Date("2048-01-01"),
      lastModified: new Date("2048-12-31"),
    };
    assert.deepEqual(storedFlags(future, opts), ["old"]);
    const facts = storedFacts(future, today);
    assert.deepEqual([facts.published, facts.lastModified?.toISOString().slice(0, 10)], [undefined, "2018-03-31"]);
  });
});

describe("a page's language", () => {
  it("goes by a language prefix in the address over what the page declares", () => {
    const today = new Date("2026-10-30T12:00:00Z");
    const italian = { url: "https://www.progress.com/sitefinity-cms/it/trasforma-la-digital-experience", lang: "en" };
    assert.equal(pageLanguage(italian), "it");
    assert.ok(pageFlags(italian, { served: ["en"], today }).includes("other-language"));
    assert.match(ruleLeaveOut(italian, ["other-language"], [], today) ?? "", /In another language \(Italian\)/);
    assert.equal(pageLanguage({ url: "https://www.progress.com/sitefinity-cms/pricing", lang: "en-us" }), "en-us");
  });
});

describe("undated sections", () => {
  it("takes picks across the alphabet, not a run from its start", () => {
    const words =
      "acrylic air ballpoint candle chalk clay crayon dye egg fabric glitter glue ink jam lipstick marker nail oil paint putty rust sauce tar wax yogurt zinc".split(
        " ",
      );
    const entries = words.map((w) => site(`/stain-tips/${w}-on-carpet`));
    const picked = planContent(input(entries, { budget: 8 })).taken;
    assert.equal(picked, 8);
    const first = rankPages(input(entries))
      .ranked.slice(0, 8)
      .map((c) => c.entry.url.split("/").at(-1)![0]!);
    assert.ok(first.some((l) => l <= "m") && first.some((l) => l > "m"), first.join(""));
  });

  it("puts undated pages in time-bound folders after the site's specific pages, ahead of listings", () => {
    const entries = [site("/webinars/kendo-ui-release-webinar"), site("/products/grid"), site("/blog"), site("/whitepapers/mvc-changes")];
    const urls = rankPages(input(entries)).ranked.map((c) => new URL(c.entry.url).pathname);
    assert.equal(urls[0], "/products/grid");
    assert.equal(urls.at(-1), "/blog");
  });
});

describe("undated sections that vary in two ways", () => {
  it("spreads the picks across both the first and the last word of the address", () => {
    const stains = ["acrylic", "marker", "crayon", "glue", "paint", "chalk"];
    const surfaces = ["appliances", "carpet", "clothing", "walls", "wood"];
    const entries = stains.flatMap((st) => surfaces.map((su) => site(`/stain-tips/${st}-on-${su}`)));
    const first = rankPages(input(entries))
      .ranked.slice(0, 6)
      .map((c) => c.entry.url.split("/").at(-1)!);
    const surfaceCount = new Set(first.map((u) => u.split("-on-")[1])).size;
    const stainCount = new Set(first.map((u) => u.split("-on-")[0])).size;
    assert.ok(surfaceCount >= 4 && stainCount >= 4, first.join(", "));
  });
});

describe("key pages: what an address names", () => {
  const intent = (path: string, host = "https://www.example.com") => intentOf(`${host}${path}`);

  it("reads the intent one or two levels deep, after a language folder, in the served languages", () => {
    // telerik.com, as SE's review names them.
    assert.equal(intent("/purchase.aspx"), "buy");
    assert.equal(intent("/contact"), "contact");
    assert.equal(intent("/purchase/support-plans"), "support");
    assert.equal(intent("/purchase/request-a-quote"), "price");
    assert.equal(intent("/faqs/pricing-and-licensing/how-can-i-access-support-open-a-support-ticket"), "price");
    // whatsupgold.com's translations, and the words before an intent.
    for (const [path, expected] of [
      ["/pricing", "price"],
      ["/de/preise", "price"],
      ["/de/kontakt", "contact"],
      ["/es/contacto", "contact"],
      ["/it/contatti", "contact"],
      ["/fr/tarification", "price"],
      ["/pt/teste", "trial"],
      ["/start-free-trial", "trial"],
      ["/how-to-buy", "buy"],
      ["/fr/nous-contacter", "contact"],
      ["/es/solicitar-presupuesto", "price"],
      ["/get-in-touch", "contact"],
      ["/es/preguntas-frecuentes", "faq"],
      ["/company/contact-us", "contact"],
    ] as const) {
      assert.equal(intent(path), expected, path);
    }
  });

  it("names none for articles, forum threads, product names that start with a word, and deeper levels", () => {
    for (const path of [
      "/blog/real-cost-of-network-monitor",
      "/blog/pricing-update-2016",
      "/webinars/pricing",
      "/forums/trial-edition",
      "/purchase-order-app-for-sap-netweaver",
      "/ai-engineering/cost-token-usage",
      "/supported-browsers",
      "/helpful-tips",
      "/testimonials",
      "/products/wpf/support",
      "/",
    ]) {
      assert.equal(intent(path), undefined, path);
    }
  });

  it("finds a question's intents by one word and its synonyms", () => {
    assert.deepEqual(questionIntents("How do I contact sales?"), ["contact"]);
    assert.deepEqual(questionIntents("How much do your products cost?"), ["price"]);
    assert.deepEqual(questionIntents("How do I contact support?"), ["contact", "support"]);
    assert.deepEqual(questionIntents("Can I get a free trial or demo?"), ["trial"]);
    assert.deepEqual(questionIntents("Was kostet WhatsUp Gold für 300 Geräte?"), ["price"]);
    assert.deepEqual(questionIntents("¿Cómo contacto con ventas?"), ["contact"]);
    // Not every address word: "store" and "order" mean other things in a question.
    assert.deepEqual(questionIntents("How should I store my markers?"), []);
    assert.deepEqual(questionIntents("How do I get crayon off a painted wall?"), []);
    // The language its intent words are in, when they say.
    assert.equal(questionLanguage("Was kostet WhatsUp Gold für 300 Geräte?"), "de");
    assert.equal(questionLanguage("How do I contact sales?"), "en");
    assert.equal(questionLanguage("Is it nontoxic?"), undefined);
    // A price question can be answered from a buying page (telerik.com's /purchase.aspx).
    assert.deepEqual([...answeringIntents(questionIntents("How much does it cost?"))], ["price", "buy"]);
  });

  it("writes the intent line in the page's language", () => {
    assert.equal(intentLine("contact", "en"), "About this page: how to contact us, including sales and support.");
    assert.match(intentLine("price", "de-de"), /^Über diese Seite: Preise/);
    assert.match(intentLine("contact", "es"), /ventas/);
    // A language the widget doesn't serve: English.
    assert.equal(intentLine("faq", "ja"), intentLine("faq", "en"));
    assert.equal(pageLabel("/purchase/support-plans"), "support plans");
    assert.equal(pageLabel("/purchase.aspx"), "purchase");
    assert.equal(pageLabel("/"), "home page");
  });
});

describe("key pages in the plan", () => {
  // telerik.com's shape: a small root section holding pricing and contact, and big product
  // sections that took every turn in round 4.
  const telerik = (more: PlanEntry[] = []) => [
    site("/"),
    site("/purchase.aspx", { lastmod: "2026-09-01" }),
    site("/contact", { lastmod: "2026-05-01" }),
    site("/purchase/support-plans", { lastmod: "2025-01-10" }),
    // Not updated in 2 years by its sitemap date: a key page all the same.
    site("/purchase/request-a-quote", { lastmod: "2023-02-01" }),
    site("/faqs/pricing-and-licensing/how-can-i-access-support-open-a-support-ticket", { lastmod: "2024-09-03" }),
    site("/blog/our-2016-prices", { lastmod: "2026-10-01" }),
    site("/forums/trial-edition", { lastmod: "2026-10-01" }),
    site("/contact/thank-you", { lastmod: "2026-10-01" }),
    ...Array.from({ length: 1500 }, (_, i) => site(`/products/wpf/control-${i}`, { lastmod: "2026-10-20" })),
    ...Array.from({ length: 1500 }, (_, i) => site(`/products/aspnet-ajax/control-${i}`, { lastmod: "2026-10-20" })),
    ...more,
  ];

  it("takes them before the sections take turns, whatever their age, never from articles or forums", () => {
    const { ranked, keyPages } = rankPages(input(telerik(), { budget: 200 }));
    const first = ranked.slice(0, keyPages.taken.length).map((c) => new URL(c.entry.url).pathname);
    for (const path of ["/purchase.aspx", "/contact", "/purchase/support-plans", "/purchase/request-a-quote"]) {
      assert.ok(first.includes(path), `${path} in ${first.join(", ")}`);
    }
    assert.ok(ranked.every((c) => c.keyPage === first.includes(new URL(c.entry.url).pathname)));
    for (const path of ["/blog/our-2016-prices", "/forums/trial-edition", "/contact/thank-you"]) assert.ok(!first.includes(path), path);
    // The support-ticket FAQ isn't left out by age: no "old" match, taken within the budget.
    const faq = ranked.find((c) => c.entry.url.includes("how-can-i-access-support"))!;
    assert.ok(!faq.matches.includes("old"));
    assert.ok(ranked.indexOf(faq) < 200);
    // The plan line names them.
    const note = keyPagesNote(planContent(input(telerik(), { budget: 200 })).keyPages);
    assert.match(note.taken, /^Key pages: \d+ taken \(.*contact.*\)/);
  });

  it("takes at most an eighth of the budget and 25, a few per intent and language", () => {
    assert.equal(keyPageLimit(200), 25);
    assert.equal(keyPageLimit(5000), 25);
    assert.equal(keyPageLimit(40), 5);
    const many = telerik(Array.from({ length: 60 }, (_, i) => site(`/support/product-${i}`, { lastmod: "2026-10-01" })));
    const { keyPages } = rankPages(input(many, { budget: 200 }));
    assert.ok(keyPages.taken.length <= 25);
    assert.ok(keyPages.taken.filter((k) => k.intent === "support").length <= 4);
    assert.equal(rankPages(input(many, { budget: 40 })).keyPages.taken.length, 5);
  });

  it("names the key pages it couldn't take and why, and what no address names", () => {
    const { keyPages } = rankPages(input(telerik(), { exclude: ["/contact"] }));
    assert.deepEqual(
      keyPages.notTaken.find((k) => k.path === "/contact"),
      { path: "/contact", intent: "contact", why: "left out by you in Leave out" },
    );
    const note = keyPagesNote(keyPages);
    assert.match(note.notTaken!, /\/contact \(left out by you in Leave out\)/);
    // A site with no pricing or support address says so; a buying page counts for pricing.
    const small = rankPages(input([site("/"), site("/contact-us"), site("/about")]));
    assert.deepEqual(small.keyPages.none, ["price", "support"]);
    assert.match(keyPagesNote(small.keyPages).none!, /^No pricing or support page in the sitemaps/);
    assert.deepEqual(rankPages(input([site("/buy"), site("/contact"), site("/help")])).keyPages.none, []);
  });

  it("takes each served language's pricing and contact pages (whatsupgold.com en, de, es)", () => {
    const entries = [
      site("/pricing", { lang: "en", alternates: 8 }),
      site("/de/preise", { lang: "de", alternates: 8 }),
      site("/es/pricing", { lang: "es", alternates: 8 }),
      site("/contact", { lang: "en", alternates: 8 }),
      site("/de/kontakt", { lang: "de", alternates: 8 }),
      site("/es/contacto", { lang: "es", alternates: 8 }),
      site("/fr/contact-commercial", { lang: "fr", alternates: 8 }),
      site("/de/blog/wahren-kosten-von-netzwerk-monitor", { lang: "de", alternates: 1 }),
      ...Array.from({ length: 300 }, (_, i) => site(`/blog/post-${i}`, { lang: "en", lastmod: "2026-10-01" })),
    ];
    const { keyPages } = rankPages(input(entries, { served: ["en", "de", "es"], languages: ["en", "de", "es"] }));
    assert.deepEqual(keyPages.taken.map((k) => k.path).sort(), [
      "/contact",
      "/de/kontakt",
      "/de/preise",
      "/es/contacto",
      "/es/pricing",
      "/pricing",
    ]);
  });

  it("keeps crayola.com's stain tips across surfaces, with key pages within 25 of the 200", () => {
    const paths = fixture<{ paths: string[] }>("crayola-stain-tips-sitemap.json").paths;
    const entries = [
      ...paths.map((path) => ({ url: `https://www.crayola.com${path}`, priority: 1 })),
      ...["/support", "/support/contact-us", "/support/faq", "/products/where-to-buy"].map((p) => ({ url: `https://www.crayola.com${p}` })),
      ...Array.from({ length: 60 }, (_, i) => ({ url: `https://www.crayola.com/faqs/question-${i}-faq` })),
    ];
    const plan = planContent(input(entries, { budget: 200 }));
    assert.ok(plan.keyPages.taken.length <= 25 && plan.keyPages.taken.length >= 4);
    const stains = plan.sections.find((s) => s.path === "/stain-tips")!;
    const surfaces = new Set(stains.takes.map((t) => /-on-(.+?)-stain-tip/.exec(t.path)?.[1]?.split("-")[0]));
    assert.ok(surfaces.size >= 8, [...surfaces].join(", "));
  });
});

describe("live deployments signed off under older checks", () => {
  const entries = [
    site("/contact", { lastmod: "2021-05-01" }),
    site("/faqs/how-to-open-a-ticket", { lastmod: "2022-01-01" }),
    ...Array.from({ length: 40 }, (_, i) => site(`/products/p${i}`, { lastmod: "2026-10-01" })),
  ];

  it("take key pages only when not yet published, or signed off under checks 3 or later", () => {
    assert.equal(takesKeyPages({ published: false, signOff: null }), true);
    assert.equal(takesKeyPages({ published: false, signOff: { checksVersion: 2 } }), true);
    assert.equal(takesKeyPages({ published: true, signOff: { checksVersion: 3 } }), true);
    assert.equal(takesKeyPages({ published: true, signOff: { checksVersion: 2 } }), false);
    // Published with no sign-off: deployments from before sign-off existed.
    assert.equal(takesKeyPages({ published: true, signOff: null }), false);
    assert.equal(takesKeyPages({ published: true }), false);
  });

  it("keep today's selection otherwise: no key pages, and key and FAQ pages age like the rest", () => {
    const now = rankPages(input(entries, { budget: 16 }));
    assert.deepEqual(
      now.keyPages.taken.map((k) => k.path),
      ["/contact", "/faqs/how-to-open-a-ticket"],
    );
    const before = rankPages(input(entries, { budget: 16, keyPages: false }));
    assert.deepEqual(before.keyPages, { limit: 0, taken: [], notTaken: [], none: ["price", "support"] });
    assert.ok(before.ranked.every((c) => !c.keyPage));
    // Old by their sitemap dates, so the ticked "old" rule leaves them out, as before.
    assert.ok(before.inScope.filter((c) => !c.entry.url.includes("/products/")).every((c) => c.matches.includes("old")));
    assert.ok(!before.ranked.some((c) => /contact|faqs/.test(c.entry.url)));
    // As each page loads, too.
    const faq = { url: "https://www.example.com/faqs/how-to-open-a-ticket", modified: new Date("2022-01-01T00:00:00Z") };
    assert.deepEqual(pageFlags(faq, { served: [], today: TODAY }), []);
    assert.deepEqual(pageFlags(faq, { served: [], today: TODAY, keyPages: false }), ["old"]);
  });
});

describe("date rules for key, FAQ, help and support pages", () => {
  const today = TODAY;
  it("never flags them old by age alone; the stale-price rule still applies", () => {
    const old = new Date("2022-01-01T00:00:00Z");
    for (const url of [
      "https://www.telerik.com/faqs/pricing-and-licensing/how-can-i-access-support-open-a-support-ticket",
      "https://www.example.com/contact",
      "https://www.example.com/products/x/faq",
      "https://www.example.com/help-center/reset-password",
    ]) {
      assert.ok(isEvergreenUrl(url), url);
      assert.deepEqual(pageFlags({ url, modified: old }, { served: [], today }), [], url);
    }
    assert.deepEqual(pageFlags({ url: "https://www.example.com/products/x", modified: old }, { served: [], today }), ["old"]);
    // A blog post about support isn't a support page.
    assert.ok(!isEvergreenUrl("https://www.example.com/blog/how-to-submit-a-support-ticket"));
    // The stale-price rule doesn't change: an FAQ article stating a 2016 price is still left out.
    const faq = {
      url: "https://www.example.com/faqs/how-much",
      published: new Date("2016-10-11T00:00:00Z"),
      articleType: "Article",
      text: "It costs $7,995.",
    };
    const flags = pageFlags(faq, { served: [], today });
    assert.deepEqual(flags, ["stale-commercial"]);
    assert.match(ruleLeaveOut(faq, flags, [], today)!, /^States a price, published 11 Oct 2016/);
  });
});

describe("keep it anyway", () => {
  const today = TODAY;
  // whatsupgold.com/blog/real-cost-of-network-monitor, as the marketer added it in round 4.
  const post = {
    url: "https://www.whatsupgold.com/blog/real-cost-of-network-monitor",
    published: new Date("2016-10-11T13:00:00Z"),
    modified: new Date("2026-09-25T12:42:14Z"),
    articleType: "BlogPosting",
    text: "The Total Plus 300 license costs $7,995, with a $2,000 annual service fee.",
  };

  it("asks before keeping a page that trips a date or stale-price rule, in words to ask with", () => {
    const flags = pageFlags(post, { served: ["en"], today });
    const rule = keepRule(post, flags, ["old", "archive", "year"], today)!;
    assert.deepEqual(rule, { kind: "stale-price", ask: "This page states a price and was published 11 Oct 2016." });
    assert.equal(keepAsked(rule).startsWith(KEEP_ASKED), true);
    assert.equal(leaveOutLabel(keepAsked(rule)), "Added by hand: waiting for a reason to keep it");
    // The date rules the plan ticked, by the page's own date or the year in its address.
    const old = { url: "https://www.example.com/products/x", modified: new Date("2022-03-01T00:00:00Z") };
    assert.deepEqual(keepRule(old, pageFlags(old, { served: [], today }), ["old"], today), {
      kind: "date",
      ask: "This page was last updated 1 Mar 2022, over 2 years ago.",
    });
    assert.equal(keepRule(old, pageFlags(old, { served: [], today }), [], today), undefined);
    assert.deepEqual(keepRule({ url: "https://www.example.com/devreach-2022/agenda" }, [], ["year"], today), {
      kind: "date",
      ask: "This page's address names 2022, an earlier year.",
    });
    // A key page by age alone, another language or a thank-you page: nothing to ask.
    const contact = { url: "https://www.example.com/contact", modified: new Date("2020-01-01T00:00:00Z") };
    assert.equal(keepRule(contact, pageFlags(contact, { served: [], today }), ["old"], today), undefined);
  });

  it("sums up what was kept for Review", () => {
    assert.equal(keptSummary([]), undefined);
    assert.equal(
      keptSummary([{ rule: "This page states a price and was published 11 Oct 2016." }]),
      "1 page kept by hand despite a stale price",
    );
    assert.equal(
      keptSummary([
        { rule: "This page states a version and was published 1 Jan 2020." },
        { rule: "This page was published 1 Jan 2020, over 2 years ago." },
      ]),
      "2 pages kept by hand despite a stale price or its date",
    );
    assert.equal(keptKind("This page's address names 2022, an earlier year."), "date");
  });
});

describe("release check fixes: key pages that reach the sync", () => {
  it("reads an intent word last in a short address, and never a numbered, lettered or retired copy", () => {
    assert.equal(intentOf("https://www.progress.com/sitefinity-cms/interactive-demo"), "trial");
    assert.equal(intentOf("https://www.progress.com/sitefinity-cms/request-an-ai-search-demo"), "trial");
    assert.equal(intentOf("https://www.example.com/kendo-ui/core-faq"), "faq");
    for (const path of ["/es/contacto-2", "/es/demo-interactiva-old", "/contact-m", "/pricing-copy"]) {
      assert.equal(intentOf(`https://www.example.com${path}`), undefined, path);
    }
  });

  it("makes a key page titled for its prices a price page, and the buying line names prices and quotes", () => {
    assert.equal(keyIntentFor("buy", "Sitefinity Pricing and Licensing Information"), "price");
    assert.equal(keyIntentFor("faq", "Pricing and licensing FAQ"), "price");
    assert.equal(keyIntentFor("contact", "Contact sales for pricing"), "contact");
    assert.equal(keyIntentFor("buy", "Purchase Orders Policy"), "buy");
    assert.equal(keyIntentFor(null, "Pricing"), null);
    assert.match(intentLine("buy", "en"), /prices, quotes and what it costs/);
    assert.match(intentLine("buy", "de"), /Preise, Angebote/);
  });

  it("reads key pages below Only these paths' prefix as from the site's root", () => {
    const entries = ["/sitefinity-cms/how-to-buy", "/sitefinity-cms/how-to-buy/request-a-quote", "/sitefinity-cms/features"].map((p) => ({
      url: `https://www.progress.com${p}`,
    }));
    const { keyPages } = rankPages(input(entries, { include: ["/sitefinity-cms"], budget: 60 }));
    assert.deepEqual(keyPages.taken.map((k) => [k.path, k.intent]).sort(), [
      ["/sitefinity-cms/how-to-buy", "buy"],
      ["/sitefinity-cms/how-to-buy/request-a-quote", "price"],
    ]);
  });

  it("gives an unusable key page's place to the next of its intent, and keeps it known", () => {
    const entries = [
      site("/support/contact-us"),
      site("/support/global-support"),
      site("/company/contact"),
      ...Array.from({ length: 30 }, (_, i) => site(`/crafts/c${i}`)),
    ];
    const before = rankPages(input(entries, { budget: 200 }));
    assert.ok(before.keyPages.taken.some((k) => k.path === "/support/contact-us"));
    const unusable = new Set(["https://www.example.com/support/contact-us"]);
    const after = rankPages(input(entries, { budget: 200, unusable }));
    assert.ok(!after.keyPages.taken.some((k) => k.path === "/support/contact-us"));
    assert.ok(after.keyPages.taken.some((k) => k.path === "/company/contact"));
    const replaced = after.ranked.find((c) => c.entry.url.endsWith("/support/contact-us"))!;
    assert.equal(replaced.keyUnusable, true);
    assert.equal(replaced.keyPage, false);
    // A page loading found mostly links is still a key page (crayola.com's /support hubs).
    const known = new Map([["https://www.example.com/support/global-support", ["overview"]]]);
    assert.ok(rankPages(input(entries, { known })).keyPages.taken.some((k) => k.path === "/support/global-support"));
  });

  it("takes a contact page with more words in its address only when the language has no plain one", () => {
    const entries = [site("/de/kontakt", { lang: "de" }), site("/de/kontakt-log-management", { lang: "de" })];
    const de = (unusable?: Set<string>) =>
      rankPages(input(entries, { served: ["de"], languages: ["de"], ...(unusable && { unusable }) })).keyPages.taken.map((k) => k.path);
    assert.deepEqual(de(), ["/de/kontakt"]);
    assert.deepEqual(de(new Set(["https://www.example.com/de/kontakt"])), ["/de/kontakt-log-management"]);
  });

  it("changes as little as it can: key pages come in place of the pages at the end of the budget", () => {
    const entries = [
      site("/contact"),
      site("/pricing"),
      ...["a", "b", "c"].flatMap((s) => Array.from({ length: 20 }, (_, i) => site(`/${s}/p${i}`, { lastmod: `2026-0${(i % 9) + 1}-10` }))),
    ];
    const pick = (keyPages: boolean) => {
      const { ranked } = rankPages(input(entries, { budget: 30, keyPages }));
      return selectPages(ranked, new Map(), 30).map((c) => new URL(c.entry.url).pathname);
    };
    const before = pick(false);
    const after = pick(true);
    assert.deepEqual(after.slice(0, 2).sort(), ["/contact", "/pricing"]);
    assert.deepEqual(after.slice(2), before.filter((p) => p !== "/contact" && p !== "/pricing").slice(0, 28));
  });
});

describe("release check fixes: error pages and duplicates", () => {
  it("leaves out an error page served as a normal page", () => {
    // progress.com/sitefinity-cms/try-now/sandbox/invalid-token: "Your Token is Invalid".
    assert.match(
      errorPage({ title: "Sitefinity Hosted Trial", markdown: "# Your Token is Invalid\n\nPlease request a new link.", words: 58 })!,
      /^An error page \("Your Token is Invalid"\)/,
    );
    assert.ok(errorPage({ title: "Page not found | Example", markdown: "Sorry.", words: 3 }));
    assert.ok(errorPage({ title: "Seite nicht gefunden", markdown: "", words: 5 }));
    // A real page that mentions "not found" further down, or a long one, isn't one.
    assert.equal(errorPage({ title: "Lost and found", markdown: "# Lost and found\n\nWhat to do.", words: 80 }), undefined);
    assert.equal(errorPage({ title: "Error codes reference", markdown: "# Error codes", words: 900 }), undefined);
    assert.equal(leaveOutLabel('An error page ("Your Token is Invalid"), with nothing to answer from.'), "Error page");
  });

  it("counts a duplicate synced in place of its canonical against the budget", () => {
    const ranked = rankPages(
      input(
        ["/a", "/b", "/c", "/d"].map((p) => site(p, { lastmod: "2026-10-01" })),
        { budget: 2 },
      ),
    ).ranked;
    // /a points at an http copy outside the ranking, which is synced in its place.
    const dup = new Map([
      ["https://www.example.com/a", { status: "skipped", detail: "Duplicate of http://www.example.com/a, which is synced instead." }],
    ]);
    assert.deepEqual(
      selectPages(ranked, dup, 2).map((c) => new URL(c.entry.url).pathname),
      ["/a", "/b"],
    );
    // Left out for another reason, it doesn't use the budget.
    const thin = new Map([["https://www.example.com/a", { status: "skipped", detail: "Too little text to answer from (3 words)." }]]);
    assert.equal(selectPages(ranked, thin, 2).length, 3);
  });
});

describe("chrome lines a site repeats on page after page", () => {
  // telerik.com in the release check: every docs page ends with "Contact Support", which filled
  // every retrieval slot for "How do I contact support?".
  const docs = ["blazor-ui", "aspnet-core-ui", "kendo-react-ui", "products", "reporting"].flatMap((section) =>
    Array.from({ length: 8 }, (_, i) => ({
      url: `https://www.telerik.com/${section}/documentation/topic-${i}`,
      text: [
        `# ${section} topic ${i}`,
        "In this article",
        `How to configure the ${section} grid, step ${i}.`,
        "- Download Free Trial",
        "Not finding the help you need?",
        "[Contact Support](https://www.telerik.com/account/support-center)",
        "Improve this article",
      ].join("\n\n"),
    })),
  );
  // crayola.com's stain tips share their steps, within one section.
  const tips = Array.from({ length: 24 }, (_, i) => ({
    url: `https://www.crayola.com/stain-tips/tip-${i}`,
    text: ["# Tip", "## Steps", "Place the item stain side down on paper towels.", "Rinse with warm water.", "CONTACT US"].join("\n\n"),
  }));
  // whatsupgold.com's price band, on product pages across the site.
  const products = ["network-monitoring", "log-management", "cloud-monitoring", "application-monitoring"].flatMap((section) =>
    Array.from({ length: 4 }, (_, i) => ({
      url: `https://www.whatsupgold.com/${section}/feature-${i}`,
      text: ["# Feature", "Watch a Demo", `What feature ${i} does.`, "### Business", "Starting from", "$ 1,229"].join("\n\n"),
    })),
  );

  it("finds short lines repeated across sections, never a heading, a figure, or text one section shares", () => {
    const chrome = chromeLines([...docs, ...tips, ...products]);
    for (const line of [
      "contact support",
      "in this article",
      "download free trial",
      "not finding the help you need?",
      "improve this article",
      "watch a demo",
      "starting from",
    ]) {
      assert.ok(chrome.has(line), line);
    }
    for (const line of [
      "rinse with warm water.",
      "place the item stain side down on paper towels.",
      "contact us",
      "### business",
      "business",
      "$ 1,229",
    ]) {
      assert.ok(!chrome.has(line), line);
    }
    // Too few pages to judge.
    assert.equal(chromeLines(docs.slice(0, 7)).size, 0);
  });

  it("drops them, except next to a price, on the key pages they're about, on pricing pages, and in code", () => {
    const chrome = chromeLines([...docs, ...tips, ...products]);
    const page = docs[0]!.text;
    const after = dropChrome(page, chrome);
    assert.equal(after, "# blazor-ui topic 0\n\nHow to configure the blazor-ui grid, step 0.");
    // On a contact or support key page it stays: that's where it belongs.
    assert.match(dropChrome(page, chrome, "contact"), /\[Contact Support\]/);
    assert.match(dropChrome(page, chrome, "support"), /\[Contact Support\]/);
    // A price band keeps its words; a pricing page keeps every line.
    const band = dropChrome(products[0]!.text, chrome);
    assert.match(band, /Starting from\n\n\$ 1,229/);
    assert.doesNotMatch(band, /Watch a Demo/);
    assert.equal(dropChrome(products[0]!.text, chrome, "price"), products[0]!.text);
    // A stain tip keeps its steps; only the site-wide line goes.
    assert.equal(dropChrome(tips[0]!.text, chrome), tips[0]!.text);
    assert.equal(dropChrome("```\nContact Support\n```", chrome), "```\nContact Support\n```");
  });
});

describe("round 5: the home page and top-level pages aren't left out by age alone", () => {
  it("keeps chef.io's / and top-level pages in the plan and unflagged, but not articles or deeper pages", () => {
    const entries = [
      site("/", { lastmod: "2021-02-24" }),
      site("/de", { lastmod: "2021-02-24" }),
      site("/products", { lastmod: "2021-02-24" }),
      site("/products/old-page", { lastmod: "2021-02-24" }),
      site("/blog", { lastmod: "2021-02-24" }),
    ];
    const { inScope } = rankPages(input(entries));
    const matches = Object.fromEntries(inScope.map((c) => [new URL(c.entry.url).pathname, c.matches.join(" ")]));
    assert.deepEqual(matches, { "/": "", "/de": "", "/products": "", "/products/old-page": "old", "/blog": "old" });
    // A live deployment on the selection from before key pages keeps aging them, as before.
    assert.equal(rankPages(input(entries, { keyPages: false })).inScope[0]!.matches.join(" "), "old");
    const old = new Date("2020-12-18T00:00:00Z");
    assert.deepEqual(pageFlags({ url: "https://www.chef.io/", modified: old }, { served: [], today: TODAY }), []);
    assert.deepEqual(pageFlags({ url: "https://www.chef.io/products", modified: old }, { served: [], today: TODAY }), []);
    // A post at the site's root is an article: it still ages.
    assert.deepEqual(
      pageFlags({ url: "https://www.chef.io/my-post", published: old, articleType: "BlogPosting" }, { served: [], today: TODAY }),
      ["old"],
    );
    assert.ok(
      isTopLevelUrl("https://www.example.com/es/") &&
        !isTopLevelUrl("https://www.example.com/blog") &&
        !isTopLevelUrl("https://www.example.com/a/b"),
    );
  });
});

describe("round 5: dates written without a year", () => {
  const sitemap = { date: new Date("2026-10-28T00:00:00Z"), from: "sitemap" as const };

  it("places the marketer's webinar date as 5 November 2026 and writes the year into the text", () => {
    const placed = placeDates("Upcoming Live Webinar: Thursday, November 5 at 11:00 AM (local time)", sitemap, "en");
    assert.equal(placed.text, "Upcoming Live Webinar: Thursday, November 5, 2026 at 11:00 AM (local time)");
    assert.deepEqual(
      placed.dates.map((d) => [d.date, d.readAs, d.yearless]),
      [["2026-11-05", "5 November 2026, from the sitemap date", true]],
    );
    assert.deepEqual(placed.unplaced, []);
  });

  it("reads en, de, fr and es formats, with or without a day name", () => {
    const cases: [string, string, string][] = [
      ["en", "Join us Nov. 12th for a demo", "Join us Nov. 12th, 2026 for a demo"],
      ["en", "on 5 November.", "on 5 November 2026."],
      ["en", "Thu, Nov 5", "Thu, Nov 5, 2026"],
      ["de", "Donnerstag, 5. November um 11 Uhr", "Donnerstag, 5. November 2026 um 11 Uhr"],
      ["de", "Do., 5. Nov. online", "Do., 5. Nov. 2026 online"],
      ["fr", "jeudi 5 novembre à 11h", "jeudi 5 novembre 2026 à 11h"],
      ["fr", "le 1er décembre", "le 1er décembre 2026"],
      ["es", "jueves, 5 de noviembre a las 11", "jueves, 5 de noviembre de 2026 a las 11"],
    ];
    for (const [lang, text, want] of cases) assert.equal(placeDates(text, sitemap, lang).text, want, text);
    // Another language's month names only count on a page in that language.
    assert.equal(placeDates("jeudi 5 novembre", sitemap, "en").dates.length, 0);
  });

  it("leaves a date with no day name far past the page's own date as written: likely a past one", () => {
    const placed = placeDates("Released on March 3. Next session: Nov 12.", sitemap, "en");
    assert.equal(placed.text, "Released on March 3. Next session: Nov 12, 2026.");
    assert.deepEqual(
      placed.dates.map((d) => d.date),
      ["2026-11-12"],
    );
    assert.deepEqual(placed.unplaced, []);
  });

  it("leaves dates that have a year as written, and reads ranges ending in one as dated", () => {
    const placed = placeDates("December 3, 2026 and Dec 10 - 12, 2026. 5. November 2025. 5 de noviembre de 2026.", sitemap, "en");
    assert.equal(placed.text, "December 3, 2026 and Dec 10 - 12, 2026. 5. November 2025. 5 de noviembre de 2026.");
    assert.ok(placed.dates.every((d) => !d.yearless));
    assert.deepEqual(
      placed.dates.map((d) => d.date),
      ["2026-12-03", "2026-12-10", "2025-11-05"],
    );
  });

  it("takes the next occurrence on or after the page's most recent date, agreeing with the day name", () => {
    // An archived 2020 page: its Thursday, November 5 was in 2020, not upcoming.
    assert.equal(placeYear(10, 5, 4, new Date("2020-10-01T00:00:00Z")), 2020);
    // Without a day name, the next occurrence.
    assert.equal(placeYear(10, 5, undefined, new Date("2026-11-06T00:00:00Z")), 2027);
    // A page updated just after its event: the occurrence before the date, when the day name says so.
    assert.equal(placeYear(10, 5, 4, new Date("2026-11-20T00:00:00Z")), 2026);
    // 29 February: the next leap year.
    assert.equal(placeYear(1, 29, undefined, new Date("2026-10-28T00:00:00Z")), 2028);
    // The most recent of the page's dates.
    assert.deepEqual(
      dateAnchor({ published: new Date("2025-09-01"), modified: new Date("2026-01-01"), lastModified: new Date("2026-10-28") }, TODAY).from,
      "sitemap",
    );
    assert.equal(dateAnchor({}, TODAY).from, "read");
  });

  it("leaves a date no year near the page's date fits as written, and flags the page", () => {
    // 5 November falls on a Saturday in 2022 and 2033: no year near 2026 fits.
    const placed = placeDates("Saturday, November 5: the summit", sitemap, "en");
    assert.equal(placed.text, "Saturday, November 5: the summit");
    assert.equal(placed.dates.length, 0);
    assert.match(
      placed.unplaced[0]!.readAs,
      /^Couldn't place "Saturday, November 5": no year near 28 October 2026 \(the sitemap date\) puts 5 November on a Saturday\.$/,
    );
    const flags = pageFlags(
      { url: "https://www.example.com/events/summit", lastModified: new Date("2026-10-28"), text: "Saturday, November 5: the summit" },
      { served: [], today: TODAY },
    );
    assert.deepEqual(flags, ["yearless-date"]);
    // "so" or "do" before a date is a word, not a day name, without its full stop.
    assert.equal(placeDates("so 5 November we went", sitemap, "de").dates[0]!.date, "2026-11-05");
  });
});

describe("round 5: what a page states, and its labels", () => {
  const today = new Date("2026-10-31T12:00:00Z");
  const sitemap = { date: new Date("2026-10-28T00:00:00Z"), from: "sitemap" as const };

  it("keeps each price figure with its line, unit and tier, in local formats", () => {
    const text =
      "# How to buy\n\n## Business\n\n$ 59\n\nper node, per year\n\n## Enterprise\n\n$ 189\n\n## Enterprise Plus\n\nContact us for a customized quote.\n\nAb 1.229 $ pro Jahr. Oder 2.205 US-Dollar | USD 2,205 | 2 205 $ | 49,99 €";
    const facts = statedFacts(
      { url: "https://www.chef.io/how-to-buy", title: "How to buy", text },
      "price",
      placeDates(text, sitemap),
      today,
    );
    assert.deepEqual(
      facts.prices?.map((p) => [p.figure, p.line]),
      [
        ["$ 59", "Business: $ 59 per node, per year"],
        ["$ 189", "Enterprise: $ 189"],
        ["1.229 $", "Enterprise Plus: Ab 1.229 $ pro Jahr."],
        ["2.205 US-Dollar", "Enterprise Plus: Oder 2.205 US-Dollar"],
        ["USD 2,205", "Enterprise Plus: USD 2,205"],
        ["2 205 $", "Enterprise Plus: 2 205 $"],
        ["49,99 €", "Enterprise Plus: 49,99 €"],
      ],
    );
    assert.equal(factsLine(facts, 2), "States: Business: $ 59 per node, per year · Enterprise: $ 189 · and 5 more");
  });

  it("keeps contacts, a contact page's form, a key page's links, and its events with how they were read", () => {
    const text =
      "Call +1 (800) 555-1234 or email sales@example.com.\n\nOffice hours 2019 - 2026.\n\nUpcoming Live Webinar: Thursday, November 5";
    const facts = statedFacts(
      {
        url: "https://www.example.com/contact",
        title: "Contact us",
        text,
        links: ["https://www.example.com/request-a-quote", "https://www.example.com/start-free-trial", "https://www.example.com/blog/x"],
        words: 30,
      },
      "contact",
      placeDates(text, sitemap),
      today,
    );
    assert.deepEqual(
      facts.contacts?.map((c) => [c.kind, c.value]),
      [
        ["email", "sales@example.com"],
        ["phone", "+1 (800) 555-1234"],
        ["form", "https://www.example.com/contact"],
      ],
    );
    assert.deepEqual(
      facts.links?.map((l) => [l.intent, new URL(l.url).pathname]),
      [
        ["contact", "/contact"],
        ["quote", "/request-a-quote"],
        ["trial", "/start-free-trial"],
      ],
    );
    assert.deepEqual(facts.events, [
      { date: "2026-11-05", line: "Upcoming Live Webinar: Thursday, November 5", readAs: "5 November 2026, from the sitemap date" },
    ]);
    // A page that isn't a key page keeps no links, and a past date written with its year isn't an event.
    const post = statedFacts(
      { url: "https://www.example.com/blog/x", text: "Posted March 3, 2019.", links: ["https://www.example.com/trial"] },
      null,
      placeDates("Posted March 3, 2019.", sitemap),
      today,
    );
    assert.deepEqual(post, {});
  });

  it("labels key pages by intent and pages with a date still to come as events", () => {
    assert.deepEqual([...PAGE_LABELS], ["price", "buy", "contact", "support", "trial", "faq", "events"]);
    assert.equal(PAGE_LABELSET, "launchpad_page");
    assert.deepEqual(pageLabels("price", [], today), ["price"]);
    assert.deepEqual(pageLabels(null, [{ date: "2026-11-05", line: "", readAs: "" }], today), ["events"]);
    assert.deepEqual(
      pageLabels(
        "trial",
        [
          { date: "2020-11-05", line: "", readAs: "" },
          { date: "", line: "", readAs: "" },
        ],
        today,
      ),
      ["trial"],
    );
    assert.deepEqual(labelsFor("price"), ["price", "buy"]);
    assert.deepEqual(labelsFor("events"), ["events"]);
    assert.deepEqual(labelFilter("trial"), { field: { prop: "label", labelset: "launchpad_page", label: "trial" } });
    assert.deepEqual(labelFilter("contact", ["rid1"]), {
      field: {
        or: [
          { prop: "label", labelset: "launchpad_page", label: "contact" },
          { prop: "label", labelset: "launchpad_page", label: "support" },
          { prop: "resource", id: "rid1" },
        ],
      },
    });
    // The intent line is metadata, in the page's language.
    assert.deepEqual(pageMetadata("contact", "de"), {
      launchpad: { intent: "contact", about: "Über diese Seite: wie Sie uns kontaktieren, auch Vertrieb und Support." },
    });
    assert.equal(pageMetadata(null, "en"), undefined);
  });

  it("never calls a page in the chat 'not synced'", () => {
    const detail = `Would now be left out: ${KEEP_ASKED}This page states a price and was published 11 Oct 2016.`;
    assert.equal(
      shownDetail(detail, true),
      `Would now be left out: ${KEEP_ASKED_LIVE}This page states a price and was published 11 Oct 2016.`,
    );
    assert.doesNotMatch(shownDetail(detail, true)!, /not synced/);
    assert.equal(shownDetail(detail, false), detail);
    assert.equal(leaveOutLabel(shownDetail(detail, true)!), "Added by hand: in the chat, and needs a reason to stay");
  });
});

describe("round 6 fixes: what a page states", () => {
  const sitemap = { date: new Date("2026-10-28T00:00:00Z"), from: "sitemap" as const };
  const today = new Date("2026-10-31T12:00:00Z");

  it("joins figures split across spans, and gives a placeholder the page's currency (teamwork.com)", () => {
    assert.equal(joinFigures("Basics\n\n$9 .99\n\n/user/month"), "Basics\n\n$9.99\n\n/user/month");
    assert.equal(joinFigures("Basics $ 9.99 | & 24.99"), "Basics $ 9.99 | $24.99");
    // No currency anywhere: the placeholder stays.
    assert.equal(joinFigures("Q & 4"), "Q & 4");
    const text = joinFigures("## Basics\n\n$9 .99\n\n/user/month billed yearly\n\n## Accelerate\n\n$24 .99");
    const facts = statedFacts({ url: "https://www.teamwork.com/pricing/", text }, "price", placeDates(text, sitemap), today);
    assert.deepEqual(
      facts.prices?.map((p) => p.figure),
      ["$9.99", "$24.99"],
    );
  });

  it("compares figures whatever their local format (teamleader.eu)", () => {
    assert.equal(figureValue("1 250 €"), "1250");
    assert.equal(figureValue("1.250 €"), "1250");
    assert.equal(figureValue("€ 24,75"), "24.75");
    assert.equal(figureValue("2.205 US-Dollar"), "2205");
    assert.equal(figureValue("$1,299.50"), "1299.5");
    assert.ok(sameFigure("37,5 €", "37,50 €"));
    assert.ok(sameFigure("1 250 euros", "1.250 €"));
    assert.ok(!sameFigure("250 €", "1 250 €"));
    // "1 250 €" is read whole, and "50 %" or "50 FTE" isn't a price.
    const text = "Forfait unique de 1 250 € hors TVA. 50 % de descuento a partir del sexto usuario. Voorbij de 50 FTE.";
    const facts = statedFacts({ url: "https://www.teamleader.eu/fr/prix", text }, "price", placeDates(text, sitemap), today);
    assert.deepEqual(
      facts.prices?.map((p) => p.figure),
      ["1 250 €"],
    );
    assert.equal(statedFacts({ url: "https://x.example/a", text: "€ 50 % off" }, null, placeDates("", sitemap), today).prices, undefined);
  });

  it("splits a phone number glued to an email address, and keeps deadlines out of events", () => {
    const text = "Call +353 21 2128700sales@teamwork.com\n\nThe subsidy ends on 31 December 2027.\n\nJoin our webinar on 3 December 2026.";
    const facts = statedFacts({ url: "https://www.teamwork.com/contact/", text }, "contact", placeDates(text, sitemap), today);
    assert.deepEqual(
      facts.contacts?.filter((c) => c.kind !== "form").map((c) => [c.kind, c.value]),
      [
        ["email", "sales@teamwork.com"],
        ["phone", "+353 21 2128700"],
      ],
    );
    assert.deepEqual(
      facts.events?.map((e) => e.date),
      ["2026-12-03"],
    );
  });
});

describe("round 6 fixes: the rules", () => {
  it("keeps help, how-to and tips articles in whatever their age (swiffer.com)", () => {
    const old = new Date("2023-01-20T00:00:00Z");
    for (const url of [
      "https://www.swiffer.com/en-us/tips-and-articles/our-cleaning-tips/how-to-clean-tiles-and-grout",
      "https://www.example.com/help-center/reset",
      "https://www.example.com/guides/setup",
    ]) {
      assert.ok(isEvergreenUrl(url), url);
      assert.deepEqual(pageFlags({ url, published: old, articleType: "Article" }, { served: [], today: TODAY }), [], url);
    }
    // A how-to post in the blog still ages.
    assert.ok(!isEvergreenUrl("https://www.example.com/blog/how-to-clean-tiles"));
  });

  it("never takes an e-book, a template or an intent word's product as a key page (teamleader.eu)", () => {
    assert.equal(intentOf("https://www.teamleader.eu/fr/ebooks/devis"), undefined);
    assert.equal(intentOf("https://www.teamleader.eu/nl-be/ebooks/offerte"), undefined);
    assert.equal(intentOf("https://www.teamleader.eu/nl-be/s/offerte-programma"), undefined);
    // A glossary entry, or a page under a campaign's year folder (teamwork.com).
    assert.equal(intentOf("https://www.teamwork.com/glossary/value-based-pricing/"), undefined);
    assert.equal(intentOf("https://www.teamwork.com/2026-strategic-shifts/value-beyond-price/"), undefined);
    assert.equal(intentOf("https://www.teamwork.com/pricing/"), "price");
    assert.equal(intentOf("https://www.teamleader.eu/fr/prix"), "price");
    assert.equal(intentOf("https://www.teamleader.eu/nl-be/prijs"), "price");
  });
});

describe("round 6 fixes: an incomplete sitemap read", () => {
  it("names the languages the unread files' addresses name, and says the first sync reads them again", () => {
    assert.equal(sitemapFileLanguage("https://www.teamleader.eu/fr-be/sitemap.xml"), "fr-be");
    assert.equal(sitemapFileLanguage("https://www.example.com/sitemap-de.xml"), "de");
    assert.equal(sitemapFileLanguage("https://www.example.com/sitemap_it_2.xml"), "it");
    assert.equal(sitemapFileLanguage("https://www.teamleader.eu/sitemap.xml"), undefined);
    const note = incompleteNote({
      failed: [
        { url: "https://www.teamleader.eu/de/sitemap.xml", status: 429 },
        { url: "https://www.teamleader.eu/sitemap-pages.xml", status: 429 },
      ],
      unread: ["https://www.teamleader.eu/it/sitemap.xml", "https://www.teamleader.eu/fr-be/sitemap.xml"],
    })!;
    assert.match(
      note,
      /^The sitemap read is incomplete: 2 sitemap files couldn't be read, even when tried again \(the site answered 429\), and 2 weren't reached in time/,
    );
    assert.match(note, /Languages that may be incomplete: German, Italian, French \(Belgium\), and pages in files that name no language\./);
    assert.match(note, /The first sync reads them again/);
    assert.equal(incompleteNote({ failed: [], unread: [] }), undefined);
  });
});
