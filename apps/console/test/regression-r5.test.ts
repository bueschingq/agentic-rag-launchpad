// The round-5 regression set (proposal §2, "Regression set"): every reply a reviewer called wrong in
// rounds 1–5, verbatim, with its expected verdict (fixtures/regression-r1-5.json, gathered from the
// review kit's reports and work folders; round 4's pairs are in packages/theme's round4-answers.json),
// the sales engineer's raw "What are your prices?" stream (fixtures/se-raw-ask-prices.json), and a
// set of non-answers in new wordings (fixtures/paraphrases-r5.json: written by an agent that never
// saw the rules, then used to tune them, so it is a tuning set now, not the blind one the
// acceptance asks for).
//
// What the rules alone (the shared verdict and validation's leak check) must do. Replies whose
// fault is a wrong fact (a stale price, another product's figure) carry no sign in their wording:
// the key pages' evidence and the model judge hold those in validation, and are checked live.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { toStreamItem } from "@launchpad/par-client";
import { answerChecks, askedKind, bestScore, citedPassages, isAnswered, negativeClaim, showsModelText, verdict } from "@launchpad/theme";
import { evidenceHolds, leaksInternals, priceKey } from "../src/lib/validation-rules.ts";

interface Entry {
  round: number;
  who: string;
  site: string;
  lang: string;
  question: string | null;
  answer: string;
  expected: "may-not-answer" | "partly" | "answered" | "check-this" | "talks-about-sources" | "wrong-language" | "no-answer";
  truncated?: boolean;
  paraphrase?: boolean;
}
const read = <T>(name: string): T => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")) as T;
const SET = read<Entry[]>("regression-r1-5.json");
const strong = { score: 0.31, type: "RERANKER" };
const judged = (e: { answer: string; question: string | null }) =>
  verdict({ answer: e.answer, status: "success", best: strong, ...(e.question && { question: e.question }) });

describe("the round-5 regression set: the replies the acceptance names", () => {
  const cases: [string, string][] = [
    // The UX designer's two crayon replies, and her own wording.
    [
      "How do I get crayon off a painted wall?",
      "Our Ultra-Clean Washable Crayons are designed to be washable from painted walls. The information we have does not provide specific removal steps for crayon on painted walls.",
    ],
    [
      "How do I get crayon off a painted wall?",
      "Our Ultra-Clean Washable Markers and Crayons are designed to be washable from painted walls. The information we have does not provide specific cleaning steps for removing crayon from a painted wall.",
    ],
    ["How do I get crayon off a painted wall?", "Our stain tips don't include steps for crayon on painted walls."],
    // The executive's starter on chef.io.
    [
      "How much does Chef cost?",
      "Chef 360 uses a predictable subscription model, typically calculated per managed node. Our website does not list specific subscription prices.",
    ],
    // The marketer's webinar.
    ["When is the next WhatsUp Gold webinar?", "No future WhatsUp Gold webinar date is listed. Our webinars shown are on-demand."],
  ];
  for (const [question, answer] of cases) {
    it(`may not answer: “${answer.slice(0, 60)}…”`, () => {
      const v = verdict({ answer, status: "success", best: strong, question });
      assert.equal(v, "may-not-answer");
      // Shown as written, with the handoff, and never counted as answered.
      assert.equal(showsModelText(v), true);
      assert.equal(isAnswered(v), false);
    });
  }

  it("reads the sales engineer's raw “What are your prices?” as Answered, with its text shown, at a 0.011 score", () => {
    const raw = read<{ body: string }[]>("se-raw-ask-prices.json");
    for (const r of raw) {
      let answer = "";
      let citations: Record<string, unknown> = {};
      let resources: Record<string, unknown> = {};
      let status: string | undefined;
      for (const line of r.body.split("\n").filter(Boolean)) {
        const item = toStreamItem(JSON.parse(line));
        if (item.type === "answer") answer += item.text;
        else if (item.type === "citations") citations = item.citations;
        else if (item.type === "retrieval") resources = item.resources;
        else if (item.type === "status") status = item.status;
      }
      const best = bestScore(resources);
      assert.ok(best && best.score < 0.02, "the score that hid it");
      assert.ok(citedPassages(resources, citations).length > 0);
      const v = verdict({ answer, status, best, citations, resources, question: "What are your prices?" });
      assert.ok(isAnswered(v), `${v}: ${answer.slice(0, 80)}`);
      assert.ok(showsModelText(v));
    }
  });

  it("keeps the score for replies with nothing grounded: an off-topic reply at 0.003 stays hidden", () => {
    const resources = {
      r1: { fields: { "/t/body": { paragraphs: { "r1/t/body/0-40": { text: "Crayola markers and crayons for kids.", score: 0.003 } } } } },
    };
    const v = verdict({
      answer: "Our bicycles start at $499.",
      status: "success",
      best: { score: 0.003, type: "RERANKER" },
      citations: { "r1/t/body/0-40": [] },
      resources,
      question: "Do you sell bicycles?",
    });
    assert.equal(v, "low-relevance");
  });
});

