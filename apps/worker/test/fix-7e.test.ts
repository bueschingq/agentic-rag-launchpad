// Fix cycle 7e, from the saved text of the fourth release check (review-kit/round-7/verification/U1):
// which event a date belongs to, and a language choice beside the site's default. No network and no
// database. The price table's note is in apps/console/test/price-notes-7e.test.ts.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import type { PageFacts } from "@launchpad/db";
import { withToday } from "@launchpad/theme";
import {
  namesNoEvent,
  type PlanEntry,
  pageFlags,
  placeDates,
  planContent,
  servedLanguages,
  statedFacts,
} from "../../console/src/lib/content-plan.ts";
import { eventsParagraph, eventsToList, type PromptEvent } from "../../console/src/lib/prompt.ts";
import { pageFacts, pageVerdict, type SyncRules } from "../src/jobs/content.ts";
import type { SitePage } from "../src/sniffer.ts";

const TODAY = new Date("2026-11-02T12:00:00Z");
const fixture = (name: string) => readFileSync(new URL(`../../console/test/fixtures/${name}`, import.meta.url), "utf8");

const events = (url: string, text: string, lang?: string) =>
  statedFacts({ url, text, ...(lang && { lang }) }, null, placeDates(text, { date: TODAY, from: "read" }, lang), TODAY).events ?? [];
const forPrompt = (url: string, list: PageFacts["events"]): PromptEvent[] =>
  (list ?? []).filter((e) => e.date).map((e) => ({ date: e.date, line: e.line, url, title: "Events" }));
const lineOn = (list: PageFacts["events"], date: string) => list?.find((e) => e.date === date)?.line ?? "";

