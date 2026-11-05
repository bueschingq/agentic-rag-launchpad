import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EXTRACTOR_VERSION, KEEP_ASKED, pageFlags, RULES_VERSION, rankPages } from "../../console/src/lib/content-plan.ts";
import {
  cleanTitle,
  deferToNight,
  discoveryFrom,
  duplicateOf,
  type ExistingPage,
  keyPagesOutcome,
  leftOutMeanwhile,
  listedIntent,
  loadProblem,
  normalizeUrl,
  pageFacts,
  pageHash,
  pageMarkdown,
  pageVerdict,
  readPage,
  retractedAlert,
  selectPages,
  servedLanguages,
  slugFor,
  stillLeftIn,
  TAIL_STOP,
  tailStreak,
  unchanged,
  unusableKeys,
  waitsForReread,
  withoutChrome,
} from "../src/jobs/content.ts";
import type { SitePage } from "../src/sniffer.ts";

const page = (over: Partial<SitePage> = {}): SitePage => ({
  url: "https://www.example.com/visit",
  finalUrl: "https://www.example.com/visit",
  status: 200,
  title: "Visiting hours",
  noindex: false,
  markdown: Array.from({ length: 60 }, (_, i) => `word${i}`).join(" "),
  words: 60,
  links: [],
  ...over,
});

describe("normalizeUrl and slugFor", () => {
  it("treats spellings of the same page as one", () => {
    assert.equal(normalizeUrl("https://WWW.Example.com/Visit/#hours"), "https://www.example.com/Visit");
    assert.equal(normalizeUrl("https://www.example.com/"), "https://www.example.com/");
    assert.equal(slugFor("https://www.example.com/visit/"), slugFor("https://www.example.com/visit#x"));
    assert.notEqual(slugFor("https://www.example.com/visit?lang=es"), slugFor("https://www.example.com/visit"));
    assert.match(slugFor("https://www.example.com/visit"), /^page-[0-9a-f]{32}$/);
  });
});

describe("titles and load problems", () => {
  it("says a repeated title once", () => {
    assert.equal(
      cleanTitle("Google Looker Studio Connector - Sitefinity Insight Google Looker Studio Connector - Sitefinity Insight"),
      "Google Looker Studio Connector - Sitefinity Insight",
    );
    assert.equal(cleanTitle("Talk talk"), "Talk talk");
    assert.equal(cleanTitle("Pricing"), "Pricing");
  });

  it("puts a page-reader error in plain words and keeps network errors", () => {
    assert.doesNotMatch(loadProblem("page.evaluate: TypeError: a.href.split is not a function"), /TypeError|evaluate/);
    assert.equal(loadProblem("net::ERR_NAME_NOT_RESOLVED"), "Didn't load: net::ERR_NAME_NOT_RESOLVED");
  });
});

describe("pageVerdict", () => {
  const listed = new Set(["https://www.example.com/visit", "https://www.example.com/hours"]);

  it("sends a normal page, with a stable hash of what was sent", () => {
    const a = pageVerdict(page(), listed);
    const b = pageVerdict(page(), listed);
    assert.ok(a.send && b.send);
    assert.equal(a.hash, b.hash);
    assert.ok(a.body.startsWith("# Visiting hours"));
  });

  it("explains every page it leaves out", () => {
    const reasons = [
      pageVerdict(page({ error: "net::ERR_NAME_NOT_RESOLVED" }), listed),
      pageVerdict(page({ status: 404 }), listed),
      pageVerdict(page({ noindex: true }), listed),
      pageVerdict(page({ canonical: "https://www.example.com/hours/" }), listed),
      pageVerdict(page({ words: 12 }), listed),
    ];
    assert.deepEqual(
      reasons.map((r) => (r.send ? "send" : r.status)),
      ["failed", "failed", "skipped", "skipped", "skipped"],
    );
    for (const r of reasons) assert.ok(!r.send && r.detail.length > 10);
  });

  it("keeps a page whose canonical is itself, or a page outside the sync", () => {
    assert.ok(pageVerdict(page({ canonical: "https://www.example.com/visit/" }), listed).send);
    assert.ok(pageVerdict(page({ canonical: "https://www.example.com/elsewhere" }), listed).send);
  });

  it("ignores ad-click parameters: a canonical with them is the page itself, and never synced or cited", () => {
    const ads = "https://www.example.com/visit?gad_source=1&gad_campaignid=203&gbraid=0AAA&gclid=Cj0&utm_source=x";
    assert.equal(normalizeUrl(ads), "https://www.example.com/visit");
    assert.equal(normalizeUrl("https://www.example.com/visit?lang=es&gclid=1"), "https://www.example.com/visit?lang=es");
    assert.ok(pageVerdict(page({ canonical: ads }), listed).send);
    const variant = pageVerdict(
      page({ url: "https://www.example.com/visit-b", canonical: `${ads.replace("visit", "visit-new")}` }),
      listed,
      {
        rules: ["duplicate"],
        served: [],
        spare: false,
      },
    );
    assert.ok(!variant.send && variant.canonical === "https://www.example.com/visit-new");
    assert.doesNotMatch(variant.send ? "" : variant.detail, /gad_|gclid/);
  });
});

