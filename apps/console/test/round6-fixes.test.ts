// Round 6's re-check fixes: figures in local formats on the answer side of the price check, the
// answering rules re-check comparing like with like, price checks carried over a rewording, and
// the chat's non-answer rule judged on held-out wordings it was never tuned on.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { isAnswered, verdict } from "@launchpad/theme";
import { joinFigures, labelFigures } from "../src/lib/content-plan.ts";
import { historyWhat } from "../src/lib/history.ts";
import { activityChip } from "../src/lib/overview.ts";
import {
  answerFigures,
  carriedOver,
  locateFigures,
  type RunQuestion,
  recheckDiff,
  recheckDiffAfterSecondAsk,
  worseToAskAgain,
} from "../src/lib/validation-rules.ts";

const read = <T>(name: string): T => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")) as T;
const strong = { score: 0.31, type: "RERANKER" };
const by = { by: null, name: "R6 Recheck", at: "2026-10-31T15:00:00Z", verified: false };

describe("figures in local formats, on the answer side", () => {
  it("reads “1 250 €” as 1250, and “37,50 €” as the same as “37,5 €”", () => {
    assert.deepEqual(answerFigures("Das Paket kostet 1 250 € im Jahr.", ["price"]), ["1250"]);
    assert.deepEqual(
      answerFigures("Le module coûte 37,50 € par mois.", ["price"]),
      answerFigures("Le module coûte 37,5 € par mois.", ["price"]),
    );
    assert.deepEqual(answerFigures("Plans for 50 FTE get 50 % off.", ["price"]), []);
  });

  it("places a figure on the page line that states it in another format", () => {
    const [f] = locateFigures(
      "Booster: 37,5 € pro Monat.",
      ["price"],
      [{ url: "https://www.teamleader.eu/de/preise", title: "Preise", text: "## Booster\nProjektmanagement: 37,50 € pro Monat" }],
    );
    assert.equal(f?.page?.url, "https://www.teamleader.eu/de/preise");
    const [g] = locateFigures(
      "Focus costs 1 250 € a year.",
      ["price"],
      [{ url: "https://x.example/prijs", title: "Prijs", text: "Focus: 1.250 € per jaar" }],
    );
    assert.equal(g?.page?.url, "https://x.example/prijs");
  });

  it("keeps I checked it on a reworded price answer whose figures sit on the same lines", () => {
    const page = { url: "https://www.teamwork.com/pricing/", title: "Pricing plans" };
    const checked: RunQuestion = {
      question: "How much do your plans cost?",
      answer: "Basics is $9.99 and Accelerate is $24.99 per user per month, billed yearly.",
      sources: [page],
      answered: true,
      flags: ["price"],
      figures: [
        { figure: "$9.99", kind: "price", page, excerpt: "Basics $9.99 /user/month billed yearly" },
        { figure: "$24.99", kind: "price", page, excerpt: "Accelerate $24.99 /user/month billed yearly" },
      ],
      acknowledged: by,
    };
    const reworded: RunQuestion = {
      ...checked,
      acknowledged: undefined,
      answer: "Our plans: Free ($0), Basics 9.99 $ and Accelerate 24.99 $ per user per month.",
      figures: [
        { figure: "$0", kind: "price", page, excerpt: "Free $0" },
        { figure: "9.99 $", kind: "price", page, excerpt: "Basics $9.99 /user/month billed yearly" },
        { figure: "24.99 $", kind: "price", page, excerpt: "Accelerate $24.99 /user/month billed yearly" },
      ],
    };
    assert.deepEqual(carriedOver(checked, reworded).acknowledged, by);
  });
});