describe("a date's event comes from the item it belongs to", () => {
  const url = "https://www.mvtec.com/de/wissensportal/events";
  const read = events(url, fixture("events-date-first-de.txt"), "de-de");

  it("a list that heads each item with its date (the stored German page)", () => {
    assert.match(lineOn(read, "2026-11-05"), /Fortgeschrittenes Deep Learning/);
    assert.match(lineOn(read, "2026-11-18"), /^HALCON 26\.11 Webinar/);
    assert.match(lineOn(read, "2026-11-24"), /SPS in Nürnberg/);
    assert.doesNotMatch(lineOn(read, "2026-11-24"), /HALCON/);
    assert.doesNotMatch(lineOn(read, "2026-11-05"), /Newsletter/);
    assert.match(lineOn(read, "2027-03-31"), /Advanced Factories/);
  });

  it("the prompt's list says 5 and 18 November for the webinars", () => {
    const paragraph = eventsParagraph(forPrompt(url, read));
    assert.match(paragraph, /Thursday, 5 November 2026: .*Fortgeschrittenes Deep Learning/);
    assert.match(paragraph, /Wednesday, 18 November 2026: .*HALCON 26\.11 Webinar/);
    assert.match(paragraph, /The first one listed is the next/);
  });

  it("a version number in a title isn't a date", () => {
    assert.ok(!read.some((e) => e.date === "2026-11-26" && e.line.includes("HALCON")));
    for (const title of ["HALCON 26.11 Webinar", "Release v5.2 webinar", "Windows 11.10 update, version 12.13.2026"])
      assert.deepEqual(placeDates(title, { date: TODAY, from: "read" }, "en").dates, [], title);
  });

  it("the same shape, invented, in English: date, then the name, then a sentence", () => {
    const text = [
      "# Meet us",
      "Pick your region.",
      "Region",
      "12 November 2026",
      "Spring Lab Webinar 3.2",
      "See what is new in the lab.",
      "Open",
      "Europe",
      "20 November 2026",
      "Harbour Fair",
      "Come and find us at the fair.",
      "Trade show",
      "9 December 2026",
      "Winter Summit",
      "Two days of talks about the winter range.",
      "More about training",
    ].join("\n\n");
    const list = events("https://x.example/events", text, "en");
    assert.match(lineOn(list, "2026-11-12"), /Spring Lab Webinar/);
    assert.match(lineOn(list, "2026-11-20"), /Harbour Fair/);
    assert.match(lineOn(list, "2026-12-09"), /Winter Summit/);
  });

  it("a list that closes each item with its date keeps the name above", () => {
    const text = ["# Events", "Autumn Meetup", "Leeds", "12 November 2026", "Winter Summit", "York", "9 December 2026"].join("\n\n");
    const list = events("https://x.example/events", text, "en");
    assert.match(lineOn(list, "2026-11-12"), /Autumn Meetup · Leeds · 12 November 2026/);
    assert.match(lineOn(list, "2026-12-09"), /Winter Summit · York · 9 December 2026/);
  });

  it("when nothing says which side, the date isn't paired, and stays out of the list", () => {
    // Labels on both sides, a whole item's room at both ends: either reading fits.
    const text = ["# Events", "Autumn Meetup", "12 November 2026", "Harbour Fair", "20 November 2026", "Winter Summit"].join("\n\n");
    const list = events("https://x.example/events", text, "en");
    assert.equal(lineOn(list, "2026-11-20"), "20 November 2026");
    assert.ok(namesNoEvent(lineOn(list, "2026-11-20")));
    assert.deepEqual(eventsToList(forPrompt("https://x.example/events", list)), []);
    const paragraph = eventsParagraph(forPrompt("https://x.example/events", list));
    assert.doesNotMatch(paragraph, /none is dated today or later/);
    assert.match(paragraph, /none can be listed here/);
  });

  it("headings still name events on either side, and the next section's heading doesn't", () => {
    const below =
      "### Upcoming\n\n17 Nov 2026 at 14:00 GMT\n\n##### Afternoon Session\n\n18 Nov 2026 at 10:00 GMT\n\n##### Morning Session";
    const onBelow = events("https://x.example/events", below, "en");
    assert.match(lineOn(onBelow, "2026-11-17"), /Afternoon Session/);
    const above = [
      "##### First Course",
      "A course.",
      "02 Nov 2026 at 09:00 GMT",
      "Classroom course",
      "##### Second Course",
      "A course.",
      "03 Nov 2026 at 09:00 GMT",
      "Classroom course",
      "##### Third Course",
      "A course.",
      "04 Nov 2026 at 09:00 GMT",
      "## Ask for a course",
    ].join("\n\n");
    const onAbove = events("https://x.example/events/courses", above, "en");
    assert.match(lineOn(onAbove, "2026-11-04"), /Third Course/);
    assert.doesNotMatch(lineOn(onAbove, "2026-11-04"), /Ask for a course/);
  });

  it("a short place and date take the heading right above", () => {
    const text = "## Highlights\n\n### Crane Safety 2026\n\nManchester, 11 November 2026";
    assert.match(lineOn(events("https://x.example/events", text, "en"), "2026-11-11"), /^Crane Safety 2026 · Manchester/);
  });

  it("a bare date on a page that isn't about events isn't an event in the list", () => {
    const blog = "https://x.example/blog/post/storm-doors";
    assert.deepEqual(eventsToList([{ date: "2026-11-17", line: "Nov 17", url: blog, title: "Storm doors" }]), []);
    // An event's own page, with its one date, is named by its heading.
    const own = "https://x.example/events/summit-2026";
    assert.equal(eventsToList([{ date: "2026-11-17", line: "Nov 17, 2026", url: own, name: "Summit" }]).length, 1);
  });
});