describe("key pages' intent: labels and metadata, not text", () => {
  it("leaves the intent line out of the text sent, and carries it as labels and metadata", () => {
    const contact = page({ url: "https://www.telerik.com/contact", title: "Contact Us", description: "Phone numbers and offices" });
    const v = pageVerdict(contact, new Set(), { rules: [], served: ["en"], spare: false, intent: "contact" });
    assert.ok(v.send);
    assert.deepEqual(v.body.split("\n\n").slice(0, 2), ["# Contact Us", "> Phone numbers and offices"]);
    assert.ok(v.body.split("\n\n")[2]!.startsWith("word0"));
    assert.doesNotMatch(v.body, /About this page/);
    assert.deepEqual(v.labels, ["contact"]);
    assert.deepEqual(v.metadata, {
      launchpad: { intent: "contact", about: "About this page: how to contact us, including sales and support." },
    });
    // The hash covers the labels, so a page that becomes a key page is sent again.
    const plain = pageVerdict(contact, new Set());
    assert.ok(plain.send && plain.body === v.body && plain.labels.length === 0 && !plain.metadata);
    assert.notEqual(v.hash, plain.hash);
    // A page without labels hashes as it did before labels: it isn't sent again for them.
    assert.equal(plain.hash, pageHash(plain.title, plain.body));
    const de = page({ url: "https://www.whatsupgold.com/de/preise", lang: "de", title: "Preise" });
    const vd = pageVerdict(de, new Set(), { rules: [], served: ["de"], spare: false, intent: "price" });
    assert.ok(vd.send && !vd.body.includes("Über diese Seite") && vd.labels[0] === "price");
  });

  it("writes the year into a date without one, labels a page announcing it, and keeps what it states", () => {
    const webinar = page({
      url: "https://www.whatsupgold.com/resources/webinars/beyond-the-firewall",
      title: "Beyond the Firewall",
      markdown: `${"word ".repeat(50)}\n\nUpcoming Live Webinar: Thursday, November 5 at 11:00 AM (local time)`,
    });
    const today = new Date("2026-10-31T12:00:00Z");
    const facts = pageFacts(webinar, new Date("2026-10-28T00:00:00Z"), today);
    const v = pageVerdict(webinar, new Set(), { rules: [], served: ["en"], spare: false, today }, [], facts);
    assert.ok(v.send);
    assert.match(v.body, /Upcoming Live Webinar: Thursday, November 5, 2026 at 11:00 AM/);
    assert.deepEqual(v.labels, ["events"]);
    assert.deepEqual(v.facts.events, [
      {
        date: "2026-11-05",
        line: "Upcoming Live Webinar: Thursday, November 5 at 11:00 AM (local time)",
        readAs: "5 November 2026, from the sitemap date",
      },
    ]);
    assert.deepEqual(readPage(webinar, facts, null, today).labels, ["events"]);
  });

  it("is stored for the plan's key pages and for pages added by hand whose address names an intent", () => {
    const { ranked } = rankPages({
      entries: ["/contact", "/pricing", "/products/a"].map((path) => ({ url: `https://www.example.com${path}` })),
      served: ["en"],
      rules: [],
      include: [],
      exclude: [],
      budget: 200,
      today: new Date("2026-10-30"),
    });
    const byPath = (path: string) => ranked.find((c) => c.entry.url.endsWith(path));
    assert.equal(listedIntent("https://www.example.com/contact", byPath("/contact"), false), "contact");
    assert.equal(listedIntent("https://www.example.com/products/a", byPath("/products/a"), false), null);
    assert.equal(listedIntent("https://www.example.com/support/x", undefined, true), "support");
    assert.equal(listedIntent("https://www.example.com/support/x", undefined, false), null);
    // None on the selection a live deployment signed off under older checks keeps.
    assert.equal(listedIntent("https://www.example.com/contact", byPath("/contact"), false, false), null);
    assert.equal(listedIntent("https://www.example.com/support/x", undefined, true, false), null);
  });
});

