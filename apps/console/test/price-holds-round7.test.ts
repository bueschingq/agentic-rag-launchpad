// Round 7, fix track B: the claim check, validation, the confirm step and the chat hold the line
// even when a table is wrong or missing. The cases are the release check's (sealed-S1): each
// site's five mislabels, its corrected table, the judge's verdict recorded on the live run, and the
// real reply the mislabel replaced. Judge on: that recorded verdict; judge off: none.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import type { PriceRow, PriceTable } from "@launchpad/db";
import type { AskResult } from "@launchpad/par-client";
import { checkPriceClaims, planNameDoubt, priceRowsHash, questionIntents, strangersIn, verdict } from "@launchpad/theme";
import { PRICE_TABLE_ISSUES, priceTableIssue } from "../src/lib/overview.ts";
import { replacesTable } from "../src/lib/price-table.ts";
import { addPriceRow, deletePriceRow, editPriceRow, priceTableLine } from "../src/lib/review.ts";
import {
  carriedFromRun,
  dateTenseHold,
  evidenceHolds,
  intentQuestions,
  judgeAnswer,
  plainQuote,
  pricingProvenanceHold,
  provisionalTable,
  type RunQuestion,
  starterNeed,
  withJudgement,
} from "../src/lib/validation-rules.ts";

interface Case {
  question: string;
  mislabel: string;
  expect: string;
  judge: { verdict: "contradicts" | "not-on-site"; reason: string } | null;
  real: string;
}
const SITES = JSON.parse(readFileSync(new URL("./fixtures/mislabels-round7.json", import.meta.url), "utf8")) as Record<
  string,
  { rows: PriceRow[]; cases: Case[] }
>;
const tableOf = (rows: PriceRow[]): PriceTable => ({
  rows,
  pages: [rows[0]?.url ?? ""],
  readAt: "2026-11-02T00:00:00Z",
  hash: priceRowsHash(rows),
});
// The reply as an ask brings it back: citing the pricing page.
const asked = (answer: string, url: string): AskResult => ({
  answer,
  status: "success",
  citations: { r1: [[0, 5]] },
  retrieval_results: {
    resources: {
      r1: {
        title: "Pricing",
        origin: { url },
        fields: { "/t/text": { paragraphs: { "r1/t/text/0-80": { score: 0.3, score_type: "RERANKER", text: "Pricing" } } } },
      },
    },
  },
});
const heldNoCheck = (q: RunQuestion) => Boolean(q.holds?.some((h) => h.clear === "decide"));

for (const [site, { rows, cases }] of Object.entries(SITES)) {
  const table = tableOf(rows);
  const url = rows[0]?.url ?? "";
  describe(`${site}: the release check's mislabels`, () => {
    for (const c of cases) {
      for (const context of [{ priceTable: table }, { pricingFacts: table }]) {
        const kind = context.priceTable ? "confirmed table" : "no confirmed table";
        const judged = () => judgeAnswer({ question: c.question, own: true }, asked(c.mislabel, url), undefined, undefined, context);
        it(`holds, ${kind}, judge off: ${c.mislabel}`, () => {
          const q = withJudgement(judged(), undefined);
          assert.ok(heldNoCheck(q), JSON.stringify(q.holds));
          assert.ok(!q.tableMatched);
          assert.notEqual(starterNeed(q, { checked: true }).need, "ok");
        });
        it(`holds, ${kind}, judge on: ${c.mislabel}`, () => {
          const q = withJudgement(judged(), c.judge ?? undefined, { holds: [] }, { grounded: true });
          assert.ok(heldNoCheck(q), JSON.stringify(q.holds));
        });
      }
    }
    // Buzzsprout's real replies are the denials the release check failed: they're held instead.
    if (site !== "buzzsprout") {
      for (const c of cases) {
        it(`doesn't hold the real reply: ${c.real.slice(0, 60)}`, () => {
          const q = judgeAnswer({ question: c.question, own: true }, asked(c.real, url), undefined, undefined, { priceTable: table });
          assert.deepEqual(q.holds?.filter((h) => h.by === "price") ?? [], []);
        });
      }
    }
  });
}

