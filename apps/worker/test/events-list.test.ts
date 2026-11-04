// Answering rules 4 (round 6, recheck 2): the events configuration's prompt lists the site's upcoming
// events, soonest first with full dates, and the daily date refresh keeps the list current.
// teamwork.com's chat led with the 5 Nov webinar over the 4 Nov one 4 of 4 times under v3: the
// model sorted and placed dates from a "Latest Webinars" sidebar and a site-wide banner.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { todayRule } from "@launchpad/theme";
import {
  composeSystemPrompt,
  EVENTS_LIST_START,
  EVENTS_LISTED,
  eventPagePaths,
  eventsParagraph,
  eventsToList,
  intentSearchConfig,
  type PromptEvent,
  searchConfigFor,
  withEventsParagraph,
} from "../../console/src/lib/prompt.ts";
import { addsToEventsList } from "../src/jobs/content.ts";
import { datedConfig } from "../src/jobs/prompt-date.ts";

// teamwork.com's events facts on 1 Nov 2026 (release DB, read only), in upcomingEvents' order.
const banner = (url: string): PromptEvent => ({
  date: "2026-11-05",
  url,
  line: "AI saves hours. Don’t let it cost you margin. Live webinars, 4 & 5 Nov.Register now →",
  title: "A blog post",
});
const teamwork: PromptEvent[] = [
  {
    date: "2026-11-04",
    url: "https://www.teamwork.com/teams/agencies/",
    line: "Is AI a margin lever or a slow price cut? Find out live, Nov 4.Register now →",
    name: "Agency Operations Platform",
    title: "Agency Operations Platform & PSA for Agencies",
  },
  {
    date: "2026-11-04",
    url: "https://www.teamwork.com/webinars/ai-margin-agencies/",
    line: "Wednesday, November 4th · 8:00am PST / 11:00am EST / 4:00pm GMT",
    name: "The Agency of 2027: Turning AI Savings Into Margin",
    title: "How AI Impacts Agency Profit Margins",
  },
  banner("https://www.teamwork.com/"),
  banner("https://www.teamwork.com/blog/approval-workflows/"),
  banner("https://www.teamwork.com/blog/capacity-planning-tools/"),
  {
    date: "2026-11-05",
    url: "https://www.teamwork.com/teams/consulting/",
    line: "AI: a margin lever, or a slow price cut on every engagement? Join us live, Nov 5.Register now →",
    title: "Profitable Projects for Consulting Firms",
  },
  {
    date: "2026-11-05",
    url: "https://www.teamwork.com/webinars/ai-margin-professional-services/",
    line: "Thursday, November 5th · 8:00am PST / 11:00am EST / 4:00pm GMT",
    name: "Professional Services in 2027: When AI Joins the Team",
    title: "How AI Impacts Professional Services Margins",
  },
];

