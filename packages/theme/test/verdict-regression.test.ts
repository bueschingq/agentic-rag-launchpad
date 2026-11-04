// The verdict regression set (round 4, proposal §4.3): the reviewers' own answers, run on every
// build. The bar: no false No answer and no false Check this on the approvers' answers (the
// executive's 50 price, rate, hours and date answers, the marketer's quote answers), while the
// soft no-answers and thin answers they and the other two reviewers saw are caught.
//
// fixtures/round4-answers.json holds every (question, answer) pair found in the reviewers' round-4
// work folders and the release check's captures, with the source titles the widget or validation
// showed under it (titles only: the cited passages weren't captured), sorted by kind: "answer",
// "soft-no" (a reworded no-answer), "thin", "exact-no" (Agentic RAG's or the widget's own
// sentence) and "unclear".

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { answerChecks, declines, isAnswered, tellsToContact, verdict } from "../src/index.ts";

interface Pair {
  who: "exec" | "mkt" | "se" | "ux" | "verification";
  site: string;
  kind: "answer" | "soft-no" | "thin" | "exact-no" | "unclear" | "wrong-language";
  lang: string;
  question: string | null;
  answer: string;
  sources: string[];
  truncated?: boolean;
  // Added from a later round's checks (5: the re-check's partial answers that point to a page).
  round?: number;
}
const PAIRS: Pair[] = JSON.parse(readFileSync(new URL("./fixtures/round4-answers.json", import.meta.url), "utf8"));

// The name visitors see on each reviewer's deployment.
const BRAND: Record<string, string> = {
  telerik: "Telerik",
  crayola: "Crayola",
  whatsupgold: "WhatsUp Gold",
  "demo/sitefinity": "Sitefinity Demo Co (review)",
  kemp: "Kemp",
};

const strong = { score: 0.31, type: "RERANKER" };
// As the widget and validation judge a reply that came with a success status and a good match.
const judged = (answer: string) => verdict({ answer, status: "success", best: strong, citations: { r1: [] } });
const checksOf = (p: Pair) =>
  answerChecks({ question: p.question ?? "", answer: p.answer, sources: p.sources.map((title) => ({ title })), brand: BRAND[p.site] });

// The executive's round-3 set (work-executive/language-check.mjs): short English answers that state
// a price, a rate, hours or a date. Many are under 8 words.
const EXEC_50 = [
  "Telerik DevCraft Complete costs $1,299 per developer, per year.",
  "Teeth whitening costs $350 per session.",
  "Plans start at $29 per user per month.",
  "Parking: $5 per hour, $20 per day.",
  "A cleaning is $120 per visit.",
  "Our basic plan is $9 per month.",
  "The fee is €45 per person.",
  "Tickets are $15 per adult and $8 per child.",
  "Delivery costs $4.99 per order.",
  "Storage is $0.02 per GB per month.",
  "Open 8 am to 6 pm, Monday to Friday.",
  "We're open Saturday 9 am to 1 pm.",
  "Hours: Mon–Fri 9:00–17:00.",
  "The branch opens at 8:30 am.",
  "Closed on Sundays and public holidays.",
  "Our call center is open 24/7.",
  "Lobby hours are 9 to 5 on weekdays.",
  "The clinic opens at 7 am.",
  "Drive-through: 7 am to 7 pm.",
  "Support is available 24 hours a day.",
  "The webinar is on 12 November 2026 at 10 am EST.",
  "Registration closes on 1 December 2026.",
  "The next release is planned for Q1 2027.",
  "Version 15.4 was released on 20 July 2026.",
  "The offer ends 31 October 2026.",
  "Kendo UI is $899 per developer, per year.",
  "Telerik UI for Blazor: $849 per developer, per year.",
  "The 30-day trial is free.",
  "A checking account has no monthly fee.",
  "Wire transfers cost $25 each.",
  "Savings earn 4.10% APY.",
  "Our 12-month CD pays 4.5% APY.",
  "Overdraft fee: $30 per item.",
  "The loan rate starts at 6.49% APR.",
  "Annual membership is $60.",
  "Shipping is free on orders over $50.",
  "Returns are accepted within 30 days.",
  "Consultations are $75 per 30 minutes.",
  "Lessons cost $40 per hour.",
  "Rooms start at $189 per night.",
  "Per diem is $70 per day.",
  "Price: $1,149 per developer per year.",
  "Yes. It costs $12 per user per month, billed yearly.",
  "No. There is no setup fee.",
  "It is $99 pro rata per seat.",
  "Fees: $2 per ATM withdrawal outside our network.",
  "The visit costs $150 and takes 45 minutes.",
  "We open at 6 am and close at 10 pm daily.",
  "Appointments run from 8 am to 4 pm.",
  "The course costs $499 per student.",
];

