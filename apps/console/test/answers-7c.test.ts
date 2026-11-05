// Fix cycle 7c, track D: mechanisms, tested on shapes the sites in the release checks showed, written
// out here with invented names. The chat's replacement is tested in packages/widget/test/prices.test.ts.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { checkPriceClaims, isAnswered, type PriceRow, type PriceTable, verdict } from "@launchpad/theme";
import { judgementKey, judgePrompt } from "../src/lib/judge.ts";
import { ANSWERING_RULES, intentSearchConfig, pricesParagraph, withPricesParagraph } from "../src/lib/prompt.ts";
import { addPriceRow, editPriceRow } from "../src/lib/review.ts";
import {
  carriedFromRun,
  carriedOver,
  datePairingHold,
  evidenceHolds,
  inventedPriceHold,
  judgeAnswer,
  locateFigures,
  pairedOnLine,
  priceTableCheck,
  promptPrices,
  provedDates,
  type RunQuestion,
  recheckDiff,
  sameSubstance,
  withJudgement,
} from "../src/lib/validation-rules.ts";

const URL_ = "https://mail.example/pricing";
const row = (plan: string, value: number, extra: Partial<PriceRow> = {}): PriceRow => ({
  plan,
  amount: `$${value}`,
  value,
  period: "month",
  url: URL_,
  line: `${plan} $${value}`,
  ...extra,
});
const table = (rows: PriceRow[]): PriceTable => ({ rows, pages: [URL_], readAt: "2026-11-02T00:00:00Z", hash: "h" });
const by = { by: "u1", name: "Dana", at: "2026-11-02T00:00:00Z", verified: true };

const VOLUME = table([row("Basic", 15), row("Pro", 16.5), row("Platform", 18)]);
const TOGGLE = table([
  row("Basic", 10, { unit: "per user", qualifiers: ["billed annually"] }),
  row("Basic", 12, { unit: "per user" }),
  row("Basic", 120, { unit: "per user", period: "year" }),
  row("Premium", 17, { unit: "per user", qualifiers: ["billed annually"] }),
  row("Premium", 20, { unit: "per user" }),
  row("Premium", 200, { unit: "per user", period: "year" }),
]);

describe("one figure doesn't excuse another, and a plan's several prices aren't a conflict", () => {
  it("holds a wrong figure beside a right one", () => {
    const wrong = table([row("Premium", 210, { period: "year", unit: "per user" }), row("Premium", 20, { unit: "per user" })]);
    const c = checkPriceClaims("Premium is $200 per user per year, or $20 monthly.", wrong, [URL_]);
    assert.equal(c.contradictions[0]?.said, "$200");
  });

  it("passes annual and monthly prices of one plan", () => {
    for (const a of [
      "Premium: $200 per user per year, or $20 monthly.",
      "Premium is $17 per user per month billed annually, or $20 month to month.",
      "Basic is $120 per user per year instead of $144.",
    ]) {
      const c = checkPriceClaims(a, TOGGLE, [URL_]);
      assert.deepEqual(c.contradictions, [], a);
    }
  });

  it("reads an overage rate as no claim on the plan's price", () => {
    for (const a of [
      "Extra emails cost $1.80 / 1,000 on Basic, $1.30 / 1,000 on Pro, and $1.20 / 1,000 on Platform.",
      "Basic: $15.00 /mo, extra emails @ $1.80 / 1,000.",
      "Basic is $15 per month, and $1.80 per 1,000 extra emails.",
      "Pro is $16.50 a month, with a $25 setup fee.",
    ]) {
      const c = checkPriceClaims(a, VOLUME, [URL_]);
      assert.deepEqual(c.contradictions, [], a);
    }
  });

  it("still holds another plan's figure with the same unit, in a list too", () => {
    assert.equal(checkPriceClaims("Basic is $18 per month for 10,000 emails.", VOLUME, [URL_]).contradictions[0]?.said, "$18");
    assert.equal(checkPriceClaims("Basic $18, Pro $16.50, Platform $15, each per month.", VOLUME, [URL_]).contradictions.length, 2);
  });

  it("takes $0 as a price, and a free plan as a row", () => {
    const free = addPriceRow(VOLUME, { plan: "Free", amount: "$0.00", period: "month" });
    assert.ok("table" in free);
    assert.equal(free.table.rows.at(-1)?.value, 0);
    assert.deepEqual(checkPriceClaims("Free is $0 per month.", free.table, [URL_]).contradictions, []);
    assert.equal(checkPriceClaims("Basic is $0 per month.", free.table, [URL_]).contradictions[0]?.plan, "Basic");
    assert.ok("table" in editPriceRow(free.table, 3, { amount: "$0" }));
  });

  it("lets a person say what tells two prices apart", () => {
    const edited = editPriceRow(VOLUME, 0, { amount: "$55", note: "50,000 emails" });
    assert.ok("table" in edited);
    assert.deepEqual(edited.table.rows[0]?.qualifiers, ["50,000 emails"]);
  });
});

