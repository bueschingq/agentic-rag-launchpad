// Fix cycle 7c: events pages, through the plan and the sync. The texts are what janes.com's and
// seeburger.com's events pages stored on 2 Nov 2026 (launchpad_release, read only). The age rule had
// dropped both index pages ("Published 25 Oct 2024: older than 2 years") although each states dates
// still to come, and seeburger.com's German index gave the prompt's events list nothing, so the model
// mixed its dates and hours.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  announcesUpcoming,
  noPriceTableNote,
  type PlanEntry,
  type PlanRule,
  pageFlags,
  placeDates,
  rankPages,
  statedFacts,
  textLanguage,
} from "../../console/src/lib/content-plan.ts";
import { eventsParagraph, eventsToList } from "../../console/src/lib/prompt.ts";
import { goneKeyPage, pageFacts, pageVerdict, readPage, type SyncRules } from "../src/jobs/content.ts";
import type { SitePage } from "../src/sniffer.ts";

const TODAY = new Date("2026-11-02T12:00:00Z");
const RULES: PlanRule[] = ["conversion", "duplicate", "archive", "year", "versions", "old"];

const JANES = `> Discover the world of interconnected intelligence at the following events Janes is exhibiting at.

# Global Defense Events

Connect with us at industry events to discover how Janes turns validated defense and security data into a single picture you can defend, brief, and share.

Fuar Izmir (840. Sokak No: 2, Zafer Mahallesi, 35410 Izmir/Gaziemir)

## NATO EDGE 2026

We are exhibiting at NATO EDGE, November 17 - 19 2026, Stand: B53

Learn More

## Event Recaps

September 14-16, 2026

### AFA Air, Space & Cyber Conference 2026

May 18 - 20 2026

### SOF Week 2026`;

const SEEBURGER = `> Treffen Sie SEEBURGER Integrations-Experten und erfahren Sie mehr über Business Integration bei unseren Live-Veranstaltungen und Webcasts.

# Resource Center Events

Kundentag

Regionalevent München

DEIN APART, München

05. November 2026

14:00 - 17:00 CET (Berlin)

SEEBURGER Integration Summit 2026

Neckarsulm

26. November 2026 - 27. November 2026

Konferenz

SEEBURGER auf dem GS1 EXCHANGE: E-Rechnung 2026

Köln

01. Dezember 2026

Messe

SEEBURGER auf der E-world Energy & Water 2027 in Essen

Essen

16. Februar 2027 - 18. Februar 2027`;

const site = (url: string, markdown: string, more: Partial<SitePage> = {}): SitePage => ({
  url,
  finalUrl: url,
  status: 200,
  title: "Events",
  noindex: false,
  markdown,
  words: markdown.split(/\s+/).length,
  links: [],
  rootChars: markdown.length,
  textChars: markdown.length,
  linkShare: 0,
  extractor: 4,
  ...more,
});

const synced = (page: SitePage) => {
  const facts = pageFacts(page, undefined, TODAY);
  const flags = pageFlags(facts, { served: [], today: TODAY, keyPages: true });
  const sync: SyncRules = { rules: RULES, served: [], spare: true, pinned: false, kept: false, today: TODAY };
  return { flags, verdict: pageVerdict(page, new Set(), sync, flags, facts), read: readPage(page, facts, undefined, TODAY) };
};

