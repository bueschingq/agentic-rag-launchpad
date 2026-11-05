// The answer judge's pure parts (its prompt, reading its reply, the cache key), what a judgement
// and a hold do to a validation result, and how generated questions spread across a site (round 5).

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { predictText } from "@launchpad/par-client";
import { judgementKey, judgePrompt, parseJudgement } from "../src/lib/judge.ts";
import {
  judgeOutcome,
  needsCheck,
  openHold,
  type RunQuestion,
  sectionOf,
  spreadPages,
  validationPassed,
  withJudgement,
} from "../src/lib/validation-rules.ts";

describe("the judge", () => {
  it("reads /predict/chat's plain text with its status code, and NDJSON chunks", () => {
    assert.deepEqual(predictText('{"verdict":"no","reason":"x"}0'), { text: '{"verdict":"no","reason":"x"}', status: "0" });
    assert.deepEqual(predictText('{"verdict":"no"}-2'), { text: '{"verdict":"no"}', status: "-2" });
    assert.equal(
      predictText('{"chunk":{"type":"text","text":"{\\"verdict\\""}}\n{"chunk":{"type":"text","text":":\\"answers\\"}"}}').text,
      '{"verdict":"answers"}',
    );
  });

  it("reads its verdict and reason, the spike's words too, and nothing else", () => {
    assert.deepEqual(parseJudgement('Sure: {"verdict":"contradicts","reason":"Lists prices from $59 to $189."}'), {
      verdict: "contradicts",
      reason: "Lists prices from $59 to $189.",
    });
    assert.equal(parseJudgement('{"verdict":"yes","reason":"ok"}')?.verdict, "answers");
    assert.equal(parseJudgement('{"verdict":"no","reason":"ok"}')?.verdict, "not-on-site");
    assert.equal(parseJudgement('{"verdict":"maybe"}'), undefined);
    assert.equal(parseJudgement("no JSON"), undefined);
  });

  it("gives the model the question, the reply, the key pages' facts and today's date", () => {
    const p = judgePrompt({
      question: "How much does Chef cost?",
      answer: "Our website does not list prices.",
      passages: ["Business $59 per node, per year"],
      keyFacts: [{ url: "https://www.chef.io/how-to-buy", title: "Pricing", facts: { prices: [{ figure: "$59", line: "Business $59" }] } }],
      today: new Date("2026-10-31T12:00:00Z"),
    });
    assert.match(p, /Today is Saturday, 31 October 2026/);
    assert.match(p, /Pricing \(https:\/\/www.chef.io\/how-to-buy\) states the price \$59: "Business \$59"/);
    assert.match(p, /"talks-about-sources"/);
    assert.match(p, /Reply: Our website does not list prices\./);
  });

  it("judges a pair once, and again when the key pages' facts change", () => {
    const a = judgementKey({ question: "How much?", answer: "It's $59." });
    assert.deepEqual(judgementKey({ question: "how  much?", answer: "it's $59." }), a);
    const b = judgementKey({
      question: "How much?",
      answer: "It's $59.",
      keyFacts: [{ url: "u", facts: { prices: [{ figure: "$59", line: "l" }] } }],
    });
    assert.notEqual(b.answerHash, a.answerHash);
  });
});