describe("a table nobody confirmed may lack rows", () => {
  const READ = table([row("Basic", 10), row("Premium", 17)]);
  const LINES = ["Basic is $120 per user per year instead of $144, and Premium is $200 instead of $240."];
  const plans = ["Basic", "Premium"];

  it("takes a figure the pricing page pairs with the plan as the table's gap", () => {
    assert.equal(pairedOnLine(LINES, plans, "Premium", 200), true);
    assert.equal(pairedOnLine(LINES, plans, "Basic", 200), false);
    const ok = priceTableCheck("Premium is $200 per year.", READ, [URL_], "en", { provisional: true, pricingLines: LINES });
    assert.deepEqual(ok.holds, []);
    const wrong = priceTableCheck("Basic is $200 per year.", READ, [URL_], "en", { provisional: true, pricingLines: LINES });
    assert.equal(wrong.holds.length, 1);
  });

  it("still holds another row's figure", () => {
    const held = priceTableCheck("Premium is $10.", READ, [URL_], "en", { provisional: true, pricingLines: LINES });
    assert.equal(held.holds.length, 1);
  });
});

describe("the judge reads the table, and isn't the last word on a confirmed one", () => {
  const q: RunQuestion = { question: "How much is Premium?", answer: "Premium is $17 or $20.", sources: [], answered: true };
  it("gives it the table, and says a plan has several prices", () => {
    const prompt = judgePrompt({ question: q.question, answer: q.answer, passages: [], priceTable: TOGGLE });
    assert.match(prompt, /Price table:\n- Basic: \$10 per user per month \(billed annually\)/);
    assert.match(prompt, /Two such prices of one plan never conflict/);
    assert.match(prompt, /"substituted"/);
  });
  it("judges again when the table changes", () => {
    const a = judgementKey({ question: "q", answer: "a", priceTable: VOLUME });
    assert.notEqual(a.answerHash, judgementKey({ question: "q", answer: "a", priceTable: TOGGLE }).answerHash);
  });
  it("never lets grounding release a substitution", () => {
    const held = withJudgement(q, { verdict: "substituted", reason: "A date for another event." }, { holds: [] }, { grounded: true });
    assert.equal(held.holds?.[0]?.clear, "decide");
  });
});