describe("the verdict regression set: what the approvers rely on", () => {
  it("reads the executive's 50 answers as Answered, with no Check this", () => {
    assert.equal(EXEC_50.length, 50);
    for (const answer of EXEC_50) {
      assert.equal(judged(answer), "answered", answer);
      assert.deepEqual(answerChecks({ question: "", answer, sources: [] }), [], answer);
    }
  });

  it("gives Telerik DevCraft's price answer only its price check", () => {
    assert.equal(judged("Telerik DevCraft Complete costs $1,299."), "answered");
    const staged = PAIRS.find((p) => p.question === "How much does Telerik DevCraft Complete cost?");
    assert.ok(staged);
    assert.deepEqual(checksOf(staged), []);
  });

  it("leaves the German answer in an English chat to validation's language rule", () => {
    // It fails in validation on its language (lib/validation-rules.ts, languageVerdict), not here.
    const de = "Unser Basisplan kostet 9 $ pro Monat und ist für kleine Teams gedacht, die nicht mehr als fünf Nutzer haben.";
    assert.equal(judged(de), "answered");
  });

  it("reads the marketer's quote answers in English, German and Spanish as Answered, with no Check this", () => {
    const quotes = [
      {
        site: "whatsupgold",
        question: "Was kostet WhatsUp Gold für 300 Geräte?",
        start: "Für 300 Geräte nennen wir keinen konkreten Preis",
      },
      { site: "whatsupgold", question: "How much does WhatsUp Gold cost for 300 devices?", start: "Our plans start at $1,229" },
      { site: "whatsupgold", question: "¿Cuánto cuesta WhatsUp Gold para 300 dispositivos?", start: "No tenemos un precio publicado" },
      { site: "whatsupgold", question: "What did you say the price was for 300 devices again?", start: "We don’t list a published price" },
    ];
    for (const q of quotes) {
      const found = PAIRS.filter((p) => p.question === q.question && p.answer.startsWith(q.start));
      assert.ok(found.length, q.start);
      for (const p of found) {
        // Round 5: they say what the site doesn't state and give a price: they partly answer (Answered).
        assert.ok(isAnswered(judged(p.answer)), p.answer);
        // Judged against the pricing page it cites ("Preise und Lizenzierung", "Editions and Pricing").
        const pricing = p.sources.filter((s) => /preis|pricing|precio/i.test(s));
        const checks = answerChecks({
          question: p.question ?? "",
          answer: p.answer,
          sources: pricing.map((title) => ({ title })),
          brand: "WhatsUp Gold",
        });
        assert.deepEqual(pricing.length ? checks : checks.filter((c) => c !== "off-source"), [], p.answer);
      }
    }
  });

  it("finds no false No answer in any reviewer's answers, and no Check this for being short on the approvers'", () => {
    const answers = PAIRS.filter((p) => p.kind === "answer");
    assert.ok(answers.length > 200);
    for (const p of answers) assert.equal(declines(p.answer), false, p.answer);
    for (const p of answers.filter((p) => p.who === "exec" || p.who === "mkt")) {
      assert.ok(!checksOf(p).includes("short"), p.answer);
    }
    // The only short ones, by the rule as proposed: 7 words and nothing concrete. Correct, and
    // Check this asks a person to say so.
    assert.deepEqual(
      answers.filter((p) => checksOf(p).includes("short")).map((p) => p.answer),
      ["Our Crayola Crayons are safe and non-toxic.", "Our Crayola crayons are safe and nontoxic."],
    );
  });
});