describe("round 5: pages left out by hand that are still in the chat (7a)", () => {
  const row = (path: string, status = "indexed", detail: string | null = null) => ({
    url: `https://www.whatsupgold.com${path}`,
    status,
    detail,
    sentAt: status === "removed" ? null : new Date(),
  });

  it("finds the marketer's page: added by hand, left out by its own path, still answerable", () => {
    const pinned = ["https://www.whatsupgold.com/blog/real-cost-of-network-monitor", "https://www.whatsupgold.com/blog/keep-me"];
    const rows = [
      row("/blog/real-cost-of-network-monitor"),
      row("/blog/keep-me"),
      row("/pricing"),
      row("/private/area", "queued"),
      row("/old", "removed", "Left out by you: its address is in the content settings' Leave out."),
    ];
    assert.deepEqual(stillLeftIn(rows, ["/blog/real-cost-of-network-monitor", "/blog", "/private"], pinned), [
      "https://www.whatsupgold.com/blog/real-cost-of-network-monitor",
      "https://www.whatsupgold.com/private/area",
    ]);
    // Nothing in Leave out: nothing to take out.
    assert.deepEqual(stillLeftIn(rows, [], pinned), []);
  });

  it("posts one alert per deployment, naming the pages", () => {
    const a = retractedAlert(
      { id: "d1", name: "Main site", tenantId: "t1", tenantName: "WhatsUp Gold (marketer r4)" },
      ["https://www.whatsupgold.com/blog/real-cost-of-network-monitor"],
      "https://console.example",
    );
    assert.equal(
      a.message.subject,
      "WhatsUp Gold (marketer r4) › Main site: a page left out by hand was still in the chat, and is out now",
    );
    assert.match(a.message.text, /^Left out earlier, but still answering: \/blog\/real-cost-of-network-monitor\./);
    assert.equal(a.message.link, "https://console.example/customers/t1/deployments/d1/content?status=removed");
    assert.equal(a.key, "retracted:d1:/blog/real-cost-of-network-monitor");
  });
});

describe("round 5: what Add actually changed (7b)", () => {
  it("counts the key pages and other pages that joined, and the pages that left, once the sync is done", () => {
    const before = ["https://www.telerik.com/a", "https://www.telerik.com/b", "https://www.telerik.com/c"];
    const rows = [
      { url: "https://www.telerik.com/a", status: "indexed", keyIntent: null },
      { url: "https://www.telerik.com/b", status: "removed", keyIntent: null },
      { url: "https://www.telerik.com/c/", status: "processing", keyIntent: null },
      { url: "https://www.telerik.com/purchase.aspx", status: "indexed", keyIntent: "price" },
      { url: "https://www.telerik.com/contact", status: "skipped", keyIntent: "contact" },
      { url: "https://www.telerik.com/faq", status: "indexed", keyIntent: null },
    ];
    assert.deepEqual(keyPagesOutcome(before, rows), {
      added: ["https://www.telerik.com/purchase.aspx"],
      joined: ["https://www.telerik.com/faq"],
      dropped: ["https://www.telerik.com/b"],
    });
  });
});

describe("the sync's tail", () => {
  it(`stops after ${TAIL_STOP} replacements in a row are left out too`, () => {
    assert.equal(tailStreak(0, ["skipped", "skipped"]), 2);
    assert.equal(tailStreak(2, ["skipped", "indexed", "skipped"]), 1);
    assert.equal(tailStreak(4, ["skipped"]), TAIL_STOP);
    // One answerable replacement starts the count again.
    assert.equal(tailStreak(4, ["processing"]), 0);
    assert.equal(tailStreak(3, [undefined]), 0);
  });
});