describe("the round-5 regression set: rounds 1 to 5", () => {
  it("never reads a reply a reviewer relied on as may not answer", () => {
    const relied = SET.filter((e) => e.expected === "answered" || e.expected === "partly");
    assert.ok(relied.length >= 60);
    const flipped = relied.filter((e) => judged(e) === "may-not-answer").map((e) => e.answer);
    // One partial answer the reviewer read as partly gives no date at all: may not answer is right.
    assert.deepEqual(flipped, [
      "We list a live session, “Beyond the Firewall: Eliminating Blind Spots with Network Path Analysis,” but no date is provided.",
    ]);
  });

  it("catches every reply expected to may not answer: may not answer, or Check this", () => {
    const expected = SET.filter((e) => e.expected === "may-not-answer");
    assert.ok(expected.length >= 15);
    const caught = (e: Entry) =>
      !isAnswered(judged(e)) ||
      leaksInternals(e.answer) ||
      answerChecks({ question: e.question ?? "", answer: e.answer, sources: [] }).length > 0;
    for (const e of expected) assert.ok(caught(e), `${judged(e)}: ${e.answer}`);
  });

  it("catches replies that talk about their sources: the leak check, or may not answer", () => {
    const talks = SET.filter((e) => e.expected === "talks-about-sources");
    const missed = talks.filter((e) => !leaksInternals(e.answer) && judged(e) !== "may-not-answer").map((e) => e.answer.slice(0, 60));
    // Known misses, left to the judge: an echoed key-page annotation (Track A takes it out of the
    // text), two fragments the reviewer only quoted in part, and Kemp's Spanish price answer
    // ("la información mostrada…"), which is also a don't-break: pointing to a page is allowed.
    // Round 6: "The page does not list specific prices" is allowed now: the prompt asks the model to
    // say what the page it read doesn't state.
    assert.ok(missed.length <= 5, missed.join(" | "));
  });
});

describe("new wordings (the tuning set)", () => {
  const sets =
    read<Record<string, { nonAnswers: { question: string; answer: string }[]; controls: { question: string; answer: string }[] }>>(
      "paraphrases-r5.json",
    );
  for (const [lang, set] of Object.entries(sets)) {
    it(`${lang}: catches at least 18 of 20 non-answers by their claim alone, and flags no control`, () => {
      const caught = set.nonAnswers.filter(
        (p) => verdict({ answer: p.answer, status: "success", best: strong, question: p.question, language: lang }) !== "answered",
      );
      assert.ok(caught.length >= 18, `${caught.length} of ${set.nonAnswers.length}`);
      for (const c of set.controls) {
        assert.ok(
          isAnswered(verdict({ answer: c.answer, status: "success", best: strong, question: c.question, language: lang })),
          c.answer,
        );
      }
    });
  }
});

