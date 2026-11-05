// Build 8, items 1–3: price answers read correctly, "Confirmed" tells the truth, a table change counts
// as a change. Fixtures only: Bitwarden's and ShareFile's rows as round 7 saw them, no asks.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PriceRow, PriceTable, PriceTableConfirmation, SignOff } from "@launchpad/db";
import type { AskResult } from "@launchpad/par-client";
import {
  plainPriceQuestion,
  priceReplacement,
  priceRowsHash,
  rowLine,
  rowsAnswering,
  rowTerms,
  shownQualifiers,
  widgetStrings,
} from "@launchpad/theme";
import { changeAlert, VISITOR_CHANGES } from "../../worker/src/jobs/alerts.ts";
import { tableLines } from "../src/lib/judge.ts";
import { changedTable, pageChanges, pagePriceRows, priceDoubts, replacesTable } from "../src/lib/price-table.ts";
import { pricesParagraph } from "../src/lib/prompt.ts";
import {
  addPriceRow,
  deletePriceRow,
  editPriceRow,
  priceTableChanged,
  priceTableState,
  signedPriceHash,
  signOffState,
} from "../src/lib/review.ts";
import {
  asksPrice,
  judgeAnswer,
  openHold,
  PRICE_REASKS,
  priceQuestionsToAsk,
  priceReask,
  type RunQuestion,
  withJudgement,
} from "../src/lib/validation-rules.ts";

const PRICING = "https://bitwarden.example/pricing/";
const row = (plan: string, amount: string, value: number, extra: Partial<PriceRow> = {}): PriceRow => ({
  plan,
  amount,
  value,
  currency: "USD",
  url: PRICING,
  line: `${plan} ${amount}`,
  ...extra,
});
const tableOf = (rows: PriceRow[], more: Partial<PriceTable> = {}): PriceTable => ({
  rows,
  pages: [PRICING],
  readAt: "2026-11-02T00:00:00Z",
  hash: priceRowsHash(rows),
  ...more,
});
const t = widgetStrings("en");

// Round 7's fresh site: the card read "per month, monthly", the chat "per month per month".
const bitwarden = tableOf([
  row("Premium", "$ 1.65", 1.65, { unit: "per month", period: "month", qualifiers: ["Billed annually"] }),
  row("Families", "$ 3.99", 3.99, { unit: "per month", period: "month", qualifiers: ["Billed annually", "per month"] }),
  row("Teams", "$ 4", 4, { unit: "per user per month", period: "month" }),
]);
// Its plans each with two monthly prices nothing tells apart.
const sharefile = tableOf([
  row("Standard", "$ 16.00", 16, { period: "month" }),
  row("Standard", "$ 18.00", 18, { period: "month" }),
  row("Premium", "$ 26.00", 26, { period: "month" }),
  row("Premium", "$ 28.59", 28.59, { period: "month" }),
]);

describe("item 1: a unit and period that say the same thing print once", () => {
  it("in the chat's replacement, in every language's words", () => {
    assert.equal(rowLine(bitwarden.rows[0] as PriceRow, t), "- **Premium**: $ 1.65 per month (Billed annually)");
    assert.equal(rowLine(bitwarden.rows[1] as PriceRow, t), "- **Families**: $ 3.99 per month (Billed annually)");
    assert.equal(rowLine(bitwarden.rows[2] as PriceRow, t), "- **Teams**: $ 4 per user per month");
    assert.equal(rowLine(row("Pro", "$9", 9, { unit: "pro Monat", period: "month" }), widgetStrings("de")), "- **Pro**: $9 pro Monat");
    assert.equal(rowLine(row("Pro", "$9/mo", 9, { period: "month" }), t), "- **Pro**: $9/mo");
  });

  it("in the list the model reads, in the judge's, and on the card", () => {
    for (const text of [pricesParagraph(bitwarden.rows), tableLines(bitwarden).join("\n")]) {
      assert.doesNotMatch(text, /per month per month/);
      assert.match(text, /Premium: \$ 1\.65 per month \(Billed annually\)/);
    }
    assert.equal(rowTerms(bitwarden.rows[0] as PriceRow, { perMonth: "monthly", perYear: "yearly" }), "per month");
  });

  it("keeps a period the unit doesn't state, and what isn't a repeat", () => {
    assert.equal(rowLine(row("Basic", "$15", 15, { unit: "per user", period: "year" }), t), "- **Basic**: $15 per user per year");
    assert.equal(rowLine(row("Basic", "$15", 15, { period: "once" }), t), "- **Basic**: $15");
    assert.deepEqual(shownQualifiers(row("B", "$1", 1, { unit: "per month", qualifiers: ["50,000 emails", "per month"] })), [
      "50,000 emails",
    ]);
  });
});

