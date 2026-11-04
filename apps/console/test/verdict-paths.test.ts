// Round 6, items 1 and 6: one verdict and one price table check, on all four paths. The chat (the
// widget's verdict on what the stream brought back), the picker (a starter asked and judged), a
// validation run and the overnight re-run (the answer asked under the latest rules, compared with
// the current one) must reach the same verdict for the same text. And the scope-aware verdict on
// the labelled development half (apps/console/test/fixtures/verdict-labelled-dev.json, built by
// someone who doesn't write the code): at most 5% of non-answers missed, at most 3% of answers held.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import type { AskResult } from "@launchpad/par-client";
import {
  bestScore,
  checkPriceClaims,
  citedPassages,
  isAnswered,
  type PriceTable,
  priceRowsHash,
  type Verdict,
  verdict,
} from "@launchpad/theme";
import {
  applyStarterPick,
  type DraftQuestion,
  judgeAnswer,
  needsCheck,
  openContradiction,
  type RunQuestion,
  recheckDiff,
  starterNeed,
  withJudgement,
} from "../src/lib/validation-rules.ts";

interface Labelled {
  id: string;
  question: string;
  reply: string;
  language: string;
  label: Verdict;
}
const DEV = Object.values(
  JSON.parse(readFileSync(new URL("./fixtures/verdict-labelled-dev.json", import.meta.url), "utf8")) as Record<string, Labelled>,
);
const isAnswer = (l: Verdict) => l === "answered" || l === "partly";
const by = { by: "u1", name: "Dana Ruiz", at: "2026-11-01T10:00:00Z", verified: true };

// What an ask brings back, as the stream and the synchronous answer both carry it.
const result = (answer: string, resources: Record<string, unknown> = {}, citations?: Record<string, unknown>): AskResult => ({
  answer,
  status: "success",
  ...(citations && { citations }),
  retrieval_results: { resources },
});

// The four paths on one reply.
function paths(question: string, r: AskResult, language: string, priceTable?: PriceTable) {
  const resources = (r.retrieval_results?.resources ?? {}) as Record<string, never>;
  // The chat: the widget's #verdictOf.
  const chat = verdict({
    answer: r.answer ?? "",
    status: "success",
    best: bestScore(resources),
    resources,
    ...(r.citations && { citations: r.citations }),
    question,
    language,
    ...(r.citations && { passages: citedPassages(resources, r.citations) }),
  });
  const expected = { expected: language as never, followsVisitor: false };
  const context = priceTable ? { priceTable } : {};
  // Validation: a question in the run.
  const run = judgeAnswer({ question, own: true }, r, undefined, expected, context);
  // The picker: the same question asked as a starter.
  const picker = judgeAnswer({ question, own: false, starter: true } satisfies DraftQuestion, r, undefined, expected, context);
  // The overnight re-run: an intent question asked under the latest rules, beside an answered one.
  const latest = judgeAnswer({ question, own: false, intent: "price" }, r, undefined, expected, context);
  const current: RunQuestion = { question, answer: "Answered before.", sources: [], answered: true };
  const diff = recheckDiff([], [current], [latest]);
  return { chat, run, picker, latest, diff };
}