describe("today, in the prompt", () => {
  const saved = withToday("PROMPT", TODAY);
  it("says the date and that an event before it isn't upcoming, even invited to", () => {
    assert.match(saved, /Today's date is Monday, 2 November 2026\./);
    assert.match(
      saved,
      /An event dated before today is over, even if its page still invites to it and even if it is the only one you have: never call it next, upcoming or taking place/,
    );
    assert.match(saved, /a number in a name is a version \(26\.11, v5\.2\), not a date/);
    assert.ok(saved.indexOf("Today's date") > saved.indexOf("PROMPT"), "it's the prompt's last paragraph");
  });
  it("a prompt saved under the wording before keeps it until its rules are applied after a re-check", () => {
    const v5 =
      "PROMPT\n\nToday's date is Sunday, 1 November 2026. An event, webinar, offer or deadline is over only if its full date, with the year, is before today: one dated today or later is next, upcoming or open, and a date written without a year is never called over. Tell each one in the tense its date gives: before today it took place, today or later it will take place; never list a past one as upcoming. Say that nothing is upcoming only if no page you were given dates the kind of event asked about today or later; then say it in one sentence, without naming today's date, and link our events page if you have it.";
    const next = withToday(v5, TODAY);
    assert.match(next, /Today's date is Monday, 2 November 2026/);
    assert.doesNotMatch(next, /still invites to it/);
  });
});

describe("a language choice never drops the site's default language", () => {
  const entry = (path: string): PlanEntry => ({ url: `https://www.example.com${path}` });
  const site: SitePage = {
    url: "https://www.example.com/contact",
    finalUrl: "https://www.example.com/contact",
    status: 200,
    title: "Contact",
    lang: "en-us",
    noindex: false,
    markdown: `# Contact\n\n${"Write to our team about your project and we will reply soon. ".repeat(20)}`,
    words: 240,
    links: [],
    rootChars: 1200,
    textChars: 1200,
    linkShare: 0,
    extractor: 5,
  } as SitePage;
  const verdictFor = (page: SitePage, languages: string[], language: string) => {
    const served = servedLanguages(languages, language);
    const facts = pageFacts(page, undefined, TODAY);
    const flags = pageFlags(facts, { served, today: TODAY, keyPages: true });
    const sync: SyncRules = { rules: [], served, spare: true, pinned: false, kept: false, today: TODAY };
    return { flags, verdict: pageVerdict(page, new Set(), sync, flags, facts) };
  };

  it("each visitor's language, with German ticked: the English pages stay, German too", () => {
    assert.ok(servedLanguages(["und", "de"], "auto").includes("de"));
    const { flags, verdict } = verdictFor(site, ["und", "de"], "auto");
    assert.ok(!flags.includes("other-language"));
    assert.ok(!JSON.stringify(verdict).includes("In another language"));
    const german = { ...site, url: "https://www.example.com/de/kontakt", finalUrl: "https://www.example.com/de/kontakt", lang: "de-de" };
    assert.ok(!verdictFor(german, ["und", "de"], "auto").flags.includes("other-language"));
  });

  it("a fixed language, with its own pages ticked: the same", () => {
    assert.ok(!verdictFor(site, ["und", "de"], "de").flags.includes("other-language"));
  });

  it("a marked language nobody ticked stays out, and unticking the unmarked group is a choice", () => {
    const french = { ...site, url: "https://www.example.com/fr/contact", finalUrl: "https://www.example.com/fr/contact", lang: "fr-fr" };
    assert.ok(verdictFor(french, ["und", "de"], "auto").flags.includes("other-language"));
    assert.ok(verdictFor(site, ["de"], "de").flags.includes("other-language"));
  });

  it("an unmarked site with one language still drops a stray page in another", () => {
    const stray = {
      ...site,
      lang: "it-it",
      markdown: `# Contatti

${"Scrivi al nostro team per il tuo progetto e ti risponderemo presto con tutte le informazioni. ".repeat(20)}`,
    };
    assert.ok(verdictFor(stray, ["und"], "en").flags.includes("other-language"));
  });

  it("through the plan: /contact is taken as a key page, and the German pages beside it", () => {
    const entries = [entry("/contact"), entry("/products/a"), entry("/de/kontakt"), entry("/de/produkte/a")];
    const plan = planContent({
      entries,
      budget: 50,
      include: [],
      exclude: [],
      rules: [],
      languages: ["und", "de"],
      served: ["en", "de", "es", "fr"],
      today: TODAY,
    });
    assert.equal(plan.eligible, 4);
    assert.ok(plan.keyPages.taken.some((k) => k.path === "/contact"));
  });
});