const TRANSISTOR = tableOf(SITES.transistor?.rows ?? []);
const BUZZSPROUT = tableOf(SITES.buzzsprout?.rows ?? []);
const TURL = TRANSISTOR.pages;
const BURL = BUZZSPROUT.pages;

describe("correct answers against the corrected tables", () => {
  for (const [question, answer] of [
    ["How much is the Audio plan?", "The Audio plan is $15/month billed annually, or $18 billed monthly."],
    ["How much is the Audio + Video plan?", "The Audio + Video plan costs $25/month billed annually, or $30 billed monthly."],
    ["What are your prices?", "Paid plans start at $15/month: Audio $15, Audio + Video $25, Multi-Podcast $30, billed annually."],
    ["How much does the Multi-Podcast plan cost?", "Multi-Podcast is $30/month billed annually, or $36 monthly."],
    ["What does the Audio plan cost per month?", "The Audio plan is $18 per month, billed monthly."],
  ] as const) {
    it(`holds nothing, either way: ${answer}`, () => {
      const url = BURL[0] ?? "";
      for (const context of [{ priceTable: BUZZSPROUT }, { pricingFacts: BUZZSPROUT }]) {
        const q = withJudgement(judgeAnswer({ question, own: true }, asked(answer, url), undefined, undefined, context), undefined);
        assert.deepEqual(q.holds ?? [], []);
      }
    });
  }
  const right: [string, string, PriceTable][] = [
    ["How much is Enterprise 1?", "Enterprise 1 $199/mo, or $1,990 per year.", TRANSISTOR],
    ["How much is the Starter plan per year?", "Starter is $190 per year.", TRANSISTOR],
    [
      "How much does Buzzsprout cost?",
      "The Audio plan is $15/month billed annually or $18 monthly; Audio + Video is $25 or $30; Multi-Podcast is $30 or $36.",
      BUZZSPROUT,
    ],
    ["What plans do you offer?", "Our Pricing page says paid plans start at $15/month.", BUZZSPROUT],
  ];
  for (const [question, answer, table] of right) {
    it(`doesn't hold: ${answer}`, () => {
      assert.deepEqual(checkPriceClaims(answer, table, table.pages, "en", { question }).contradictions, []);
    });
  }
});

// The other shapes: a toggle site with digits in its plans' names, not one of the release check's.
const SYNTH_URL = "https://example-hosting.test/plans";
const synthRows: PriceRow[] = [
  ["Solo 2", 12, 120],
  ["Team 10", 40, 400],
  ["Studio", 90, 900],
].flatMap(([plan, month, year]) => [
  { plan: plan as string, amount: `$${month}`, value: month as number, period: "month" as const, url: SYNTH_URL, line: "" },
  { plan: plan as string, amount: `$${year}`, value: year as number, period: "year" as const, url: SYNTH_URL, line: "" },
]);
const SYNTH = tableOf(synthRows);