describe("the age rule never drops a page stating a date still to come", () => {
  const oldIndex = (url: string, text: string) => site(url, text, { datePublished: "2023-03-30T06:51:21Z" });

  it("janes.com's index: through the plan, then the sync", () => {
    const entries: PlanEntry[] = [
      { url: "https://www.janes.com/company/events", lastmod: "2024-10-25" },
      { url: "https://www.janes.com/company/events/geoint-2025", lastmod: "2025-02-19" },
      ...Array.from({ length: 30 }, (_, i) => ({ url: `https://www.janes.com/news/story-${i}`, lastmod: "2026-10-01" })),
    ];
    const { ranked } = rankPages({ entries, served: ["en"], rules: RULES, budget: 20, today: TODAY, include: [], exclude: [] });
    assert.ok(ranked.find((c) => c.entry.url === "https://www.janes.com/company/events")?.keyPage, "the plan takes the index");
    const { flags, verdict } = synced(oldIndex("https://www.janes.com/company/events", JANES));
    assert.ok(!flags.includes("old"), "no age flag");
    assert.equal(verdict.send, true, "the sync sends it");
  });

  it("seeburger.com's German index, whose lines hold only dates", () => {
    const { verdict } = synced(oldIndex("https://www.seeburger.com/de/ressourcen/events", SEEBURGER));
    assert.equal(verdict.send, true);
  });

  it("an index whose <html lang> says nothing of its language still counts", () => {
    const page = oldIndex("https://x.example/agenda", "Prochain rendez-vous: du 5 au 7 décembre 2026 à Lyon, salle 3.");
    assert.ok(announcesUpcoming(pageFacts(page, undefined, TODAY), TODAY));
  });

  it("a page with only past dates still ages out, with its reason", () => {
    const { verdict } = synced(
      oldIndex(
        "https://x.example/events/old-summit",
        "The summit took place on 3 May 2023 in Paris, with sessions on many subjects across the day.",
      ),
    );
    assert.equal(verdict.send, false);
    assert.match(!verdict.send ? (verdict.detail ?? "") : "", /older than 2 years|over 12 months old/);
  });

  it("an events index with a date to come isn't left out as an overview either", () => {
    const page = site("https://x.example/events", JANES, { linkShare: 0.8, textChars: 500 });
    assert.equal(synced(page).verdict.send, true);
  });
});