describe("the verdict regression set: round 5", () => {
  it("reads whatsupgold.com's partial price answers that point to the pricing page as Answered, with no Check this", () => {
    const partial = PAIRS.filter((p) => p.round === 5);
    assert.equal(partial.length, 10);
    assert.deepEqual([...new Set(partial.map((p) => p.lang))].sort(), ["de", "en", "es"]);
    for (const p of partial) {
      assert.ok(isAnswered(judged(p.answer)), p.answer);
      assert.deepEqual(checksOf(p), [], p.answer);
    }
  });
});

describe("the verdict regression set: what the reviewers blocked on", () => {
  it("catches every soft no-answer: No answer, or Check this with the handoff", () => {
    const soft = PAIRS.filter((p) => p.kind === "soft-no");
    const outcomes = soft.map((p) => (declines(p.answer) ? "no answer" : checksOf(p).length ? "check this" : "answered"));
    assert.equal(outcomes.filter((o) => o === "answered").length, 0);
    // Published in the release notes: 6 of 6 caught (2 No answer, 4 Check this).
    assert.deepEqual({ caught: outcomes.length, noAnswer: outcomes.filter((o) => o === "no answer").length }, { caught: 6, noAnswer: 2 });
    // Every one tells the visitor to contact the team: the widget shows the handoff under it.
    for (const p of soft) assert.ok(tellsToContact(p.answer), p.answer);
  });

  it("reads crayola.com's painted-wall and slime replies as No answer", () => {
    for (const question of ["How do I get crayon off a painted wall?", "How do I get slime out of carpet?"]) {
      const p = PAIRS.find((x) => x.question === question && x.kind === "soft-no");
      assert.ok(p, question);
      const v = judged(p.answer);
      assert.equal(v, "may-not-answer");
      assert.equal(isAnswered(v), false);
    }
    // The steps the site does give stay an answer.
    const steps = PAIRS.filter((p) => p.question === "How do I get crayon off a painted wall?" && p.kind === "answer");
    for (const p of steps) assert.equal(judged(p.answer), "answered", p.answer);
  });

  it("flags the demo's partner replies as Check this: they only say “contact us”, and their sources don't match", () => {
    const p = PAIRS.find((x) => x.answer.startsWith("To explore becoming a Sitefinity partner, please contact us."));
    assert.ok(p);
    assert.equal(judged(p.answer), "answered");
    assert.deepEqual(checksOf(p), ["short", "off-source"]);
    // Whatever the sources: live, the demo's pages mention partners (2026-10-30), and the reply still
    // says nothing but “contact us”.
    for (const answer of [
      "To discuss becoming a Sitefinity partner, please contact us.",
      "Please contact us to discuss becoming a Sitefinity partner.",
    ]) {
      const checks = answerChecks({
        question: "Who should I talk to about becoming a Sitefinity partner?",
        answer,
        sources: [{ title: "Partners", text: "Work with Progress partners" }],
        brand: "Progress",
      });
      assert.deepEqual(checks, ["short"], answer);
    }
  });

  it("flags telerik.com's “Contact Support.” as Check this: short, and its sources don't match", () => {
    const thin = PAIRS.filter((p) => p.kind === "thin");
    assert.equal(thin.length, 2);
    for (const p of thin) {
      assert.deepEqual(checksOf(p), ["short", "off-source"], p.answer);
      assert.ok(tellsToContact(p.answer));
    }
  });

  it("never reads a no-answer sentence as an answer", () => {
    for (const p of PAIRS.filter((x) => x.kind === "exact-no")) assert.equal(isAnswered(judged(p.answer)), false, p.answer);
  });
});