describe("a figure match isn't a plan match", () => {
  // The table as it was built on the release check: every plan named wrong.
  const wrong = tableOf(
    (
      [
        ["Podcast hosting pricing", 19],
        ["Recommended", 49],
        ["Dynamic show notes", 99],
        ["Subscription Add-ons", 199],
      ] as const
    ).map(([plan, value]) => ({ plan, amount: `$${value}`, value, period: "month" as const, url: TURL[0] ?? "", line: "" })),
  );
  it("never matches a figure given for a plan the table doesn't have", () => {
    const q = judgeAnswer(
      { question: "How much is the Professional plan?", own: true },
      asked("The Professional plan is $99 per month.", TURL[0] ?? ""),
      undefined,
      undefined,
      { priceTable: wrong },
    );
    assert.ok(!q.tableMatched);
    assert.deepEqual(checkPriceClaims("Professional is $99.", wrong, TURL, "en", { strangers: strangersIn }).unverified, [
      { plan: "Professional", said: "$99" },
    ]);
  });
  it("gives a figure with no plan to the plan asked about", () => {
    const c = checkPriceClaims("It's $99 a month.", TRANSISTOR, TURL, "en", { question: "How much is the Professional plan?" });
    assert.equal(c.contradictions[0]?.plan, "Professional");
    const s = checkPriceClaims("It's $40 a month.", SYNTH, [SYNTH_URL], "en", { question: "How much is Solo 2?" });
    assert.equal(s.contradictions[0]?.plan, "Solo 2");
  });
  it("matches the plan's own figure", () => {
    const q = judgeAnswer(
      { question: "How much is the Professional plan?", own: true },
      asked("Professional is $49 per month.", TURL[0] ?? ""),
      undefined,
      undefined,
      { priceTable: TRANSISTOR },
    );
    assert.equal(q.tableMatched, true);
  });
  it("holds a lower 'plans start at' than the lowest plan, naming it", () => {
    const c = checkPriceClaims("Paid plans start at $12/month.", BUZZSPROUT, BURL, "en", { question: "What are your prices?" });
    assert.equal(c.contradictions[0]?.reason, "start");
    assert.equal(c.contradictions[0]?.plan, "Audio");
  });
});

describe("the judge on a price", () => {
  const q: RunQuestion = { question: "How much is it?", answer: "Starter is $49.", sources: [], answered: true };
  const contradicts = { verdict: "contradicts" as const, reason: "Starter is $19." };
  it("stays a hold whatever grounding or a table match says", () => {
    assert.equal(withJudgement(q, contradicts, { holds: [] }, { grounded: true }).holds?.[0]?.by, "judge");
    assert.equal(withJudgement(q, contradicts).holds?.[0]?.by, "judge");
  });
  it("doesn't hold an answer every figure of which the confirmed table pairs with its plan (7c, item 3)", () => {
    const matched = withJudgement({ ...q, tableMatched: true }, contradicts);
    assert.equal(matched.holds, undefined);
    assert.equal(matched.judge?.verdict, "contradicts");
    assert.equal(withJudgement({ ...q, tableMatched: true, declined: true }, contradicts).holds?.[0]?.by, "judge");
  });
  it("is still advisory on a grounded answer with no price", () => {
    const plain: RunQuestion = { ...q, answer: "Call us on the number on the page." };
    assert.equal(withJudgement(plain, contradicts, { holds: [] }, { grounded: true }).holds, undefined);
  });
});

describe("plan names with digits", () => {
  for (const [answer, table, urls] of [
    ["Enterprise 1 $199/mo", TRANSISTOR, TURL],
    ["Enterprise 1: $1,990 per year", TRANSISTOR, TURL],
    ["Solo 2 $12/mo and Team 10 $40/mo", SYNTH, [SYNTH_URL]],
  ] as const) {
    it(`reads ${answer}`, () => {
      const c = checkPriceClaims(answer, table, urls);
      assert.deepEqual(c.contradictions, []);
      assert.deepEqual(c.unlisted, []);
    });
  }
  it("reads a digit in a name the table doesn't have", () => {
    assert.deepEqual(checkPriceClaims("Enterprise 7 $199/mo", SYNTH, [SYNTH_URL]).unlisted, ["$199"]);
  });
});