describe("the answering rules re-check, like with like", () => {
  const q = (question: string, over: Partial<RunQuestion> = {}): RunQuestion => ({
    question,
    answer: "An answer.",
    sources: [],
    answered: true,
    ...over,
  });

  it("calls worse only an answer that stops answering, or a new failure", () => {
    const decided = [q("A?"), q("B?"), q("C?"), q("D?")];
    const current = [q("A?"), q("B?"), q("C?"), q("D?", { answered: false, answer: "" })];
    const latest = [
      // A new check to look at: information, not worse.
      q("A?", { flags: ["date"], holds: [{ by: "judge", clear: "check", text: "Answers in part." }] }),
      q("B?", { answered: false, answer: "" }),
      q("C?", { failure: "Talks about how it works internally" }),
      q("D?"),
    ];
    const diff = recheckDiff(decided, current, latest);
    assert.deepEqual(
      diff.worse.map((w) => [w.question, w.was]),
      [
        ["B?", "No answer"],
        ["C?", "Failed: Talks about how it works internally"],
      ],
    );
    assert.equal(diff.better, 1);
    assert.equal(diff.unchanged, 1);
  });

  it("compares with the answer under the current rules today, not the last run's", () => {
    // The last run answered while pages that have since left were in; today neither rule answers.
    const decided = [q("Money back?")];
    const current = [q("Money back?", { answered: false, answer: "" })];
    const latest = [q("Money back?", { answered: false, answer: "" })];
    assert.deepEqual(recheckDiff(decided, current, latest).worse, []);
  });

  it("keeps a person's decision on both sides", () => {
    const decided = [q("Price?", { answered: false, notCovered: { ...by, reason: "By quote." } })];
    const current = [q("Price?", { answered: false, answer: "" })];
    const latest = [q("Price?", { answered: false, answer: "" })];
    assert.deepEqual(recheckDiff(decided, current, latest).worse, []);
  });
});

describe("the answering rules re-check asks a worse answer again (recheck 2)", () => {
  const q = (question: string, over: Partial<RunQuestion> = {}): RunQuestion => ({
    question,
    answer: "An answer.",
    sources: [],
    answered: true,
    ...over,
  });
  const quote = "¿Cómo puedo solicitar una cotización personalizada?";

  it("isn't worse when the second ask answers (whatsupgold.com: 1 empty answer of 21, fine 3 of 3 asked again)", () => {
    const decided = [q(quote), q("Price?")];
    const current = [q(quote), q("Price?")];
    const latest = [q(quote, { answered: false, answer: "" }), q("Price?")];
    const first = recheckDiff(decided, current, latest);
    assert.deepEqual([...worseToAskAgain(first)].length, 1);
    const again = [q(quote, { answer: "Para solicitar una cotización personalizada, comuníquese con nuestro equipo de ventas." })];
    const diff = recheckDiffAfterSecondAsk(decided, current, latest, again);
    assert.deepEqual(diff.worse, []);
    assert.equal(diff.unchanged, 2);
    assert.equal(diff.total, 2);
  });

  it("is worse when the second ask is worse too, with the second answer shown", () => {
    const decided = [q(quote), q("Price?")];
    const current = [q(quote), q("Price?")];
    const latest = [q(quote, { answered: false, answer: "" }), q("Price?")];
    const again = [q(quote, { answered: false, answer: "No sé." })];
    const diff = recheckDiffAfterSecondAsk(decided, current, latest, again);
    assert.deepEqual(
      diff.worse.map((w) => [w.question, w.after, w.was]),
      [[quote, "No sé.", "No answer"]],
    );
    assert.equal(diff.unchanged, 1);
  });

  it("asks again only the answers called worse", () => {
    const current = [q("A?"), q("B?"), q("C?", { answered: false, answer: "" })];
    const latest = [q("A?", { answered: false, answer: "" }), q("B?"), q("C?")];
    assert.deepEqual([...worseToAskAgain(recheckDiff([], current, latest))], [...worseToAskAgain({ worse: [{ question: "A?" }] })]);
  });

  it("shows a repeat hold (the daily re-check) without a second warning", () => {
    const first = { from: 0, to: 3, total: 21, worse: [] };
    assert.equal(activityChip("deployment.rules.held", first).tone, "warning");
    assert.equal(activityChip("deployment.rules.held", { ...first, repeat: true }).tone, "neutral");
    assert.match(historyWhat("deployment.rules.held", { ...first, repeat: true }), /still worse/);
    assert.doesNotMatch(historyWhat("deployment.rules.held", first), /still worse/);
  });
});