describe("pageMarkdown", () => {
  it("leads with the title and summary, unless the page starts with its own heading", () => {
    assert.equal(
      pageMarkdown({ title: "Hours", description: "When we're open", markdown: "Mon–Fri" }),
      "# Hours\n\n> When we're open\n\nMon–Fri",
    );
    assert.equal(pageMarkdown({ title: "Hours", markdown: "# Opening hours\n\nMon–Fri" }), "# Opening hours\n\nMon–Fri");
  });
});

describe("pageVerdict with the plan's rules", () => {
  const listed = new Set(["https://www.example.com/visit"]);
  const sync = { rules: ["conversion", "duplicate"] as const, served: ["en"], spare: true };

  it("leaves out an A/B variant whose canonical points elsewhere, and names the page to sync instead", () => {
    const v = pageVerdict(page({ url: "https://www.example.com/contact-m", canonical: "https://www.example.com/contact" }), listed, sync);
    assert.ok(!v.send && v.canonical === "https://www.example.com/contact");
    assert.equal(duplicateOf(v.send ? null : v.detail), "https://www.example.com/contact");
    // Without the rule (no plan), only a listed canonical counts, as before.
    assert.ok(pageVerdict(page({ canonical: "https://www.example.com/contact" }), listed).send);
  });

  it("leaves out other languages, conversion pages and, when the budget has spare pages, overviews", () => {
    const reasons = [
      pageVerdict(page({ lang: "it" }), listed, sync, ["other-language"]),
      pageVerdict(page({ title: "Thank you" }), listed, sync, ["conversion"]),
      pageVerdict(page(), listed, sync, ["overview"]),
    ];
    assert.deepEqual(
      reasons.map((r) => (r.send ? "send" : r.status)),
      ["skipped", "skipped", "skipped"],
    );
    // A small site keeps its overview pages: demoted, not dropped.
    assert.ok(pageVerdict(page(), listed, { ...sync, spare: false }, ["overview"]).send);
    // Unticked, a conversion page is synced (and keeps its flag on the content list).
    assert.ok(pageVerdict(page(), listed, { ...sync, rules: [] }, ["conversion"]).send);
  });
});

describe("servedLanguages", () => {
  it("keeps the plan's languages, and the unmarked pages as the site's default beside a chosen one", () => {
    assert.deepEqual(servedLanguages(["und", "en"], "en"), ["en", "und"]);
    assert.deepEqual(servedLanguages(["und", "de"], "auto"), ["de", "und"]);
    assert.deepEqual(servedLanguages(["und", "de"], "de"), ["de", "und"]);
    // Nothing marked at all: the unmarked pages stand for the deployment's own.
    assert.deepEqual(servedLanguages(["und"], "es"), ["es"]);
    assert.deepEqual(servedLanguages(["und"], "auto"), []);
    assert.deepEqual(servedLanguages(["en", "de-de"], "auto"), ["en", "de"]);
    // Deployments from before the plan sync every language; the deployment's own is what it serves.
    assert.deepEqual(servedLanguages([], "en"), ["en"]);
    assert.deepEqual(servedLanguages([], "auto"), []);
  });
});