describe("page-scoped denials", () => {
  const held = (question: string, answer: string, table: PriceTable, urls: readonly string[]) =>
    checkPriceClaims(answer, table, urls, "en", { question }).contradictions.map((c) => [c.plan, c.reason]);
  it("holds a denial of a plan or period the table has", () => {
    assert.deepEqual(
      held("How much is the Audio + Video plan?", "Our Pricing page doesn't list the price for the Audio + Video plan.", BUZZSPROUT, BURL),
      [["Audio + Video", "unlisted"]],
    );
    assert.deepEqual(held("How much is the Starter plan per year?", "It does not state an annual price.", TRANSISTOR, TURL), [
      ["Starter", "unlisted"],
    ]);
    assert.deepEqual(
      held(
        "What does the Audio plan cost if I pay annually?",
        "It does not list the annual price for the Audio Podcast plan.",
        BUZZSPROUT,
        BURL,
      ),
      [["Audio", "unlisted"]],
    );
    assert.equal(
      held(
        "How much does Buzzsprout cost?",
        "The pricing page does not list the full prices for each paid plan or add-on.",
        BUZZSPROUT,
        BURL,
      ).length,
      1,
    );
  });
  it("leaves a denial of another thing than what the table has", () => {
    assert.deepEqual(
      held("How much is the SSO add-on?", "Our pricing page doesn't list a price for the SSO add-on.", TRANSISTOR, TURL),
      [],
    );
    assert.deepEqual(
      held("How much is a corporate licence for 10 Macs?", "The shop page doesn't list prices for corporate licences.", SYNTH, [SYNTH_URL]),
      [],
    );
  });
  it("leaves a denial of a period the table doesn't have", () => {
    const monthly = tableOf(synthRows.filter((r) => r.period === "month"));
    assert.deepEqual(held("How much is Studio per year?", "It does not state an annual price.", monthly, [SYNTH_URL]), []);
  });
});

describe("where a figure is", () => {
  const pricing = [
    { url: BURL[0] ?? "", title: "Pricing", facts: { prices: [{ figure: "$15", line: "paid plans starting at just $15/month" }] } },
  ];
  const blog = {
    figure: "$12",
    kind: "price" as const,
    page: { title: "Alternatives", url: "https://www.buzzsprout.com/blog/alternatives" },
  };
  it("holds a figure given as the pricing page's that a blog states, naming the blog", () => {
    const hold = pricingProvenanceHold(
      "Our Buzzsprout Pricing page says paid plans start at $12/month for 3 upload hours.",
      [blog],
      pricing,
    );
    assert.equal(hold?.clear, "decide");
    assert.match(hold?.text ?? "", /\$12 is on \/blog\/alternatives/);
  });
  it("leaves the pricing page's own figure, and a figure not attributed to it", () => {
    assert.equal(pricingProvenanceHold("Our Pricing page says paid plans start at $15/month.", [], pricing), undefined);
    assert.equal(pricingProvenanceHold("A blog post mentions $12.", [blog], pricing), undefined);
  });
  it("routes plan questions as price intent", () => {
    for (const q of ["What plans do you offer?", "Which tiers are there?", "Compare your paid plans"])
      assert.ok(questionIntents(q).includes("price"), q);
    assert.ok(!questionIntents("How do I plan a podcast?").includes("price"));
  });
});

describe("the unconfirmed check", () => {
  it("leaves out rows named after a badge, the page or a feature", () => {
    const u = "https://x.test/pricing";
    const row = (plan: string, value: number): PriceRow => ({ plan, amount: `$${value}`, value, url: u, line: "" });
    const t = provisionalTable(
      [row("Recommended", 49), row("Podcast hosting pricing", 19), row("Dynamic show notes", 99), row("Starter", 19)],
      [{ url: u }],
    );
    assert.deepEqual(
      t?.rows.map((r) => r.plan),
      ["Starter"],
    );
    assert.equal(provisionalTable([row("Recommended", 49)]), undefined);
  });
  it("flags names that may not be plans, and no others", () => {
    for (const n of [
      "Podcast hosting pricing",
      "Recommended",
      "Most Popular",
      "Dynamic show notes",
      "Subscription Add-ons",
      "Buy the Alfred 5 Powerpack",
    ])
      assert.ok(planNameDoubt(n), n);
    for (const n of [
      "Starter",
      "Enterprise 1",
      "Audio + Video",
      "Multi-Podcast",
      "Single License",
      "Mega Supporter",
      "Transcription (5 hrs per month)",
    ])
      assert.equal(planNameDoubt(n), undefined, n);
    assert.ok(planNameDoubt("Acme Hosting", "Acme Hosting | Plans"));
  });
});