describe("the events configuration's list of upcoming events", () => {
  it("lists teamwork.com's two webinars, 4 Nov first, by their full dates and names", () => {
    assert.deepEqual(
      eventsToList(teamwork).map((e) => e.url),
      ["https://www.teamwork.com/webinars/ai-margin-agencies/", "https://www.teamwork.com/webinars/ai-margin-professional-services/"],
    );
    const paragraph = eventsParagraph(teamwork);
    const lines = paragraph.split("\n");
    assert.ok(lines[0]!.startsWith(EVENTS_LIST_START));
    assert.match(
      lines[1]!,
      /^- Wednesday, 4 November 2026: The Agency of 2027: Turning AI Savings Into Margin \(our page "How AI Impacts Agency Profit Margins"\)/,
    );
    assert.match(lines[2]!, /^- Thursday, 5 November 2026: Professional Services in 2027: When AI Joins the Team/);
    assert.match(lines.at(-1)!, /The first one listed is the next/);
  });

  it("keeps a banner only for a date nothing else gives, and lists promoting pages when no event page does", () => {
    const promo = teamwork.filter((e) => !e.url.includes("/webinars/"));
    assert.deepEqual(
      eventsToList(promo).map((e) => e.url),
      ["https://www.teamwork.com/teams/agencies/", "https://www.teamwork.com/teams/consulting/"],
    );
    const banners = [banner("https://x.example/a"), banner("https://x.example/b"), banner("https://x.example/c")];
    assert.deepEqual(
      eventsToList(banners).map((e) => e.url),
      ["https://x.example/a"],
    );
  });

  it("lists soonest first, one line per page, at most EVENTS_LISTED", () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      date: `2026-12-${String(12 - i).padStart(2, "0")}`,
      url: `https://x.example/events/e${i}`,
      line: `Event ${i}`,
    }));
    const listed = eventsToList([...many, { ...many[0]!, date: "2026-12-20" }]);
    assert.equal(listed.length, EVENTS_LISTED);
    assert.deepEqual(
      listed.map((e) => e.date),
      [...listed.map((e) => e.date)].sort(),
    );
    assert.equal(new Set(listed.map((e) => e.url)).size, listed.length);
  });

  it("says when nothing is dated today or later", () => {
    assert.equal(eventsParagraph([]), `${EVENTS_LIST_START}, as our website's pages date them: none is dated today or later.`);
  });

  it("sits in the events configuration only, just before the date", () => {
    const today = new Date("2026-11-01T08:00:00Z");
    const filter = { field: { prop: "label", labelset: "launchpad_page", label: "events" } };
    const events = (intentSearchConfig("Be brief.", "en", "events", filter, today, false, teamwork).prompt as { system: string }).system;
    const parts = events.split("\n\n");
    assert.ok(parts.at(-2)!.startsWith(EVENTS_LIST_START));
    assert.equal(parts.at(-1), todayRule(today));
    const price = (intentSearchConfig("Be brief.", "en", "price", filter, today, false, teamwork).prompt as { system: string }).system;
    assert.equal(price.includes(EVENTS_LIST_START), false);
    assert.equal((searchConfigFor("Be brief.", "en", today).prompt as { system: string }).system.includes(EVENTS_LIST_START), false);
  });
});

describe("the daily refresh of the events list", () => {
  const friday = new Date("2026-10-30T23:00:00Z");
  const sunday = new Date("2026-11-01T00:05:00Z");
  const old = eventsParagraph([teamwork[2]!]);
  const saved = {
    query: "",
    citations: true,
    prompt: { system: `${composeSystemPrompt("Be brief.", "en", null)}\n\n${old}\n\n${todayRule(friday)}`, user: "Rules." },
  };

  it("replaces the list with today's, with the date", () => {
    const fresh = eventsParagraph(teamwork);
    const config = datedConfig(saved, sunday, undefined, fresh);
    assert.ok(config);
    const prompt = config.prompt as { system: string; user: string };
    assert.equal(prompt.system, `${composeSystemPrompt("Be brief.", "en", null)}\n\n${fresh}\n\n${todayRule(sunday)}`);
    assert.equal(prompt.user, "Rules.");
  });

  it("writes nothing when the list and the date are current", () => {
    const current = { ...saved, prompt: { ...saved.prompt, system: `Be brief.\n\n${old}\n\n${todayRule(sunday)}` } };
    assert.equal(datedConfig(current, sunday, undefined, old), undefined);
  });

  it("never adds a list to a prompt saved without one (rules below 4 wait for their re-check)", () => {
    const before = { prompt: { system: `Be brief.\n\n${todayRule(friday)}` } };
    assert.equal(withEventsParagraph(before.prompt.system, eventsParagraph(teamwork)), before.prompt.system);
    const config = datedConfig(before, sunday, undefined, eventsParagraph(teamwork));
    assert.ok(config);
    assert.equal((config.prompt as { system: string }).system, `Be brief.\n\n${todayRule(sunday)}`);
  });
});