describe("the events list reads dates in every supported language", () => {
  const dates = (text: string, lang: string) =>
    placeDates(text, { date: TODAY, from: "read" }, lang).dates.map((d) => (d.rangeEnd ? `..${d.date}` : d.date));

  it("day before month, in ranges, with 'bis', 'vom', 'al', 'au'", () => {
    assert.deepEqual(dates("17-19 November 2026", "en"), ["2026-11-17", "..2026-11-19"]);
    assert.deepEqual(dates("vom 5. bis 7. November 2026", "de"), ["2026-11-05", "..2026-11-07"]);
    assert.deepEqual(dates("5.–7. November 2026", "de"), ["2026-11-05", "..2026-11-07"]);
    assert.deepEqual(dates("del 5 al 7 de noviembre de 2026", "es"), ["2026-11-05", "..2026-11-07"]);
    assert.deepEqual(dates("du 5 au 7 novembre 2026", "fr"), ["2026-11-05", "..2026-11-07"]);
    assert.deepEqual(dates("26. November 2026 - 27. November 2026", "de"), ["2026-11-26", "..2026-11-27"]);
    assert.deepEqual(dates("vom 30. November bis 2. Dezember 2026", "de"), ["2026-11-30", "..2026-12-02"]);
  });
  it("two days named together are two dates, not a range", () => {
    assert.deepEqual(dates("Live webinars, 4 & 5 Nov", "en"), ["2026-11-04", "2026-11-05"]);
  });
  it("dates in numbers", () => {
    assert.deepEqual(dates("Termin: 05.11.2026", "de"), ["2026-11-05"]);
    assert.deepEqual(dates("2026-11-05", "en"), ["2026-11-05"]);
    assert.deepEqual(dates("11/05/2026", "en"), ["2026-11-05"]);
    assert.deepEqual(dates("05/11/2026", "fr"), ["2026-11-05"]);
    assert.deepEqual(dates("Version 12.13.2026", "de"), []);
  });
  it("a date-only line is stored with what names it, and its hours stay with it", () => {
    const { read } = synced(site("https://www.seeburger.com/de/ressourcen/events", SEEBURGER));
    const events = read.facts.events ?? [];
    assert.deepEqual(
      events.map((e) => e.date),
      ["2026-11-05", "2026-11-26", "2026-12-01", "2027-02-16"],
    );
    assert.match(events[0]!.line, /Regionalevent München.*05\. November 2026 14:00 - 17:00 CET/);
    assert.match(events[1]!.line, /SEEBURGER Integration Summit 2026 · Neckarsulm · 26\. November 2026 - 27\. November 2026$/);
    assert.match(events[2]!.line, /GS1 EXCHANGE.*Köln · 01\. Dezember 2026/);
    assert.doesNotMatch(events[1]!.line, /14:00/);
  });
  it("the prompt's list gets each event's own date", () => {
    const { read } = synced(site("https://www.seeburger.com/de/ressourcen/events", SEEBURGER));
    // An events index lists each of its events; an event's own page keeps one.
    const paragraph = eventsParagraph(
      (read.facts.events ?? []).map((e) => ({
        date: e.date,
        line: e.line,
        url: "https://www.seeburger.com/de/ressourcen/events",
        title: "Events",
      })),
    );
    assert.match(paragraph, /5 November 2026: .*Regionalevent München/);
    assert.match(paragraph, /26 November 2026: .*Integration Summit 2026/);
    assert.match(paragraph, /1 December 2026: .*GS1 EXCHANGE/);
    assert.match(paragraph, /16 February 2027: .*E-world/);
    const own = "https://x.example/webinars/ai-margin";
    const list = eventsToList([
      { date: "2026-11-04", url: own, line: "Wednesday, November 4th" },
      { date: "2026-11-05", url: own, line: "Thursday, November 5th, in the sidebar" },
    ]);
    assert.equal(list.length, 1);
    const twoSessions = eventsToList([
      { date: "2026-11-17", url: "https://x.example/events", line: "Afternoon · 17 Nov 2026 at 14:00 GMT" },
      { date: "2026-11-17", url: "https://x.example/events", line: "Morning · 17 Nov 2026 at 10:00 GMT" },
    ]);
    assert.equal(twoSessions.length, 2);
  });
  it("a date on an events page is an event's whatever its line says; elsewhere a deadline isn't", () => {
    const text = "We are exhibiting at NATO EDGE, November 17 - 19 2026, Stand: B53";
    const placed = placeDates(text, { date: TODAY, from: "read" }, "en");
    assert.equal(statedFacts({ url: "https://x.example/company/events", text }, null, placed, TODAY).events?.[0]?.date, "2026-11-17");
    assert.equal(statedFacts({ url: "https://x.example/about", title: "About", text }, null, placed, TODAY).events, undefined);
  });
  it("hms-networks.com: dates in a card's first line, each named by the heading below", () => {
    const text =
      "### Upcoming events\n\n|\n\n17 Nov 2026 at 14:00 GMT\n\n##### Defend Uptime (Afternoon Session)\n\n17 Nov 2026 at 10:00 GMT\n\n##### Defend Uptime (Morning Session)\n\n28 Oct 2026 at 14:00 GMT+1\n\n##### Engineering Day 2026";
    const placed = placeDates(text, { date: TODAY, from: "read" }, "en");
    const events = statedFacts({ url: "https://www.hms-networks.com/events", text }, null, placed, TODAY).events ?? [];
    assert.deepEqual(
      events.map((e) => e.date),
      ["2026-11-17", "2026-11-17"],
    );
    assert.match(events[0]!.line, /Afternoon Session\) · 17 Nov 2026 at 14:00 GMT/);
    assert.match(events[1]!.line, /Morning Session\) · 17 Nov 2026 at 10:00 GMT/);
  });
  it("northwesternenergy.com: on a long line, each date keeps its own words, not another date's", () => {
    const line =
      "NorthWestern Energy Group, Inc. d/b/a NorthWestern Energy (Nasdaq: NWE) today announced that it will host an investor webinar on Thursday, November 5, 2026, at 11:00 a.m. Eastern to review its financial results for the quarter ending September 30, 2026. The Company also plans to issue a news release detailing its financial results the evening of Wednesday, November 4, 2026.";
    const dates = placeDates(line, { date: TODAY, from: "read" }, "en").dates;
    const on = (d: string) => dates.find((x) => x.date === d)!;
    assert.match(on("2026-11-05").line, /webinar on Thursday, November 5, 2026/);
    assert.equal(on("2026-11-05").readAs, "5 November 2026, as written");
    assert.match(on("2026-11-04").line, /Wednesday, November 4, 2026/);
    assert.doesNotMatch(on("2026-11-04").line, /November 5/);
  });
  it("a heading right below a date names it", () => {
    const text = "## Coming up\n\nDecember 14-16, 2026\n\n### AFA Air Conference";
    const placed = placeDates(text, { date: TODAY, from: "read" }, "en");
    assert.match(
      statedFacts({ url: "https://x.example/events", text }, null, placed, TODAY).events?.[0]?.line ?? "",
      /AFA Air Conference · December 14-16, 2026/,
    );
  });
});