describe("the confirm step", () => {
  const row = (plan: string, amount: string, value: number): PriceRow => ({
    plan,
    amount,
    value,
    currency: "USD",
    period: "month",
    url: "https://x.test/pricing",
    line: `${plan} ${amount}`,
  });
  const t = tableOf([row("Recommended", "$49", 49), row("Starter", "$19", 19)]);
  it("renames a row and marks it an add-on, with a new hash", () => {
    const e = editPriceRow(t, 0, { plan: " Professional ", amount: "$49", addOn: true });
    assert.ok(!("error" in e));
    assert.equal(e.plan, "Professional");
    assert.equal(e.table.rows[0]?.addOn, true);
    assert.equal(e.table.hash, priceRowsHash(e.table.rows));
    assert.notEqual(e.table.hash, t.hash);
    const off = editPriceRow(e.table, 0, { amount: "$49", addOn: false });
    assert.ok(!("error" in off) && !off.table.rows[0]?.addOn);
    assert.ok("error" in editPriceRow(t, 0, { plan: "  ", amount: "$49" }));
  });
  it("adds a row on the table's pricing page, in its currency", () => {
    const a = addPriceRow(t, { plan: "Transcription", amount: "5", period: "month", addOn: true });
    assert.ok(!("error" in a));
    const added = a.table.rows.at(-1);
    assert.equal(added?.value, 5);
    assert.equal(added?.currency, "USD");
    assert.equal(added?.url, "https://x.test/pricing");
    assert.equal(added?.addOn, true);
    assert.ok("error" in addPriceRow(t, { plan: "", amount: "$5" }));
    assert.ok("error" in addPriceRow(t, { plan: "X", amount: "ask us" }));
  });
  it("deletes a row, never the last", () => {
    const d = deletePriceRow(t, 0);
    assert.ok(!("error" in d) && d.table.rows.length === 1);
    assert.ok(!("error" in d) && "error" in deletePriceRow(d.table, 0));
  });
  it("says a pricing page with figures was found, not that none was, and asks for attention", () => {
    const unread = {
      rows: [],
      pages: ["https://x.test/shop/"],
      readAt: "",
      hash: "h",
      gap: { kind: "unread" as const, url: "https://x.test/shop/", figures: 2 },
    };
    const line = priceTableLine("/d", unread, null);
    assert.equal(line.state, "check");
    assert.match(line.detail ?? "", /\/shop\/.*no prices could be read/);
    assert.match(priceTableLine("/d", null, null).detail ?? "", /no pricing page was found/);
    assert.equal(priceTableIssue(unread, null, false), "unread");
    assert.match(PRICE_TABLE_ISSUES.unread, /no prices could be read/);
    assert.equal(priceTableIssue({ ...unread, gap: { kind: "quote", url: "" } }, null, true), undefined);
  });
  it("keeps a person's corrections while the page reads the same", () => {
    const e = editPriceRow(t, 0, { plan: "Professional", amount: "$49" });
    assert.ok(!("error" in e));
    const confirmation = { hash: e.table.hash, by: "Dana", at: "", edited: ["Professional"], readHash: t.hash };
    assert.equal(replacesTable(e.table, t, confirmation), false);
    const changed = tableOf([row("Recommended", "$59", 59), row("Starter", "$19", 19)]);
    assert.equal(replacesTable(e.table, changed, confirmation), true);
  });
});