describe("item 1: which rows a question gets", () => {
  it("a plain how-much gets every row, two unlabelled prices side by side", () => {
    assert.equal(rowsAnswering("How much does Bitwarden cost?", sharefile).length, 4);
    assert.equal(rowsAnswering("What are your prices?", sharefile).length, 4);
    assert.deepEqual(
      rowsAnswering("How much is Premium?", sharefile).map((r) => r.value),
      [26, 28.59],
    );
    for (const q of [
      "Was kostet das?",
      "¿Cuánto cuesta?",
      "Quels sont vos tarifs ?",
      "Hoeveel kost het?",
      "Quanto custa?",
      "Quanto costa?",
    ])
      assert.equal(rowsAnswering(q, sharefile).length, 4, q);
  });

  it("a quantity, an extra or a billing period gets the exact row or nothing", () => {
    assert.deepEqual(rowsAnswering("How much is Premium per year?", sharefile), []);
    assert.deepEqual(rowsAnswering("How much is Premium per month?", sharefile), []);
    assert.deepEqual(rowsAnswering("How much is Premium for 25 users?", sharefile), []);
    assert.deepEqual(rowsAnswering("What does extra storage cost?", sharefile), []);
    assert.deepEqual(rowsAnswering("What does a 2TB plan cost?", sharefile), []);
  });

  it("the question validation asks of every site gets figures, not the link (ShareFile, 2 of 2)", () => {
    const denial = "Our plans page lists the plans, but it does not state the Enterprise price.";
    const r = priceReplacement("How much does Bitwarden cost?", denial, sharefile, [], t, "en");
    assert.ok(r);
    assert.equal(r.pointer, undefined);
    assert.match(r.answer, /\$ 28\.59/);
    assert.match(r.answer, /\$ 16\.00/);
    assert.ok(plainPriceQuestion("How much does Bitwarden cost?", sharefile));
    assert.ok(!plainPriceQuestion("How much is Premium for 25 users?", sharefile));
    assert.ok(!plainPriceQuestion("How much is Premium per year?", sharefile));
  });

  it("a multi-period table still answers exactly", () => {
    const toggled = tableOf([
      row("Pro", "$37", 37, { period: "month", qualifiers: ["billed annually"] }),
      row("Pro", "$52", 52, { period: "month", qualifiers: ["billed monthly"] }),
    ]);
    assert.deepEqual(
      rowsAnswering("What's Pro cost if I pay monthly?", toggled).map((r) => r.value),
      [52],
    );
    assert.equal(rowsAnswering("How much is Pro?", toggled).length, 2);
  });

  it("two unlabelled prices are flagged on the card, read by the model or the patterns", () => {
    const doubts = priceDoubts(sharefile.rows);
    assert.equal(doubts.filter((r) => /nothing says which applies/.test(r.doubt ?? "")).length, 4);
    const read = pagePriceRows(PRICING, {
      prices: [
        { figure: "$28.59", line: "Premium: $28.59" },
        { figure: "$26.00", line: "Premium: $26.00 per user per month" },
      ],
    });
    assert.equal(priceDoubts(read).filter((r) => r.doubt).length, 2);
    // Labelled as billed differently, they aren't flagged.
    const labelled = [
      row("Pro", "$37", 37, { qualifiers: ["billed annually"] }),
      row("Pro", "$52", 52, { qualifiers: ["billed monthly"] }),
    ];
    assert.equal(priceDoubts(labelled).filter((r) => r.doubt).length, 0);
  });
});

describe("item 1: Bitwarden's false hold", () => {
  const answer = "Premium: $1.65 per month, billed annually at $19.80\nFamilies: $3.99 per month, billed annually at $47.88";
  const result = (text: string) =>
    ({ answer: text, status: "success", citations: {}, retrieval_results: { resources: {} } }) as unknown as AskResult;
  const judge = { verdict: "contradicts" as const, reason: "It mislabels annual Premium price $19.80 as per month" };
  const q = { question: "How much does Bitwarden cost?", own: false };
  it("goes once the table is confirmed, and with only the page's rows", () => {
    for (const context of [{ priceTable: bitwarden }, { pricingFacts: bitwarden }]) {
      const judged = judgeAnswer(q, result(answer), () => false, undefined, context);
      const after = withJudgement(judged, judge);
      assert.equal(openHold(after), false, JSON.stringify(after.holds));
    }
  });
  it("stays for a figure on another plan's row", () => {
    const wrong = judgeAnswer(q, result("Premium is $3.99 per month."), () => false, undefined, { pricingFacts: bitwarden });
    assert.equal(openHold(withJudgement(wrong, judge)), true);
  });
});