describe("the price configuration lists the table (answering rules 6)", () => {
  it("lists rows with unit, period and what tells them apart, never the reader's notes", () => {
    const p = pricesParagraph([
      row("Enterprise", 189, { unit: "per node", period: "year", qualifiers: ["unit and period as the page states for its other plans"] }),
    ]);
    assert.match(p, /- Enterprise: \$189 per node per year\n/);
    assert.doesNotMatch(p, /as the page states/);
    assert.match(p, /Never say a price, unit or billing listed here isn't stated/);
  });
  it("goes in the price configuration only, and is refreshed in place", () => {
    const filter = { field: {} };
    const rows = [row("Basic", 15)];
    const price = intentSearchConfig("P", "en", "price", filter, null, false, undefined, rows).prompt as { system: string };
    const trial = intentSearchConfig("P", "en", "trial", filter, null, false, undefined, rows).prompt as { system: string };
    assert.match(price.system, /Basic: \$15 per month/);
    assert.doesNotMatch(trial.system, /Basic: \$15/);
    assert.match(withPricesParagraph(price.system, pricesParagraph([row("Basic", 16)])), /Basic: \$16 per month/);
    assert.ok(ANSWERING_RULES >= 6);
  });
  it("prefers the confirmed table, and drops names that may not be plans from a read one", () => {
    const rows = [row("Basic", 15), row("Most popular", 16)];
    const read = { priceTable: { ...table(rows), hash: "x" } };
    assert.deepEqual(
      promptPrices(read).map((r) => r.plan),
      ["Basic"],
    );
    const confirmed = { ...read, priceTableConfirmation: { hash: "x", by: "D", at: "2026" } };
    assert.equal(promptPrices(confirmed as never).length, 2);
  });
});

describe("a site with no prices", () => {
  it("holds a figure on no page, judge on or off", () => {
    const hold = inventedPriceHold([{ figure: "$375", kind: "price" }]);
    assert.equal(hold?.clear, "decide");
    assert.equal(inventedPriceHold([{ figure: "$375", kind: "price", page: { title: "x", url: "https://x.test" } }]), undefined);
    assert.equal(inventedPriceHold([{ figure: "4 May", kind: "date" }]), undefined);
  });
});

describe("the date checks", () => {
  it("places a date by month and day, in any format, never by its digits", () => {
    const place = (answer: string, text: string) =>
      locateFigures(answer, ["date"], [{ url: "https://x.test/a", title: "A", text }])[0]?.page?.url;
    assert.ok(place("It starts on November 3, 2026.", "Trade fair | November 03, 2026 | Warsaw"));
    assert.ok(place("It starts on 3 November 2026.", "Messe am 3. November 2026"));
    assert.ok(place("It starts on November 3, 2026.", "Termin: 03.11.2026"));
    assert.equal(place("It starts on November 3, 2026.", "Platform Innovations Delivered Q3 2026"), undefined);
    assert.ok(place("It runs November 11–12, 2026.", "T-6426 | November 11, 2026 | online"));
  });

  it("reads a date as its own line states it", () => {
    const events = [
      {
        date: "2026-11-04",
        readAs: "4 November 2026, as written",
        line: "will host an investor webinar on Thursday, November 5, 2026",
        url: "https://x.test/e",
      },
    ];
    const [e] = provedDates(events);
    assert.equal(e?.date, "2026-11-05");
    const { holds } = evidenceHolds("When is the next webinar?", "The next webinar is on November 5, 2026.", { events });
    assert.deepEqual(holds, []);
  });

  it("checks each date against what it's given to", () => {
    const page =
      "SEEBURGER Integration Summit 2026\nNeckarsulm\n26. November 2026 - 27. November 2026\n\n\n\n\nGS1 EXCHANGE\nKöln\n01. Dezember 2026";
    const wrong = "SEEBURGER auf dem GS1 EXCHANGE: E-Rechnung 2026, Köln – bis 27. November 2026.";
    assert.match(datePairingHold(wrong, [page], "SEEBURGER")?.text ?? "", /27\. November/);
    const right = "SEEBURGER auf dem GS1 EXCHANGE: E-Rechnung 2026, Köln – am 01. Dezember 2026.";
    assert.equal(datePairingHold(right, [page], "SEEBURGER"), undefined);
    assert.equal(datePairingHold("Am 27. November 2026.", [page], "SEEBURGER"), undefined);
  });
});

describe("decisions carry unless the answer changes in substance", () => {
  const sources = [{ title: "Pricing", url: URL_ }];
  const before: RunQuestion = {
    question: "How much is Pro?",
    answer: "Pro is $16.50 per month.",
    sources,
    answered: true,
    flags: ["price"],
    acknowledged: by,
  };
  it("the same figures on another page cited is the same answer", () => {
    const now: RunQuestion = {
      ...before,
      answer: "We list Pro at $16.50 a month.",
      sources: [{ title: "Plans", url: "https://mail.example/plans" }],
      acknowledged: undefined,
    };
    assert.equal(sameSubstance(before, now), true);
    assert.equal(carriedOver(before, now).acknowledged?.name, "Dana");
  });
  it("another figure isn't", () => {
    const now: RunQuestion = { ...before, answer: "Pro is $18 per month.", acknowledged: undefined };
    assert.equal(sameSubstance(before, now), false);
    assert.equal(carriedOver(before, now).acknowledged, undefined);
  });
  it("a reworded denial's price hold keeps its decision: the quote isn't the hold", () => {
    const hold = (quote: string) => ({
      by: "price" as const,
      clear: "decide" as const,
      table: "h",
      text: `Pro is $16.50 on /pricing; this answer says it isn't listed (“${quote}”).`,
    });
    const kept: RunQuestion = {
      ...before,
      answer: "We don't list it.",
      flags: [],
      sources,
      holds: [hold("We don't list it.")],
      acknowledged: { ...by, reason: "Known" },
    };
    const now: RunQuestion = {
      ...kept,
      answer: "It isn't listed on our page.",
      holds: [hold("It isn't listed on our page.")],
      acknowledged: undefined,
    };
    assert.equal(carriedFromRun([kept], now).acknowledged?.reason, "Known");
  });
  it("a reworded answer with no figures carries on a page in common and most of its words", () => {
    const a: RunQuestion = {
      question: "Do you offer SSO?",
      answer: "Single sign-on is available with SAML on every plan.",
      sources,
      answered: true,
      checks: ["off-source"],
      acknowledged: by,
    };
    const b: RunQuestion = {
      ...a,
      answer: "SAML single sign-on is available on all plans.",
      sources: [...sources, { title: "Security", url: "https://mail.example/security" }],
      acknowledged: undefined,
    };
    assert.equal(carriedOver(a, b).acknowledged?.name, "Dana");
  });
});

describe("the re-run counts the judge", () => {
  it("calls an answer the judge holds worse, when the current one had no such hold", () => {
    const q = "When is the conference?";
    const good: RunQuestion = { question: q, answer: "It's on 5 May 2027.", sources: [], answered: true };
    const held: RunQuestion = {
      ...good,
      answer: "Our webinar is on 5 May 2027.",
      holds: [{ by: "judge", clear: "decide", text: "A date for another event." }],
    };
    assert.equal(recheckDiff([], [good], [held]).worse.length, 1);
    assert.equal(recheckDiff([], [held], [held]).worse.length, 0);
    assert.equal(recheckDiff([], [good], [{ ...held, holds: [{ by: "judge", clear: "check", text: "In part." }] }]).worse.length, 0);
  });
});

describe("the thing asked against what the reply is about (a set written apart from the rules)", () => {
  const SET = JSON.parse(readFileSync(new URL("./fixtures/verdict-subject-7c.json", import.meta.url), "utf8")) as {
    q: string;
    a: string;
    l: string;
  }[];
  const isAnswer = (l: string) => l === "answered" || l === "partly";
  for (const x of SET) {
    it(`${x.l}: ${x.q}`, () => {
      assert.equal(isAnswered(verdict({ answer: x.a, status: "success", question: x.q })), isAnswer(x.l), x.a);
    });
  }
  it("keeps every reason it holds in judgeAnswer", () => {
    const j = judgeAnswer(
      { question: "How much does the Pro plan cost?", own: true },
      {
        answer: "The Pro plan includes unlimited projects, SSO and priority support, and works with all our integrations.",
        status: "success",
      },
    );
    assert.equal(j.verdict, "substituted");
    assert.match(j.holds?.[0]?.text ?? "", /gives a step for other details, but none for a price/);
  });
});
