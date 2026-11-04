import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkPriceClaims, confirmedTable, contradictionText, type PriceTable, priceRowsHash } from "../src/index.ts";

// Kemp's pricing page, round 6 (Content: "Individual: $2,205 per year · Standard: $4,500 ·
// Enterprise: $5,300 · Enterprise Plus: $6,200"), and ShareFile's toggle (Premium $26.00 a month).
const PRICING = "https://kemptechnologies.com/pricing";
const row = (plan: string, amount: string, value: number, period?: "month" | "year") => ({
  plan,
  amount,
  value,
  currency: "USD",
  ...(period && { period }),
  url: PRICING,
  line: `${plan}: ${amount}`,
});
const rows = [
  row("Individual", "$2,205", 2205, "year"),
  row("Standard", "$4,500", 4500),
  row("Enterprise", "$5,300", 5300),
  row("Enterprise Plus", "$6,200", 6200),
];
const KEMP: PriceTable = { rows, pages: [PRICING], readAt: "2026-11-01T00:00:00Z", hash: priceRowsHash(rows) };
const SHAREFILE: PriceTable = {
  rows: [
    {
      plan: "Premium",
      amount: "$26.00",
      value: 26,
      currency: "USD",
      unit: "per user",
      period: "month",
      url: "https://sharefile.com/plans",
      line: "Premium $26.00 per user/month",
    },
  ],
  pages: ["https://sharefile.com/plans"],
  readAt: "2026-11-01T00:00:00Z",
  hash: "x",
};

describe("the price table check", () => {
  it("passes plan prices that match the table, in any order of words", () => {
    for (const answer of [
      "Standard is $4,500, Enterprise is $5,300 and Enterprise Plus is $6,200.",
      "Individual: $2,205 per year · Standard: $4,500 · Enterprise: $5,300 · Enterprise Plus: $6,200",
      "You pay $4,500 for Standard.",
      "- Standard: $4,500\n- Enterprise Plus: $6,200",
    ]) {
      const c = checkPriceClaims(answer, KEMP, [PRICING]);
      assert.deepEqual(c.contradictions, [], answer);
      assert.deepEqual(c.unlisted, [], answer);
    }
  });

  it("holds a plan given another plan's amount, naming the pairing", () => {
    const c = checkPriceClaims("Standard costs $6,200 per year.", KEMP, [PRICING]);
    assert.equal(c.contradictions.length, 1);
    assert.equal(c.contradictions[0]?.plan, "Standard");
    assert.equal(c.contradictions[0]?.reason, "amount");
    assert.equal(
      contradictionText(c.contradictions[0] ?? assert.fail("no contradiction"), [PRICING]),
      "Standard is $4,500 on /pricing; this answer gives $6,200 for Standard",
    );
  });

  it("doesn't take Enterprise Plus's price for Enterprise", () => {
    assert.deepEqual(checkPriceClaims("Enterprise Plus is $6,200.", KEMP, [PRICING]).contradictions, []);
    assert.equal(checkPriceClaims("Enterprise is $6,200.", KEMP, [PRICING]).contradictions[0]?.plan, "Enterprise");
  });

  it("reads local formats: 1 250 €, 4.500 $ and 26,00", () => {
    assert.deepEqual(checkPriceClaims("Standard kostet 4.500 $ pro Jahr.", KEMP, [PRICING], "de").contradictions, []);
    assert.deepEqual(checkPriceClaims("Standard: 4 500 $", KEMP, [PRICING]).contradictions, []);
    assert.deepEqual(
      checkPriceClaims("Premium cuesta 26,00 US$ al mes.", SHAREFILE, ["https://sharefile.com/plans"], "es").contradictions,
      [],
    );
    assert.equal(checkPriceClaims("Standard: 4 550 $", KEMP, [PRICING]).contradictions.length, 1);
  });

  it("holds a blog's range given for a plan, as one claim (ShareFile, round 6)", () => {
    const blog = "https://sharefile.com/blogs/what-does-sharefile-cost";
    const c = checkPriceClaims("Premium runs about $600–$700 per user per year.", SHAREFILE, [blog]);
    assert.equal(c.contradictions[0]?.said, "$600–$700");
    assert.match(
      contradictionText(c.contradictions[0] ?? assert.fail("no contradiction"), [blog]),
      /^Premium is \$26\.00 per user per month on \/plans; this answer gives \$600–\$700 for Premium from \/blogs\//,
    );
  });

  it("takes a year's price for a monthly plan as the same price", () => {
    assert.deepEqual(checkPriceClaims("Premium is $312 per user per year.", SHAREFILE, ["https://sharefile.com/plans"]).contradictions, []);
  });

  it("holds a table plan's right amount cited only from another page", () => {
    const c = checkPriceClaims("Standard is $4,500.", KEMP, ["https://kemptechnologies.com/blog/load-balancer-costs"]);
    assert.equal(c.contradictions[0]?.reason, "source");
    // Uncited (no citations to go by): not judged on its source.
    assert.deepEqual(checkPriceClaims("Standard is $4,500.", KEMP, []).contradictions, []);
  });

  it("holds 'not listed' about a plan the table has, and a denial of every price", () => {
    const one = checkPriceClaims("Our website does not list a price for Enterprise.", KEMP, [PRICING]);
    assert.equal(one.contradictions[0]?.reason, "unlisted");
    assert.equal(one.contradictions[0]?.plan, "Enterprise");
    const all = checkPriceClaims("Pricing is provided by quote; no specific prices are listed.", KEMP, [PRICING]);
    assert.equal(all.contradictions[0]?.reason, "unlisted");
  });

  it("leaves an amount the table doesn't have as a price to check", () => {
    const c = checkPriceClaims("Standard is $4,500, plus a $500 onboarding fee.", KEMP, [PRICING]);
    assert.deepEqual(c.contradictions, []);
    assert.deepEqual(c.unlisted, ["$500"]);
    assert.deepEqual(checkPriceClaims("Support add-ons start at $99.", KEMP, [PRICING]).unlisted, ["$99"]);
  });

  it("gives the same answer for the same text and table, every time", () => {
    const text = "Standard is $6,200 and Enterprise is $5,300.";
    const runs = Array.from({ length: 5 }, () => JSON.stringify(checkPriceClaims(text, KEMP, [PRICING])));
    assert.equal(new Set(runs).size, 1);
  });

  it("uses the table only while its confirmation is for these rows", () => {
    const confirmation = { hash: KEMP.hash, by: "Quinton", at: "2026-11-01T00:00:00Z" };
    assert.equal(confirmedTable({ priceTable: KEMP, priceTableConfirmation: confirmation }), KEMP);
    assert.equal(confirmedTable({ priceTable: { ...KEMP, hash: "changed" }, priceTableConfirmation: confirmation }), undefined);
    assert.equal(confirmedTable({ priceTable: KEMP, priceTableConfirmation: null }), undefined);
    assert.equal(confirmedTable({ priceTable: { ...KEMP, rows: [] }, priceTableConfirmation: confirmation }), undefined);
    assert.equal(priceRowsHash(rows), priceRowsHash([...rows]));
    assert.notEqual(priceRowsHash(rows), priceRowsHash([{ ...(rows[0] ?? assert.fail()), value: 2206 }, ...rows.slice(1)]));
  });

  it("checks nothing without a table", () => {
    assert.deepEqual(checkPriceClaims("Standard is $6,200.", undefined, []), { contradictions: [], unlisted: [] });
  });
});