describe("one verdict on all four paths (round 6, item 6)", () => {
  it("gives the chat, the picker, validation and the re-run the same verdict for every labelled reply", () => {
    for (const item of DEV) {
      const { chat, run, picker, latest, diff } = paths(item.question, result(item.reply), item.language);
      assert.equal(run.verdict, chat, `validation, ${item.id}`);
      assert.equal(picker.verdict, chat, `picker, ${item.id}`);
      assert.equal(latest.verdict, chat, `re-run, ${item.id}`);
      assert.equal(run.answered, isAnswered(chat), item.id);
      // A reply the chat doesn't count as an answer can't be a starter without a named decision,
      // and makes the re-run worse.
      if (!isAnswered(chat)) assert.notEqual(starterNeed(picker).need, "ok", `picker, ${item.id}`);
      // (or a new failure, such as talking about its sources: validation's own check, on every path)
      assert.equal(diff.worse.length === 1, !isAnswered(chat) || Boolean(latest.failure), `re-run worse, ${item.id}`);
      assert.equal(run.failure, picker.failure?.replace(/^No answer to a starter question(?:; )?/, "") || undefined, item.id);
    }
  });

  it("reaches the same verdict with the passages the reply cites", () => {
    const contactPage = (text: string) => ({
      r1: {
        title: "Contact",
        origin: { url: "https://example.com/contact" },
        fields: { "/t/text": { paragraphs: { "r1/t/text/0-50": { score: 0.3, score_type: "RERANKER", text } } } },
      },
    });
    const cites = { "r1/t/text/0-50": [[0, 5]] };
    const reply = "Contact us through the form on our Contact page.";
    // The site's contact page offers only the form: the form is the answer.
    const only = paths("How do I contact sales?", result(reply, contactPage("Contact sales: fill in the form."), cites), "en");
    assert.equal(only.chat, "answered");
    assert.deepEqual([only.run.verdict, only.picker.verdict, only.latest.verdict], [only.chat, only.chat, only.chat]);
    // It lists a phone number the reply leaves out: a deflection, on every path.
    const more = paths(
      "How do I contact sales?",
      result(reply, contactPage("Call sales on +1 800 555 0100, or fill in the form."), cites),
      "en",
    );
    assert.equal(more.chat, "deflection");
    assert.deepEqual([more.run.verdict, more.picker.verdict, more.latest.verdict], [more.chat, more.chat, more.chat]);
  });
});

describe("the scope-aware verdict on the labelled development half", () => {
  const judged = DEV.map((i) => ({
    ...i,
    got: verdict({ answer: i.reply, question: i.question, language: i.language, status: "success" }),
  }));
  const answers = judged.filter((i) => isAnswer(i.label));
  const non = judged.filter((i) => !isAnswer(i.label));

  it("has both halves to measure", () => {
    assert.ok(answers.length >= 40 && non.length >= 30, `${answers.length} answers, ${non.length} non-answers`);
  });
  it("misses at most 5% of non-answers", () => {
    const missed = non.filter((i) => isAnswered(i.got));
    assert.ok(missed.length <= non.length * 0.05, missed.map((i) => `${i.id}: ${i.got}`).join(", "));
  });
  it("holds at most 3% of answers", () => {
    const held = answers.filter((i) => !isAnswered(i.got));
    assert.ok(held.length <= answers.length * 0.03, held.map((i) => `${i.id}: ${i.got}`).join(", "));
  });
  it("reads the reviewers' quoted wordings as they were meant", () => {
    const of = (id: string) => judged.find((i) => i.id === id)?.got;
    // "…no card is needed" to a trial question, and "…with nothing in Progress Cloud": answers.
    assert.ok(isAnswered(of("vd-001") as Verdict));
    assert.ok(isAnswered(of("vd-010") as Verdict));
    // The partner question answered only with "contact us through the Contact page": a deflection.
    assert.equal(of("vd-062"), "deflection");
    // A demo offered to a question about a free trial: a substitution.
    assert.equal(of("vd-065"), "substituted");
    assert.equal(of("vd-079"), "substituted");
    // Whole-site negatives with nothing else: may not answer.
    assert.equal(of("vd-094"), "may-not-answer");
    assert.equal(of("vd-092"), "may-not-answer");
  });
});

// Kemp's pricing page, round 6.
const PRICING = "https://kemptechnologies.com/pricing";
const rows = [
  { plan: "Standard", amount: "$4,500", value: 4500, url: PRICING, line: "Standard: $4,500" },
  { plan: "Enterprise", amount: "$5,300", value: 5300, url: PRICING, line: "Enterprise: $5,300" },
  { plan: "Enterprise Plus", amount: "$6,200", value: 6200, url: PRICING, line: "Enterprise Plus: $6,200" },
];
const KEMP: PriceTable = { rows, pages: [PRICING], readAt: "2026-11-01T00:00:00Z", hash: priceRowsHash(rows) };
const pricingPage = {
  r1: {
    title: "Pricing",
    origin: { url: PRICING },
    fields: {
      "/t/text": {
        paragraphs: {
          "r1/t/text/0-80": { score: 0.3, score_type: "RERANKER", text: "Standard: $4,500 · Enterprise: $5,300 · Enterprise Plus: $6,200" },
        },
      },
    },
  },
};
const cites = { "r1/t/text/0-80": [[0, 5]] };