const confirmationOf = (table: PriceTable, more: Partial<PriceTableConfirmation> = {}): PriceTableConfirmation => ({
  hash: table.hash,
  by: "Dana",
  at: "2026-11-02T10:00:00Z",
  ...more,
});
const fine = (edited: { table: PriceTable } | { error: string }) => {
  assert.ok(!("error" in edited));
  return edited.table;
};

describe("item 2: a re-read compares by meaning (the UX designer's second check)", () => {
  const table = tableOf([
    row("Starter", "$75", 75),
    row("Pro", "$1,925", 1925, { period: "year" }),
    row("Knowledge Boxes", "$0.008", 0.008),
  ]);

  it("an unchanged page leaves it Confirmed: wording, lines and qualifiers aren't a change", () => {
    const again = tableOf([
      row("Starter plan", "$ 75", 75, { line: "another line" }),
      row("Pro", "$1,925", 1925, { period: "year", qualifiers: ["billed annually"] }),
      row("Knowledge Boxes", "$0.008", 0.008, { unit: "per token" }),
    ]);
    assert.notEqual(again.hash, table.hash);
    assert.deepEqual(pageChanges(table, again), []);
    assert.equal(replacesTable(table, again, confirmationOf(table)), false);
  });

  it('a hand-made name stands, and no doubt comes back ("Knowledge Boxes" read as "extra KB")', () => {
    const read = tableOf([row("Starter", "$75", 75), row("Pro", "$1,925", 1925, { period: "year" }), row("extra KB", "$0.008", 0.008)]);
    const named = fine(editPriceRow(read, 2, { amount: "$0.008", plan: "Knowledge Boxes" }));
    assert.equal(named.rows[2]?.readAs?.plan, "extra KB");
    const c = confirmationOf(named);
    assert.equal(replacesTable(named, read, c), false);
    assert.deepEqual(pageChanges(named, read, c), []);
  });

  it("a correction from before readAs, known only by name, stands too", () => {
    const old = tableOf([row("Starter", "$75", 75), row("Knowledge Boxes", "$0.008", 0.008)]);
    const read = tableOf([row("Starter", "$75", 75), row("extra KB", "$0.008", 0.008)]);
    assert.equal(replacesTable(old, read, confirmationOf(old, { edited: ["Knowledge Boxes"] })), false);
  });

  it("a figure a person corrected stands while the page reads as it did", () => {
    const read = tableOf([row("Starter", "$75", 75), row("Pro", "$700", 700)]);
    const fixed = fine(editPriceRow(read, 1, { amount: "$750" }));
    assert.equal(replacesTable(fixed, read, confirmationOf(fixed)), false);
  });

  it("rows a person added or removed aren't a change", () => {
    const read = tableOf([row("Starter", "$75", 75), row("Pro", "$700", 700), row("Most popular", "$700", 700)]);
    const removed = fine(deletePriceRow(read, 2));
    const added = fine(addPriceRow(removed, { plan: "Free", amount: "$0" }));
    assert.equal(replacesTable(added, read, confirmationOf(added)), false);
    const merged = changedTable(added, tableOf([row("Starter", "$80", 80), row("Pro", "$700", 700), row("Most popular", "$700", 700)]));
    assert.deepEqual(
      merged.rows.map((r) => r.plan),
      ["Starter", "Pro", "Free"],
    );
  });

  it("only a changed figure or plan re-opens it, naming the difference", () => {
    const moved = tableOf([
      row("Starter", "$75", 75),
      row("Pro", "$1,995", 1995, { period: "year" }),
      row("Knowledge Boxes", "$0.008", 0.008),
    ]);
    const c = confirmationOf(table);
    assert.equal(replacesTable(table, moved, c), true);
    assert.deepEqual(pageChanges(table, moved, c), ["Pro was $1,925 per year, now $1,995 per year"]);
    const next = changedTable(table, moved, c);
    assert.deepEqual(next.changes, ["Pro was $1,925 per year, now $1,995 per year"]);
    assert.equal(priceTableState(next, c), "changed");
    const plans = tableOf([row("Starter", "$75", 75), row("Pro", "$1,925", 1925, { period: "year" }), row("Team", "$20", 20)]);
    assert.deepEqual(pageChanges(table, plans, c), [
      "Knowledge Boxes ($0.008) is no longer on the pricing page",
      "Team ($20) is new on the pricing page",
    ]);
  });

  it("a changed period or volume re-opens it: a label can carry the meaning", () => {
    const yearly = tableOf([row("Pro", "$10", 10, { period: "month" })]);
    const flipped = tableOf([row("Pro", "$10", 10, { period: "year" })]);
    assert.deepEqual(pageChanges(yearly, flipped), ["Pro was $10 per month, now $10 per year"]);
    const tier = tableOf([row("Basic", "$15", 15, { qualifiers: ["10,000 emails"] })]);
    const moved = tableOf([row("Basic", "$15", 15, { qualifiers: ["20,000 emails"] })]);
    assert.equal(pageChanges(tier, moved).length, 1);
  });

  it("corrections stay on the rows that didn't change", () => {
    const read = tableOf([row("Starter", "$75", 75), row("extra KB", "$0.008", 0.008)]);
    const named = fine(editPriceRow(read, 1, { amount: "$0.008", plan: "Knowledge Boxes" }));
    const moved = tableOf([row("Starter", "$80", 80), row("extra KB", "$0.008", 0.008)]);
    const next = changedTable(named, moved, confirmationOf(named));
    assert.deepEqual(
      next.rows.map((r) => r.plan),
      ["Starter", "Knowledge Boxes"],
    );
    assert.deepEqual(next.changes, ["Starter was $75, now $80"]);
  });

  it("a reading the model couldn't do is no evidence", () => {
    const patterns = tableOf([row("Badly read", "$1", 1)], { modelError: "no reply within 45 s", builtBy: "patterns" });
    assert.equal(replacesTable(table, patterns, confirmationOf(table)), false);
  });

  it("a table nobody has looked at takes any new reading", () => {
    const again = tableOf([row("Starter", "$75", 75, { unit: "per user" })]);
    assert.equal(replacesTable(tableOf([row("Starter", "$75", 75)]), again, null), true);
  });
});