describe("a page's language, a key page's address", () => {
  const SPANISH =
    "Todo lo que obtiene con la edición Standard y más. Con este producto usted puede convertir y organizar sus documentos de la forma más rápida para el trabajo. " +
    "Es una oferta para los clientes que ya tienen una licencia y que quieren actualizar a la nueva versión del producto, con las funciones que se han añadido para su empresa. " +
    "Por tiempo limitado, el precio es de 129 € y se puede comprar en la tienda en línea, con el soporte de nuestro equipo en todo el mundo.";

  it("a Spanish page under <html lang='en'> doesn't sync into an English deployment", () => {
    const page = site("https://x.example/eg/paperport/fn/es/upgrade-50off", SPANISH, { lang: "en", title: "PaperPort Upgrade Offer" });
    assert.equal(textLanguage(SPANISH), "es");
    const facts = pageFacts(page, undefined, TODAY);
    const flags = pageFlags(facts, { served: ["en"], today: TODAY });
    assert.ok(flags.includes("other-language"));
    const verdict = pageVerdict(
      page,
      new Set(),
      { rules: RULES, served: ["en"], spare: false, pinned: false, kept: false, today: TODAY },
      flags,
      facts,
    );
    assert.equal(verdict.send, false);
    assert.match(!verdict.send ? (verdict.detail ?? "") : "", /In another language \(Spanish/);
  });
  it("an English page keeps its region, and a short or mixed text says nothing", () => {
    const en =
      "This is the page for all of our customers who want to read about the product and how it can be used with your team. We have a plan for you, and you can start with it today, or talk to our team about what is on the list for the year. It is also the place to find out how the product will work for you and what we can do to help with it.";
    assert.equal(textLanguage(en), "en");
    assert.equal(pageFacts(site("https://x.example/a", en, { lang: "en-GB" }), undefined, TODAY).lang, "en-gb");
    assert.equal(textLanguage("Regionalevent München DEIN APART"), undefined);
    assert.equal(textLanguage(`${en} ${SPANISH}`), undefined);
  });
  it("a page that answers 404 is never a key page, unless it was once in the chat", () => {
    assert.equal(goneKeyPage({ detail: "The site answered 404." }), true);
    assert.equal(goneKeyPage({ detail: "The site answered 410.", indexedAt: null }), true);
    assert.equal(goneKeyPage({ detail: "The site answered 404.", indexedAt: TODAY }), false);
    assert.equal(goneKeyPage({ detail: "The site answered 500." }), false);
    assert.equal(goneKeyPage({ detail: null }), false);
  });
  it("before anything is read, the table's note doesn't claim no pricing page was found", () => {
    assert.equal(noPriceTableNote(undefined, false), "No price table yet: no page has been read.");
  });
});