describe("selectPages and unchanged", () => {
  const ranked = rankPages({
    entries: ["/a", "/b", "/c", "/d"].map((path) => ({ url: `https://www.example.com${path}`, lastmod: "2026-10-01" })),
    served: ["en"],
    rules: [],
    include: [],
    exclude: [],
    budget: 2,
    today: new Date("2026-10-30"),
  }).ranked;
  const row = (path: string, over: Partial<ExistingPage> = {}): [string, ExistingPage] => [
    `https://www.example.com${path}`,
    {
      id: path,
      url: `https://www.example.com${path}`,
      status: "indexed",
      lastModified: new Date("2026-10-01T00:00:00Z"),
      contentHash: "h",
      indexedAt: new Date(),
      sentAt: new Date(),
      extractorVersion: EXTRACTOR_VERSION,
      rulesVersion: RULES_VERSION,
      ...over,
    },
  ];

  it("fills the budget, not counting pages an earlier sync left out", () => {
    assert.deepEqual(
      selectPages(ranked, new Map(), 2).map((p) => p.key),
      ["https://www.example.com/a", "https://www.example.com/b"],
    );
    const existing = new Map([row("/a", { status: "skipped" })]);
    assert.equal(selectPages(ranked, existing, 2).length, 3);
  });

  it("doesn't load a page again while its lastmod is unchanged", () => {
    const [a] = ranked;
    assert.ok(unchanged(a!, row("/a")[1]));
    assert.ok(!unchanged(a!, row("/a", { lastModified: new Date("2026-09-01T00:00:00Z") })[1]));
    assert.ok(!unchanged(a!, row("/a", { status: "failed" })[1]));
    assert.ok(!unchanged(a!, undefined));
    // The sitemap's date as listed counts, not the page's own date stored since.
    assert.ok(
      unchanged(a!, row("/a", { lastModified: new Date("2016-10-11T00:00:00Z"), sitemapLastmod: new Date("2026-10-01T00:00:00Z") })[1]),
    );
  });

  it("isn't unchanged when an older extractor or older rules read it: the nightly batch reads it again", () => {
    const [a] = ranked;
    for (const old of [
      { extractorVersion: EXTRACTOR_VERSION - 1 },
      { rulesVersion: RULES_VERSION - 1 },
      { extractorVersion: 0, rulesVersion: 0 },
    ]) {
      const stale = row("/a", old)[1];
      assert.ok(!unchanged(a!, stale));
      // Not loaded by the re-sync: it waits for the capped nightly re-read.
      assert.ok(waitsForReread(a!, stale));
    }
    // A page whose lastmod changed is loaded by the re-sync, whatever read it.
    assert.ok(!waitsForReread(a!, row("/a", { extractorVersion: 0, lastModified: new Date("2026-09-01T00:00:00Z") })[1]));
    assert.ok(!waitsForReread(a!, row("/a")[1]));
  });

  it("takes pages a person added first, outside the budget", () => {
    const pinned = new Set(["https://www.example.com/d"]);
    assert.deepEqual(
      selectPages(ranked, new Map(), 2, pinned).map((p) => p.key),
      ["https://www.example.com/a", "https://www.example.com/b"],
    );
  });
});