describe("the release check's new wordings (round 6, written by verifiers who never saw the rules)", () => {
  const WORDINGS: [string, string][] = [
    // teamwork.com (heldout-1)
    ["What are your prices?", "Pricing specifics aren't something I'm able to share from the material available to me."],
    ["What are your prices?", "The details I can see stop short of naming any dollar amounts for the plans."],
    ["How much does Teamwork.com cost?", "Unfortunately nothing in my sources goes into the subscription fees."],
    ["When is the next Teamwork.com webinar?", "I wasn't given anything that spells out when the next webinar happens."],
    ["How much does Teamwork.com cost?", "That isn't covered in what I've got here, so I can't tell you the cost."],
    // swiffer.com (heldout-3)
    ["How do I clean my oven with Swiffer?", "Our cleaning guides don't go into how to clean an oven, so I can't walk you through it."],
    [
      "How do I clean my oven with Swiffer?",
      "Oven cleaning isn't something these articles touch on. You might find better help elsewhere.",
    ],
    ["How do I clean my oven with Swiffer?", "Unfortunately the tips available to me are silent on ovens."],
    ["How do I clean my oven with Swiffer?", "There's nothing in the Swiffer material I have that explains how to clean an oven."],
    ["How do I clean my oven with Swiffer?", "I'm afraid the material I was given only covers floors and dusting, not ovens."],
    // teamleader.eu (heldout-2)
    ["Quand a lieu le prochain webinaire ?", "Aucune date de webinaire à venir n'est indiquée."],
  ];
  for (const [question, answer] of WORDINGS) {
    it(`may not answer: “${answer.slice(0, 50)}…”`, () => {
      assert.equal(verdict({ answer, status: "success", best: strong, question }), "may-not-answer");
    });
  }
  it("knows a phone question is a contact question, in each language", () => {
    for (const q of [
      "Wie lautet Ihre Telefonnummer?",
      "Quel est votre numéro de téléphone ?",
      "¿Cuál es su número de teléfono?",
      "What is your phone number?",
    ]) {
      assert.equal(askedKind(q), "contact", q);
    }
  });
});

describe("the evidence check against the key pages' facts", () => {
  const chef = [
    {
      url: "https://www.chef.io/how-to-buy",
      title: "Pricing & Plans",
      intent: "price",
      facts: {
        prices: [
          { figure: "$59", line: "Business $59 per node, per year" },
          { figure: "$189", line: "Enterprise $189 per node, per year" },
        ],
      },
    },
  ];
  it("holds a price answer that gives none of the pricing page's figures, naming them", () => {
    const { holds } = evidenceHolds(
      "How much does Chef cost?",
      "Our website does not list specific subscription prices. Please contact sales.",
      { price: chef },
    );
    assert.equal(holds.length, 1);
    assert.equal(holds[0]?.text, "The pricing page /how-to-buy states $59 and $189; this answer gives neither.");
    assert.deepEqual(holds[0]?.pages?.[0]?.lines, ["Business $59 per node, per year", "Enterprise $189 per node, per year"]);
    assert.equal(holds[0]?.clear, "decide");
  });
  it("passes one that gives a figure, in any format, and leads a No answer with the facts", () => {
    assert.equal(
      evidenceHolds("How much does Chef Business cost?", "Chef Business is $59 per node, per year.", { price: chef }).holds.length,
      0,
    );
    assert.equal(priceKey("2.205 US-Dollar"), priceKey("$2,205"));
    assert.equal(priceKey("2 205 $"), "2205");
    const none = evidenceHolds("How much does Chef cost?", "", { price: chef });
    assert.equal(none.holds.length, 0);
    assert.equal(none.keyFacts?.[0]?.url, "https://www.chef.io/how-to-buy");
  });
  it("holds a reply calling an upcoming event over or missing, naming the page and the date", () => {
    const events = [
      {
        date: "2026-11-05",
        line: "Upcoming Live Webinar: Thursday, November 5",
        readAs: "Thursday, November 5, 2026",
        url: "https://www.whatsupgold.com/webinars/beyond-the-firewall",
      },
    ];
    const missing = evidenceHolds("When is the next WhatsUp Gold webinar?", "No future WhatsUp Gold webinar date is listed.", { events });
    assert.match(
      missing.holds[0]?.text ?? "",
      /^\/webinars\/beyond-the-firewall states Thursday, November 5, 2026; this answer says there's none\.$/,
    );
    const over = evidenceHolds("Are there any upcoming live webinars?", "The live webinar on November 5 has passed.", { events });
    assert.match(over.holds[0]?.text ?? "", /says it's over/);
    assert.equal(
      evidenceHolds("When is the next WhatsUp Gold webinar?", "Our next webinar is on Thursday, November 5, 2026.", { events }).holds
        .length,
      0,
    );
  });
  it("holds a reply saying there's no phone while the contact page lists one", () => {
    const contact = [
      {
        url: "https://x.example/contact",
        intent: "contact",
        facts: { contacts: [{ kind: "phone" as const, value: "+1 800 555 0100", line: "Call +1 800 555 0100" }] },
      },
    ];
    assert.equal(
      evidenceHolds("What is your support phone number?", "Our website doesn't list a phone number for support.", { contact }).holds.length,
      1,
    );
  });
  it("hears the claim in the answer, not the question's own words", () => {
    assert.ok(negativeClaim("No future WhatsUp Gold webinar date is listed.", "en", "When is the next WhatsUp Gold webinar?"));
  });
});
