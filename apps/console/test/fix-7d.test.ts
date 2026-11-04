// Fix cycle 7d, what the third check found, on fixtures from its evidence: repeated lines reaching the
// table and the dates, false holds, key pages by their own text, languages, the figures no row has, and
// what the card says while it's being read.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import type { AskResult } from "@launchpad/par-client";
import {
  answersLanguageNote,
  errorPage,
  keyIntentOfPage,
  languageGapNote,
  noPriceTableNote,
  publicationStamp,
  welfarePage,
} from "../src/lib/content-plan.ts";
import { priceTableIssue } from "../src/lib/overview.ts";
import { combineRead, unplacedFigures } from "../src/lib/price-table.ts";
import { priceTableLine } from "../src/lib/review.ts";
import {
  dateTenseHold,
  directContactAnswer,
  judgeAnswer,
  leaksInternals,
  pastDatesOnly,
  type RunQuestion,
  trueNoEvents,
  withJudgement,
} from "../src/lib/validation-rules.ts";

const NOV2 = new Date("2026-11-02T12:00:00Z");

describe("false holds", () => {
  it("a news item's publication date isn't the next event", () => {
    assert.equal(publicationStamp("IMechE Design Challenge 2027 Device Rules and Guidelines available · 02 Nov 2026"), true);
    assert.equal(publicationStamp("Manchester, 11 November 2026"), false);
    assert.equal(publicationStamp("Rail conference · 11 Nov 2026"), false, "an event's own line");
    assert.equal(publicationStamp("Crane Safety 2026 — 11 November 2026, Manchester"), false);
  });

  it("a direct phone answer isn't held as a substitute", () => {
    const question = "What is your customer support phone number?";
    const answer = "For customer support, call us at 1-844-553-8453, Monday–Friday, 8:00 AM to 5:00 PM.";
    assert.equal(directContactAnswer(question, answer), true);
    const result = {
      answer,
      status: "success",
      citations: { r1: [[0, 10]] },
      retrieval_results: {
        resources: {
          r1: {
            id: "r1",
            title: "Support",
            origin: { url: "https://example.com/support" },
            fields: { "t/page": { paragraphs: { "r1/t/page/0-10": { score: 5, score_type: "RERANKER", text: answer } } } },
          },
        },
      },
    } as unknown as AskResult;
    const judged = judgeAnswer({ question, own: true }, result);
    assert.ok(!judged.declined, "not held as may-not-answer");
    assert.ok(judged.answered);
    assert.equal(directContactAnswer("How do I contact sales?", "Call training on 01234 567890."), false, "asked for contact in general");
    assert.equal(directContactAnswer(question, "We don't list a phone number. Our number 1-844-553-8453 is sales only."), false);
  });

  it("a true 'no upcoming event' is an answer to check once, not a hold", () => {
    const q: RunQuestion = {
      question: "When is the next Clopay webinar or event?",
      answer: "No upcoming Clopay webinar or event is listed.",
      sources: [],
      answered: false,
      declined: true,
      holds: [{ by: "claim", clear: "decide", text: "It may not answer: it says “No upcoming…”" }],
    };
    const out = trueNoEvents(q, { events: [] }, NOV2);
    assert.equal(out.answered, true);
    assert.equal(out.declined, undefined);
    assert.equal(out.holds?.[0]?.clear, "check");
    // The site states a date to come: still held.
    assert.equal(trueNoEvents(q, { events: [{ date: "2026-12-01", line: "x", readAs: "1 December 2026", url: "u" }] }, NOV2), q);
  });

  it("the judge naming only a past date is advice beside such an answer", () => {
    const q: RunQuestion = { question: "Any events?", answer: "None is listed.", sources: [], answered: true };
    const reason = "The site lists an AIA Austin Homes Tour on October 24 and 25, 2026";
    assert.equal(pastDatesOnly("on October 24–25, 2026", NOV2), true);
    const advice = withJudgement(q, { verdict: "contradicts", reason }, { holds: [] }, { noUpcomingDates: true });
    assert.ok(!advice.holds?.some((h) => h.by === "judge"), JSON.stringify(advice.holds));
    const future = withJudgement(
      q,
      { verdict: "contradicts", reason: "The site lists a tour on December 5, 2099" },
      { holds: [] },
      { noUpcomingDates: true },
    );
    assert.ok(future.holds?.some((h) => h.by === "judge"));
  });

  it("'Available materials include…' isn't talking about how it works", () => {
    const answer =
      "We offer residential garage doors in traditional, carriage house and modern styles. Available materials include insulated steel, natural wood, and composite steel with faux-wood cladding.";
    assert.equal(leaksInternals(answer), false);
    assert.equal(leaksInternals("The provided pages do not state a price."), true);
    assert.equal(leaksInternals("The available documents don't say."), true);
  });

  it("the same past event gets the same treatment, whichever wording it comes in", () => {
    const led = "Upcoming events include:\nAIA Austin Homes Tour — self-guided tour on October 24–25, 2026. Our team will be at Terraluz.";
    const said = "Upcoming events include:\nAIA Austin Homes Tour — October 24–25, 2026. Join us for the self-guided tour.";
    assert.match(dateTenseHold(led, NOV2)?.text ?? "", /is past, but this answer tells it as upcoming/);
    assert.match(dateTenseHold(said, NOV2)?.text ?? "", /is past, but this answer tells it as upcoming/);
    assert.equal(dateTenseHold("Past events included:\nThe tour on October 24–25, 2026.", NOV2), undefined);
    assert.equal(dateTenseHold("The tour took place on October 24–25, 2026.", NOV2), undefined);
  });
});