describe("item 2: saving a row isn't confirming (the UX designer's first check)", () => {
  it("corrections leave the hash moved, so nothing reads as confirmed", () => {
    const table = tableOf([row("A", "$1", 1, { doubt: "x" }), row("B", "$2", 2, { doubt: "y" })]);
    const fixed = fine(editPriceRow(table, 0, { amount: "$1" }));
    assert.equal(fixed.rows[0]?.doubt, undefined);
    assert.equal(fixed.rows[1]?.doubt, "y");
    // The action clears the confirmation (price-table/actions.ts): the state with none.
    assert.equal(priceTableState(fixed, null), "unconfirmed");
  });
});

const signOff = (more: Partial<SignOff> = {}): SignOff => ({
  by: "u1",
  name: "Dana",
  at: "2026-11-02T12:00:00Z",
  verified: true,
  settingsHash: "s",
  ...more,
});

describe("item 3: a table change counts as a change", () => {
  const table = tableOf([row("Pro", "$10", 10)]);
  const c = confirmationOf(table);
  const d = { priceTable: table, priceTableConfirmation: c };

  it("a sign-off records the confirmed table; any other table is a change; changed back drops out", () => {
    const signed = signOff({ priceTableHash: signedPriceHash(d) });
    assert.equal(signed.priceTableHash, table.hash);
    assert.equal(priceTableChanged(signed, d), false);
    assert.equal(signOffState(signed, "s", null, null, priceTableChanged(signed, d)).state, "signed");
    const edited = fine(editPriceRow(table, 0, { amount: "$12" }));
    const now = { priceTable: edited, priceTableConfirmation: null };
    assert.equal(priceTableChanged(signed, now), true);
    const state = signOffState(signed, "s", null, null, priceTableChanged(signed, now));
    assert.equal(state.state, "changed");
    assert.ok(state.state === "changed" && state.priceChanged);
    assert.equal(priceTableChanged(signed, { priceTable: edited, priceTableConfirmation: confirmationOf(edited) }), true);
    assert.equal(priceTableChanged(signed, d), false);
  });

  it("a sign-off from before: a later confirmation or a mismatch is a change", () => {
    assert.equal(priceTableChanged(signOff(), d), false);
    assert.equal(priceTableChanged(signOff(), { ...d, priceTableConfirmation: { ...c, at: "2026-11-03T00:00:00Z" } }), true);
    assert.equal(priceTableChanged(signOff(), { ...d, priceTableConfirmation: { ...c, hash: "old" } }), true);
    assert.equal(priceTableChanged(signOff(), { priceTable: null, priceTableConfirmation: null }), false);
    assert.equal(priceTableChanged(null, d), false);
  });

  const alert = (action: string, detail: unknown, who: string | null = "Dana") =>
    changeAlert({ id: 7, action, detail, who, tenantName: "Crayola", name: "Main site" }, "http://x/review");

  it("the channel hears who changed what, like the chat's name", () => {
    for (const a of ["confirm", "edit", "add", "delete", "read"]) assert.ok(VISITOR_CHANGES.includes(`deployment.price-table.${a}`));
    const edit = alert("deployment.price-table.edit", { plan: "Pro", before: [1], after: [2] });
    assert.match(edit?.message.subject ?? "", /Crayola › Main site: Dana corrected Pro in the price table/);
    assert.match(edit?.message.text ?? "", /sign off again/);
    assert.ok(alert("deployment.price-table.confirm", {}));
  });

  it("a re-read alerts only when it re-opened a confirmed table, naming the difference", () => {
    assert.equal(alert("deployment.price-table.read", { rows: 3 }, null), undefined);
    const read = alert("deployment.price-table.read", { confirmAgain: true, changes: ["Pro was $10, now $12"] }, null);
    assert.match(read?.message.subject ?? "", /the pricing page changed/);
    assert.match(read?.message.text ?? "", /Pro was \$10, now \$12/);
    assert.match(read?.message.text ?? "", /sign off again/);
  });

  const asked = (question: string, more: Partial<RunQuestion> = {}): RunQuestion => ({
    question,
    answer: "x",
    sources: [],
    answered: true,
    ...more,
  });

  it("Confirm asks at most 4 price questions: the intent's, the live starters', then others", () => {
    const questions = [
      asked("How do I contact you?", { intent: "contact" }),
      asked("How much is a licence?"),
      asked("What's the price of Pro?"),
      asked("How much is it?", { starter: true }),
      asked("What does it cost?", { intent: "price" }),
      asked("How much is Team?"),
      asked("How much is Enterprise?"),
      asked("Where are you based?"),
    ];
    const picked = priceQuestionsToAsk(questions, ["how much is it?"]);
    assert.equal(picked.length, PRICE_REASKS);
    assert.equal(PRICE_REASKS, 4);
    assert.equal(picked[0]?.question, "What does it cost?");
    assert.ok(picked.every(asksPrice));
  });

  const result = (text: string) =>
    ({ answer: text, status: "success", citations: {}, retrieval_results: { resources: {} } }) as unknown as AskResult;
  const twoPlans = tableOf([row("Pro", "$10", 10), row("Team", "$20", 20)]);

  it("the run shows a replacement in those words: the table's rows", () => {
    const q = judgeAnswer({ question: "How much is it?", own: false }, result("Pro is $20 per month."), () => false, undefined, {
      priceTable: twoPlans,
    });
    assert.match(q.visitorGets?.answer ?? "", /The prices on our pricing page/);
    assert.deepEqual(priceReask(q).replaced, "rows");
    assert.equal(priceReask(q).held, true);
  });

  it("a plain price question getting only the link is held; a quantity's link isn't failed for it", () => {
    const facts = judgeAnswer({ question: "How much is it?", own: false }, result("Pro is $20 per month."), () => false, undefined, {
      pricingFacts: twoPlans,
    });
    assert.equal(facts.visitorGets?.pointer, true);
    assert.ok(facts.holds?.some((h) => /Visitors get only/.test(h.text)));
    assert.deepEqual(priceReask(facts).replaced, "link");
    const quantity = judgeAnswer(
      { question: "How much is Pro for 25 users?", own: false },
      result("Pro is $20 per month."),
      () => false,
      undefined,
      { priceTable: twoPlans },
    );
    assert.equal(quantity.visitorGets?.pointer, true);
    assert.ok(!quantity.holds?.some((h) => /Visitors get only/.test(h.text)));
  });

  it("an answer the table agrees with shows no replacement", () => {
    const q = judgeAnswer({ question: "How much is Pro?", own: false }, result("Pro is $10 per month."), () => false, undefined, {
      priceTable: twoPlans,
    });
    assert.equal(q.visitorGets, undefined);
    assert.equal(q.tableMatched, true);
  });
});