describe("the page's own dates on loading", () => {
  const today = new Date("2026-10-30T12:00:00Z");
  // whatsupgold.com/es/blog/el-costo-real-de-un-monitoreo-de-redes as the sniffer read it.
  const wug = page({
    url: "https://www.whatsupgold.com/es/blog/el-costo-real-de-un-monitoreo-de-redes",
    lang: "es",
    title: "El costo real de un monitoreo de redes",
    datePublished: "2016-10-11T13:00:00",
    dateModified: "2026-09-25T12:42:14",
    articleType: "BlogPosting",
    markdown: `${Array.from({ length: 60 }, (_, i) => `palabra${i}`).join(" ")} WhatsUp Gold para 300 dispositivos: $7,995.`,
  });
  const sync = { rules: ["old", "archive", "conversion"] as const, served: ["en", "es", "de"], spare: true, today };

  it("leaves out a 2016 article that states a price, though its sitemap date is this year", () => {
    const facts = pageFacts(wug, new Date("2026-09-25T00:00:00Z"));
    assert.equal(facts.published?.toISOString().slice(0, 10), "2016-10-11");
    const flags = pageFlags(facts, { served: sync.served, today });
    const verdict = pageVerdict(wug, new Set(), sync, flags, facts);
    assert.ok(!verdict.send);
    assert.match(verdict.send ? "" : verdict.detail, /^States a price, published 11 Oct 2016/);
  });

  it("keeps a page a person added whatever the other rules say, but a stale price only once they kept it with a reason", () => {
    const facts = pageFacts(wug);
    const flags = pageFlags(facts, { served: ["en"], today });
    // Another language gives way to a person's choice; the 2016 price doesn't, until kept.
    const asked = pageVerdict(wug, new Set(), { ...sync, served: ["en"], pinned: true }, flags, facts);
    assert.ok(!asked.send && asked.status === "skipped");
    assert.equal(
      asked.send ? "" : asked.detail,
      `${KEEP_ASKED}This page states a price and was published 11 Oct 2016. Keep it anyway on Content, with a reason, to sync it.`,
    );
    assert.ok(pageVerdict(wug, new Set(), { ...sync, served: ["en"], pinned: true, kept: true }, flags, facts).send);
    assert.ok(!pageVerdict(wug, new Set(), { ...sync, served: ["en"] }, flags, facts).send);
    // A page added by hand that trips no date rule is sent as before.
    const plain = page({ lang: "it" });
    assert.ok(pageVerdict(plain, new Set(), { ...sync, served: ["en"], pinned: true }, ["other-language"], pageFacts(plain)).send);
  });

  // Below the site's top level: a top-level page isn't left out by age alone (rules 4).
  const deeper = (over: Partial<SitePage> = {}) => page({ url: "https://www.example.com/visit/hours", ...over });

  it("dates a page with no date of its own by the plan's date", () => {
    const facts = pageFacts(deeper(), new Date("2023-01-01T00:00:00Z"));
    assert.deepEqual(pageFlags(facts, { served: [], today }), ["old"]);
    assert.match(
      (pageVerdict(deeper(), new Set(), sync, ["old"], facts) as { detail: string }).detail,
      /^Last updated 1 Jan 2023: older than 2 years/,
    );
    // The top-level /visit isn't old by age alone.
    assert.deepEqual(pageFlags(pageFacts(page(), new Date("2023-01-01T00:00:00Z")), { served: [], today }), []);
  });

  it("takes a page's own date after today as unknown, so it's neither ruled on nor stored", () => {
    const facts = pageFacts(deeper({ datePublished: "2048-01-01T00:00:00Z" }), new Date("2023-01-01T00:00:00Z"), today);
    assert.equal(facts.published, undefined);
    assert.deepEqual(pageFlags(facts, { served: [], today }), ["old"]);
    // A plan date after today (stored before the rule) is unknown too; within a day of now isn't.
    assert.equal(pageFacts(page(), new Date("2048-12-31T00:00:00Z"), today).lastModified, undefined);
    assert.ok(pageFacts(page({ dateModified: "2026-10-31T08:00:00+10:00" }), null, today).modified);
  });
});

describe("discoveryFrom", () => {
  it("reads a sitemap address directly, and finds sitemaps from a start page", () => {
    assert.deepEqual(discoveryFrom({ sitemapUrl: "https://kemptechnologies.com/sitemap.xml" }, "https://kemptechnologies.com/"), {
      site: "https://kemptechnologies.com/",
      sitemap: "https://kemptechnologies.com/sitemap.xml",
    });
    assert.deepEqual(discoveryFrom({ sitemapUrl: "https://www.example.com/en/" }, "https://www.example.com/"), {
      site: "https://www.example.com/en/",
    });
    assert.deepEqual(discoveryFrom({ sitemapUrl: null }, "https://www.example.com/"), { site: "https://www.example.com/" });
  });
});