describe("judgements and holds on a result", () => {
  const who = { by: null, name: "Quinton", at: "2026-10-31T00:00:00Z", verified: false };
  const q = (over: Partial<RunQuestion> = {}): RunQuestion => ({
    question: `Q${Math.random()}?`,
    answer: "A real answer.",
    sources: [],
    answered: true,
    ...over,
  });
  const base = [q(), q(), q(), q(), q({ own: true }), q({ own: true })];

  it("only ever makes a result stricter", () => {
    assert.equal(judgeOutcome("answers"), "none");
    assert.equal(judgeOutcome("unavailable"), "none");
    assert.equal(judgeOutcome("partly"), "check");
    for (const v of ["not-on-site", "contradicts", "off-topic", "talks-about-sources"] as const) assert.equal(judgeOutcome(v), "hold");
    // A No answer stays No answer whatever the judge says.
    const none = withJudgement(q({ answered: false, answer: "" }), { verdict: "answers", reason: "fine" });
    assert.equal(none.answered, false);
    assert.equal(none.holds, undefined);
  });

  it("holds the pass until a named person decides with a reason, or says the site doesn't cover it", () => {
    const held = withJudgement(q({ intent: "price" }), { verdict: "contradicts", reason: "The page lists $59." });
    assert.equal(held.holds?.[0]?.text, "Disagrees with what the site states: The page lists $59.");
    assert.ok(openHold(held) && needsCheck(held));
    assert.ok(!validationPassed([...base, held]));
    // I checked it without a reason isn't enough for a hold that asks for a decision.
    assert.ok(openHold({ ...held, acknowledged: who }));
    assert.ok(validationPassed([...base, { ...held, acknowledged: { ...who, reason: "Quote-only plan, correct." } }]));
    assert.ok(validationPassed([...base, { ...held, notCovered: { ...who, reason: "Prices are by quote." } }]));
  });

  it("lets I checked it clear a judge's partly", () => {
    const partly = withJudgement(q(), { verdict: "partly", reason: "Leaves out Enterprise." });
    assert.equal(partly.holds?.[0]?.clear, "check");
    assert.ok(validationPassed([...base, { ...partly, acknowledged: who }]));
  });

  it("counts a may-not-answer kept with a reason as answered", () => {
    const declined = q({ answered: false, declined: true, holds: [{ by: "claim", clear: "decide", text: "It may not answer." }] });
    assert.ok(!validationPassed([...base, declined]));
    assert.ok(validationPassed([...base, { ...declined, acknowledged: { ...who, reason: "The site has no steps for this." } }]));
  });
});

describe("generated questions spread across the site", () => {
  const page = (url: string, title: string, updated = "2026-06-01") => ({ id: url, url, title, words: 500, updated: new Date(updated) });

  it("takes one page per section first, never two on the same topic, recent pages first", () => {
    const pages = [
      page("https://www.chef.io/how-to-buy/business", "Chef Business plan"),
      page("https://www.chef.io/how-to-buy/enterprise", "Chef Enterprise plan"),
      page("https://www.chef.io/how-to-buy/compare", "Compare Chef plans"),
      page("https://www.chef.io/products/chef-infra", "Chef Infra"),
      page("https://www.chef.io/products/chef-inspec", "Chef InSpec"),
      page("https://www.chef.io/solutions/compliance", "Compliance automation"),
      page("https://www.chef.io/blog/old-post", "Old post", "2019-01-01"),
    ];
    const picked = spreadPages(pages, 4, new Date("2026-10-31"));
    assert.equal(picked.length, 4);
    // The first round takes one page per section: questions come from them first, spares after.
    assert.equal(new Set(picked.slice(0, 3).map((p) => sectionOf(p.url))).size, 3);
    assert.ok(picked.slice(0, 3).filter((p) => sectionOf(p.url) === "how-to-buy").length <= 1);
    assert.ok(!picked.some((p) => p.url.includes("old-post")));
  });

  it("never two Color Wonder pages", () => {
    const pages = [
      page("https://www.crayola.com/products/color-wonder-markers", "Color Wonder Markers"),
      page("https://www.crayola.com/products/color-wonder-paper", "Color Wonder Paper"),
      page("https://www.crayola.com/stain-tips/crayon-on-walls", "Crayon on painted walls"),
      page("https://www.crayola.com/crafts/paper-flowers", "Paper flowers"),
    ];
    const picked = spreadPages(pages, 4);
    assert.ok(picked.filter((p) => /color wonder/i.test(p.title ?? "")).length <= 1);
  });

  it("reads a section after a language folder", () => {
    assert.equal(sectionOf("https://kemptechnologies.com/de/pricing/loadmaster"), "pricing");
    assert.equal(sectionOf("https://kemptechnologies.com/pricing"), "/");
  });
});