describe("figures at ingest (extractor 5, recheck 2)", () => {
  it("keeps chef.io's Enterprise price with its plan when the Knowledge Box cuts the text", () => {
    // /how-to-buy as synced (review DB): the Knowledge Box opened the "Enterprise Plus" paragraph with "$ 189".
    const page = [
      "##### Business",
      "Suitable for organisations that need to automate jobs.",
      "$ 59",
      "per node, per year",
      "Get a Quote",
      "##### Enterprise",
      "For organizations tasked with maturing DevOps automation.",
      "$ 189",
      "##### Enterprise Plus",
      "Contact us for a customized quote.",
    ].join("\n\n");
    const joined = joinFigures(page);
    assert.match(joined, /\nBusiness: \$ 59 per node, per year\n\nGet a Quote\n/);
    assert.match(joined, /\nEnterprise: \$ 189\n\n##### Enterprise Plus\n/);
  });

  it("labels only a price alone on its line, the first under its heading", () => {
    assert.equal(labelFigures("## Plans\n\nBasics costs $ 9.99 a month."), "## Plans\n\nBasics costs $ 9.99 a month.");
    assert.equal(labelFigures("$ 59\n\nper node"), "$ 59\n\nper node");
    // Extractor 6: a second price just under a labelled one is the same plan's other billing cycle
    // (sharefile.com's toggle), so it takes the name too.
    assert.equal(labelFigures("## Pro\n\n$ 10\n\n$ 20"), "## Pro\n\nPro: $ 10\n\nPro: $ 20");
    assert.equal(labelFigures("## Pro\n\n$ 10\n\nIncludes everything\n\n$ 20"), "## Pro\n\nPro: $ 10\n\nIncludes everything\n\n$ 20");
    // A button after the price isn't its unit.
    assert.equal(labelFigures("## Pro\n\n49,99 €\n\nJetzt kaufen"), "## Pro\n\nPro: 49,99 €\n\nJetzt kaufen");
  });

  it('never turns a "&" between two numbers into a currency (teamwork.com\'s "4 & 5 Nov" was sent as "4 $5 Nov")', () => {
    const banner = "Live webinars, 4 & 5 Nov.Register now →\n\n| Basics | & 9.99 | $ 24.99 |";
    assert.equal(joinFigures(banner), "Live webinars, 4 & 5 Nov.Register now →\n\n| Basics | $9.99 | $ 24.99 |");
    assert.equal(joinFigures("Steps 1 &2, from $ 5"), "Steps 1 &2, from $ 5");
  });
});

describe("the chat's non-answer rule on wordings it was never tuned on", () => {
  type Set = Record<string, { nonAnswers: { question: string; answer: string }[]; controls: { question: string; answer: string }[] }>;
  const caught = (lang: string, p: { question: string; answer: string }) =>
    !isAnswered(verdict({ answer: p.answer, status: "success", best: strong, question: p.question, language: lang }));

  it("the verifier's five round-6 wordings (seen once, after the rule was generalised)", () => {
    for (const [question, answer] of [
      ["What are your prices?", "I'm not able to find pricing details in what I have to work with."],
      ["When is the next webinar?", "Sadly, the information at hand doesn't mention when the next webinar takes place."],
      ["How much does the Accelerate plan cost?", "My reference material is quiet on what the Accelerate plan costs."],
      ["What is your phone number?", "That's beyond what the documents in front of me cover, so I can't give you a phone number."],
      ["How much is the Enterprise plan?", "No figures for the Enterprise plan come up anywhere in what I can look at."],
    ] as const) {
      assert.equal(verdict({ answer, status: "success", best: strong, question }), "may-not-answer", answer);
    }
  });

  // Written by an agent that never saw the rules, scored once and never tuned on. The floors are
  // what it scored (en 10/10, de 5/10, fr 8/10, es 7/10): they may rise, never fall. No control flagged.
  const FLOORS: Record<string, number> = { en: 10, de: 5, fr: 8, es: 7 };
  for (const [lang, set] of Object.entries(read<Set>("heldout-r6b.json"))) {
    it(`held-out set B, ${lang}: at least ${FLOORS[lang]} of ${set.nonAnswers.length}, and no control flagged`, () => {
      assert.ok(set.nonAnswers.filter((p) => caught(lang, p)).length >= (FLOORS[lang] ?? 0));
      for (const c of set.controls) assert.ok(!caught(lang, c), c.answer);
    });
  }

  // Set A was scored once blind (en 10/15, de 4/15, fr 2/15, es 3/15), then looked at to generalise
  // the strong-absence words: it's a tuning set now. Its controls still must never be flagged.
  for (const [lang, set] of Object.entries(read<Set>("heldout-r6a.json"))) {
    it(`set A, ${lang}: no control flagged`, () => {
      for (const c of set.controls) assert.ok(!caught(lang, c), c.answer);
    });
  }
});