// mvtec.com on 3 Nov 2026: its index and detail page state the same events, in two languages, and the
// long German lines end in the date (saved from verification U2's C-facts-events.json).
const de = (date: string, line: string, url = "https://www.mvtec.com/de/wissensportal/events"): PromptEvent => ({
  date,
  url,
  line,
  lang: "de",
});
const en = (date: string, line: string, url = "https://www.mvtec.com/knowledge-base/events"): PromptEvent => ({
  date,
  url,
  line,
  lang: "en",
});
const webinarDe =
  "Webinar: Fortgeschrittenes Deep Learning für die industrielle Bildverarbeitung · Erfahren Sie, wie Sie unerwartete Fälle erkennen, sich an veränderte Produktionsanforderungen anpassen und zuverlässigere Deep-Learning-Anwendungen für die i… · 05. November 2026";
const mvtec: PromptEvent[] = [
  de("2026-11-05", webinarDe),
  de("2026-11-05", webinarDe, "https://www.mvtec.com/de/wissensportal/events/detail"),
  en("2026-11-05", "Webinar: Advanced deep learning for industrial vision (Asia & Europe) · Learn how · November 05, 2026"),
  en("2026-11-05", "Webinar: Advanced deep learning for industrial vision (America) · America · November 05, 2026"),
  en(
    "2026-11-05",
    "Webinar: Advanced deep learning for industrial vision (Asia & Europe) · Learn how · November 05, 2026",
    "https://www.mvtec.com/knowledge-base/events/detail",
  ),
  ...Array.from({ length: 9 }, (_, i) =>
    en(`2026-12-${String(i + 1).padStart(2, "0")}`, `Germany · Trade fair number ${i} in Berlin · December ${i + 1}, 2026`),
  ),
  de(
    "2027-03-16",
    "Deutschland · Embedded Vision mit MVTec erleben – auf der embedded world 2027 · Treffen Sie unsere Experten · 16. - 18. März 2027",
  ),
];

describe("the events list on a site in two languages (round 7)", () => {
  it("tells each event once, across its index, its detail page and its sessions", () => {
    const listed = eventsToList(mvtec);
    assert.equal(listed.filter((e) => e.date === "2026-11-05" && e.lang === "de").length, 1);
    assert.equal(listed.filter((e) => e.date === "2026-11-05" && e.lang === "en").length, 1);
  });

  it("keeps room per language: English events don't crowd out a German one", () => {
    const listed = eventsToList(mvtec);
    assert.ok(listed.some((e) => e.line.includes("embedded world")));
    assert.equal(listed.filter((e) => e.lang === "en").length, EVENTS_LISTED);
    assert.deepEqual(
      listed.map((e) => e.date),
      [...listed.map((e) => e.date)].sort(),
    );
  });

  it("two different events on one day stay two", () => {
    const listed = eventsToList([
      en("2027-01-10", "Germany · Meet us at Hannover Messe · January 10, 2027"),
      en("2027-01-10", "France · Visit the booth at Global Industrie · January 10, 2027"),
    ]);
    assert.equal(listed.length, 2);
  });

  it("puts the page's own date first, where a cut would lose it, and doesn't name the event after the index", () => {
    const line = eventsParagraph([{ ...de("2026-11-05", webinarDe), name: "Veranstaltungen, Messen & Webinare" }]).split("\n")[1]!;
    assert.match(
      line,
      /^- Thursday, 5 November 2026: https:\/\/www\.mvtec\.com\/de\/wissensportal\/events\. The page says: "05\. November 2026 · Webinar: Fortgeschrittenes/,
    );
  });

  it("gives the chat only the events' page addresses, not a site-wide banner's", () => {
    const paths = eventPagePaths([...mvtec, banner("https://x.example/a"), banner("https://x.example/b"), banner("https://x.example/c")]);
    assert.deepEqual(paths, [
      "/de/wissensportal/events",
      "/de/wissensportal/events/detail",
      "/knowledge-base/events",
      "/knowledge-base/events/detail",
    ]);
  });
});

describe("a page reaching the chat after its sync finished (recheck 8b)", () => {
  it("updates the events list when it states events", () => {
    assert.equal(addsToEventsList({ facts: { events: [{ date: "2026-11-24" }] } }), true);
  });
  it("leaves the list alone when it states none", () => {
    assert.equal(addsToEventsList({ facts: { events: [] } }), false);
    assert.equal(addsToEventsList({ facts: {} }), false);
    assert.equal(addsToEventsList({ facts: null }), false);
  });
});