describe("key pages, by the page's own text", () => {
  it("a soft 404 is an error page, whatever its address", () => {
    const markdown = "# We're sorry\n\nThe page you are looking for is not currently available.";
    assert.match(errorPage({ title: "Pricing", markdown, words: 14 }) ?? "", /^An error page/);
    assert.equal(errorPage({ title: "Plans", markdown: "# Plans\n\nWe're delighted to offer these.", words: 8 }), undefined);
  });

  it("a welfare fund isn't support; a help page is", () => {
    const fund =
      "Support Network. Our benevolent fund offers financial help and wellbeing advice to members in need, and hardship grants. Donate today.";
    assert.equal(welfarePage(fund), true);
    assert.equal(keyIntentOfPage("support", "Support Network", fund), null);
    const help = "Technical support. Open a ticket with our support team, or read the knowledge base. Wellbeing and charity news below.";
    assert.equal(keyIntentOfPage("support", "Support", help), "support");
    assert.equal(keyIntentOfPage("contact", "Contact", fund), "contact", "only support");
  });
});

describe("languages", () => {
  const langs = [
    { tag: "und", label: "No language given", pages: 400, supported: true },
    { tag: "de", label: "German", pages: 387, supported: true },
    { tag: "ja", label: "Japanese", pages: 1, supported: false },
  ];
  it("warns when the chat's language has pages the plan doesn't take", () => {
    assert.match(languageGapNote("de", langs, ["und"]) ?? "", /answers in German.*387 pages/);
    assert.equal(languageGapNote("de", langs, ["und", "de"]), undefined);
    assert.match(languageGapNote("auto", langs, ["und"]) ?? "", /each visitor's language.*German/);
    assert.equal(languageGapNote("auto", langs, ["und", "de"]), undefined, "not for a language the widget can't serve");
    assert.equal(languageGapNote("", langs, ["und"]), undefined);
    assert.equal(languageGapNote("en", langs, ["und"]), undefined, "nothing marks English: the unmarked stand in");
  });
  it("Review says so when the chat has no pages in its language", () => {
    assert.match(answersLanguageNote("de", ["en"]) ?? "", /none of its pages/);
    assert.equal(answersLanguageNote("de", ["de", "en"]), undefined);
    assert.equal(answersLanguageNote("auto", ["en"]), undefined);
  });
});

describe("Review's preview", () => {
  it("doesn't take its own frame's lang for the visitor's language", () => {
    const route = readFileSync(
      new URL("../src/app/customers/[id]/deployments/[deploymentId]/widget/preview/route.ts", import.meta.url),
      "utf8",
    );
    assert.match(route, /chat\.setAttribute\("language", language \|\| navigator\.language/);
  });
});

describe("the price table (recheck-T1)", () => {
  const facts = {
    prices: [
      { line: "Starter: $9 per user per month", figure: "$9" },
      { line: "$16", figure: "$16" },
      { line: "Save up to 33% a year", figure: "$33" },
      { line: "$12", figure: "$12" },
      { line: "$24", figure: "$24" },
      { line: "$6 / per user per month", figure: "$6" },
    ],
  };
  const row = (plan: string, value: number) => ({
    plan,
    amount: `$${value}`,
    value,
    currency: "USD",
    url: "https://toggl.test/pricing",
    line: `${plan}: $${value}`,
  });
  const rows = [row("Starter", 9), row("Premium", 16), row("Capacity Management", 6)];

  it("a figure on a pricing page that no row has is surfaced (toggl.com's bare $12 and $24)", () => {
    const got = unplacedFigures(rows, [{ url: "https://toggl.test/pricing", facts }]);
    assert.deepEqual(
      got.map((f) => f.figure),
      ["$12", "$24"],
    );
  });

  it("not from a page that gave no rows, an article with prices in it", () => {
    assert.deepEqual(unplacedFigures(rows, [{ url: "https://toggl.test/content-hub/agency-pricing", facts }]), []);
  });

  it("reaches the stored table from the model's read, unhashed, and Needs attention", () => {
    const page = { url: "https://toggl.test/pricing", facts };
    const patterns = { rows: [], pages: [page.url], readAt: "2026-11-02T18:07:00Z", hash: "x" };
    const table = combineRead(patterns, [page], {
      rows,
      rejected: [],
      read: [page.url],
      failed: [],
      calls: 1,
      cache: { version: 1, pages: {} },
    });
    assert.deepEqual(
      table.unplaced?.map((f) => f.figure),
      ["$12", "$24"],
    );
    const same = combineRead(patterns, [{ url: page.url, facts: { prices: [] } }], {
      rows,
      rejected: [],
      read: [page.url],
      failed: [],
      calls: 1,
      cache: { version: 1, pages: {} },
    });
    assert.equal(table.hash, same.hash, "not in the hash: a confirmation still holds");
    assert.equal(priceTableIssue(table, null, false), "doubted");
    assert.equal(priceTableIssue(table, { hash: table.hash }, false), undefined, "confirmed by a person who has seen it");
  });

  it("while the first sync runs, it says the table is still being read", () => {
    const text = "The price table is still being read: the site's first sync hasn't finished.";
    assert.equal(noPriceTableNote(null, "reading"), text);
    assert.equal(priceTableLine("/d", null, null, "reading").detail, text);
    assert.equal(noPriceTableNote(null, true), "No price table: no pricing page was found.");
    const card = readFileSync(
      new URL("../src/app/customers/[id]/deployments/[deploymentId]/price-table/price-table-card.tsx", import.meta.url),
      "utf8",
    );
    assert.match(card, /!unread && !reading && " Nothing to confirm/);
  });

  it("every cell of the table wraps, and a phone stacks its rows", () => {
    const css = readFileSync(new URL("../src/app/globals.css", import.meta.url), "utf8");
    assert.match(css, /\.price-table \.table-wrap th,\s*\.price-table \.table-wrap td \{\s*white-space: normal;/);
    assert.match(css, /@media \(max-width: 600px\) \{\s*\.price-table \.table-wrap table,/);
  });
});