describe("the price table check on every path (round 6, item 1)", () => {
  it("holds a mislabelled price on validation, the picker and the re-run, naming the pairing, with the judge off", () => {
    const mislabel = "Standard is $6,200 per year, and Enterprise is $5,300.";
    const { run, picker, latest, diff } = paths("What are your prices?", result(mislabel, pricingPage, cites), "en", KEMP);
    const chat = checkPriceClaims(mislabel, KEMP, [PRICING]);
    assert.equal(chat.contradictions.length, 1);
    for (const q of [run, picker, latest]) {
      const hold = q.holds?.find((h) => h.by === "price");
      assert.equal(hold?.text, "Standard is $4,500 on /pricing; this answer gives $6,200 for Standard.");
      // Only a named reason clears it, never I checked it.
      assert.equal(hold?.clear, "decide");
      assert.ok(openContradiction(q));
    }
    // The judge switched off: still held.
    assert.ok(openContradiction(withJudgement(run, undefined)));
    // In the picker: I checked it isn't enough; a named reason is.
    assert.equal(starterNeed(picker, { checked: true }).need, "reason");
    assert.equal(starterNeed(picker, { reason: "Standard is $6,200 for the 3-year term." }).need, "ok");
    // The re-run: never "unchanged".
    assert.equal(diff.worse.length, 1);
    assert.match(diff.worse[0]?.was ?? "", /^Contradicts the price table/);
  });

  it("gives the same verdict for the same text and table, every time", () => {
    const text = "Standard is $6,200.";
    const holds = Array.from({ length: 3 }, () =>
      JSON.stringify(paths("What are your prices?", result(text, pricingPage, cites), "en", KEMP).run.holds),
    );
    assert.equal(new Set(holds).size, 1);
  });

  it("needs no click on a price row the table agrees with", () => {
    const right = "Standard is $4,500, Enterprise is $5,300 and Enterprise Plus is $6,200.";
    const { picker, run } = paths("What are your prices?", result(right, pricingPage, cites), "en", KEMP);
    assert.equal(picker.tableMatched, true);
    assert.equal(picker.flags?.includes("price") ?? false, false);
    assert.equal(starterNeed(picker).need, "ok");
    assert.equal(run.holds?.length ?? 0, 0);
  });

  it("asks I checked it for a price outside the table, which carries into validation", () => {
    const addOn = "Standard is $4,500, plus $99 a year for premium support.";
    const { picker } = paths("What are your prices?", result(addOn, pricingPage, cites), "en", KEMP);
    assert.deepEqual(picker.flags, ["price"]);
    assert.equal(starterNeed(picker).need, "check");
    const decided = applyStarterPick(picker, { checked: true }, by);
    assert.equal(decided.acknowledged?.name, "Dana Ruiz");
    assert.equal(starterNeed(decided).need, "ok");
    assert.equal(needsCheck(decided), false);
  });

  it("counts a held reply kept by a named person as answered for a starter", () => {
    const { picker } = paths("Can I get a free trial?", result("You can book a personalised demo from our Request a demo page."), "en");
    assert.equal(picker.verdict, "substituted");
    assert.equal(starterNeed(picker).need, "reason");
    const kept = applyStarterPick(picker, { reason: "The trial is booked through the demo form." }, by);
    assert.equal(starterNeed(kept).need, "ok");
    assert.equal(kept.acknowledged?.reason, "The trial is booked through the demo form.");
  });

  it("never lets a reply visitors don't see be a starter", () => {
    const { picker } = paths("Do you sell bicycles?", { answer: "", status: "no_context", retrieval_results: { resources: {} } }, "en");
    assert.equal(starterNeed(picker, { reason: "Kept anyway." }).need, "no-answer");
  });
});