describe("release check fixes in the worker", () => {
  const sync = { rules: ["conversion", "duplicate", "old"] as const, served: ["en"], spare: true };

  it("never leaves a key page out as an overview page", () => {
    assert.ok(!pageVerdict(page({ url: "https://www.crayola.com/support" }), new Set(), sync, ["overview"]).send);
    assert.ok(pageVerdict(page({ url: "https://www.crayola.com/support" }), new Set(), { ...sync, intent: "support" }, ["overview"]).send);
  });

  it("leaves out an error page, even one added by hand", () => {
    const token = page({
      url: "https://www.progress.com/sitefinity-cms/try-now/sandbox/invalid-token",
      title: "Sitefinity Hosted Trial",
      markdown: `# Your Token is Invalid\n\n${"word ".repeat(50)}`,
      words: 58,
    });
    for (const s of [sync, { ...sync, pinned: true, kept: true }]) {
      const v = pageVerdict(token, new Set(), s);
      assert.ok(!v.send && v.status === "skipped" && v.detail.startsWith('An error page ("Your Token is Invalid")'));
    }
  });

  it("takes a canonical that differs only by http or https for the page itself", () => {
    const https = page({
      url: "https://www.whatsupgold.com/infrastructure-monitoring-tool",
      canonical: "http://www.whatsupgold.com/infrastructure-monitoring-tool",
    });
    assert.ok(pageVerdict(https, new Set(["http://www.whatsupgold.com/infrastructure-monitoring-tool"]), sync).send);
  });

  it("knows which key pages loading found unusable, and keeps their intent", () => {
    const rows = [
      { url: "https://www.crayola.com/support/contact-us", status: "skipped", detail: "Too little text to answer from (3 words)." },
      { url: "https://www.crayola.com/faqs/detail-faq", status: "failed", detail: "The site answered 404." },
      { url: "https://www.example.com/blog/x", status: "skipped", detail: "Added by hand, but not synced until someone keeps it: …" },
      { url: "https://www.crayola.com/support", status: "indexed", detail: null },
    ];
    assert.deepEqual([...unusableKeys(rows)], ["https://www.crayola.com/support/contact-us", "https://www.crayola.com/faqs/detail-faq"]);
    const { ranked } = rankPages({
      entries: ["/support/contact-us", "/company/contact"].map((p) => ({ url: `https://www.crayola.com${p}` })),
      served: ["en"],
      rules: [],
      include: [],
      exclude: [],
      budget: 200,
      today: new Date("2026-10-30"),
      unusable: unusableKeys(rows),
    });
    const thin = ranked.find((c) => c.entry.url.endsWith("/support/contact-us"));
    assert.equal(listedIntent(thin!.entry.url, thin, false), "contact");
  });
});

describe("a page without the site's chrome", () => {
  it("drops the lines and counts the words again", () => {
    const text = Array.from({ length: 60 }, () => "word").join(" ");
    const loaded = page({ markdown: [text, "Contact Support"].join(String.fromCharCode(10, 10)), words: 62 });
    const after = withoutChrome(loaded, new Set(["contact support"]), null);
    assert.equal(after.markdown, text);
    assert.equal(after.words, 60);
    // Kept on the support pages; nothing to do without chrome, or for a page that failed.
    assert.equal(withoutChrome(loaded, new Set(["contact support"]), "support"), loaded);
    assert.equal(withoutChrome(loaded, new Set(), null), loaded);
    const failed = page({ error: "net::ERR_FAILED" });
    assert.equal(withoutChrome(failed, new Set(["contact support"]), null), failed);
  });
});

describe("the re-check's sync fixes", () => {
  const [a] = rankPages({
    entries: [{ url: "https://www.example.com/a", lastmod: "2026-10-01" }],
    served: ["en"],
    rules: [],
    include: [],
    exclude: [],
    budget: 10,
    today: new Date("2026-10-30"),
  }).ranked;
  const row = (over: Partial<ExistingPage> = {}): ExistingPage => ({
    id: "a",
    url: "https://www.example.com/a",
    status: "indexed",
    lastModified: new Date("2026-10-01T00:00:00Z"),
    contentHash: "h",
    indexedAt: new Date(),
    sentAt: new Date(),
    extractorVersion: EXTRACTOR_VERSION - 1,
    rulesVersion: RULES_VERSION,
    ...over,
  });

  it("reads a page under an older extractor again on Sync now, though its sitemap date is unchanged", () => {
    // A scheduled re-sync leaves it to the nightly batch; a sync a person asked for doesn't.
    assert.equal(deferToNight(a!, row(), false), true);
    assert.equal(deferToNight(a!, row(), true), false);
    // A page read under today's versions isn't read again either way.
    assert.equal(deferToNight(a!, row({ extractorVersion: EXTRACTOR_VERSION }), false), false);
    assert.ok(unchanged(a!, row({ extractorVersion: EXTRACTOR_VERSION })));
  });

  it("drops a page a person left out while the sync ran, but not one added by hand under a broader pattern", () => {
    const url = "https://www.telerik.com/winui/expander";
    assert.equal(leftOutMeanwhile(url, ["/winui/expander"], []), true);
    assert.equal(leftOutMeanwhile(url, ["/search"], []), false);
    // Added by hand: only its own path left out wins over it.
    assert.equal(leftOutMeanwhile(url, ["/winui"], [url]), false);
    assert.equal(leftOutMeanwhile(url, ["/winui/expander"], [url]), true);
  });
});