describe("sealed-S2's verdicts", () => {
  const v = (question: string, answer: string, language = "en") => verdict({ answer, status: "success", question, language });
  it("doesn't take the cut-off date, or a past event, for an answer", () => {
    assert.equal(
      v("What upcoming events will Wärtsilä be at?", "No upcoming events are dated on or after 2 November 2026."),
      "may-not-answer",
    );
    assert.equal(
      v(
        "Welche Veranstaltungen stehen an?",
        "Derzeit ist keine kommende Veranstaltung mit einem Datum am oder nach dem 2. November 2026 angegeben.\n\nDie Seite nennt die EXPO REAL vom 5. bis 7. Oktober 2026; sie hat bereits stattgefunden.",
        "de",
      ),
      "may-not-answer",
    );
  });
  it("takes an honest quote answer as an answer", () => {
    assert.equal(
      v(
        "What does Acumatica cost per user?",
        "Acumatica does not charge per user. The page does not list a per-user price. You can schedule a no-obligation custom pricing review through our Acumatica Pricing page.",
      ),
      "partly",
    );
    assert.equal(v("How much is it?", "Our pricing page does not list a price."), "may-not-answer");
  });
  it("doesn't hold a demo answer to 'a trial or a demo'", () => {
    const answer = "You can request a demo through our Online page.\n\nThe page does not state whether a free trial is available.";
    assert.equal(v("Can I get a free trial or a demo?", answer), "partly");
  });
  it("doesn't say an answer giving a number says there's none", () => {
    const site = {
      contact: [
        {
          url: "https://x.test/contact",
          intent: "contact",
          facts: { contacts: [{ kind: "phone" as const, value: "510-344-1180", line: "510-344-1180" }] },
        },
      ],
    };
    assert.deepEqual(evidenceHolds("What's your phone number?", "Call 510-344-1180. Our pages do not mention a fax.", site).holds, []);
    assert.equal(evidenceHolds("What's your phone number?", "Our website does not list a phone number.", site).holds.length, 1);
  });
  it("holds a date told in the wrong tense", () => {
    const today = new Date("2026-11-02T10:00:00Z");
    assert.match(dateTenseHold("The International WorkBoat Show took place on 2–4 December 2026.", today)?.text ?? "", /still to come/);
    assert.match(
      dateTenseHold("Yes. We will be at the Content Creation Conference in Munich on October 27, 2026.", today)?.text ?? "",
      /is past/,
    );
    assert.equal(dateTenseHold("EXPO REAL took place on 5–7 October 2026. We will be at Interferry on 3 November 2026.", today), undefined);
    assert.equal(dateTenseHold("Die Messe hat am 3. Dezember 2026 stattgefunden.", today)?.clear, "decide");
  });
  it("strips Markdown from a quoted reply", () => {
    assert.equal(
      plainQuote("Visit our **Contact Mews** page and [Talk to Sales](https://x.test)."),
      "Visit our Contact Mews page and Talk to Sales.",
    );
  });
  it("carries a decision to another wording of the intent with the same substance", () => {
    const by = { by: "u1", name: "Dana", at: "2026-11-02T00:00:00Z", verified: true };
    const sources = [{ title: "Contact", url: "https://x.test/contact" }];
    const before: RunQuestion = {
      question: "How do I contact sales?",
      answer: "Use our Contact page.",
      sources,
      answered: true,
      intent: "contact",
      checks: ["short"],
      acknowledged: by,
    };
    const now: RunQuestion = {
      ...before,
      question: "How do I reach your sales team?",
      answer: "Our Contact page has the form.",
      acknowledged: undefined,
    };
    assert.equal(carriedFromRun([before], now).acknowledged?.name, "Dana");
    const other: RunQuestion = { ...now, sources: [{ title: "About", url: "https://x.test/about" }] };
    assert.equal(carriedFromRun([before], other).acknowledged, undefined);
    assert.equal(carriedFromRun([{ ...before, intent: "support" }], now).acknowledged, undefined);
  });
  it("says an, before a vowel", () => {
    const pages = [{ url: "https://acme.example/demo", title: "Book a demo", intent: "trial" }];
    assert.ok(intentQuestions(pages, "en", "Acumatica").some((q) => q.question === "Can I book an Acumatica demo?"));
    assert.ok(intentQuestions(pages, "en", "Bynder").some((q) => q.question === "Can I book a Bynder demo?"));
  });
});
