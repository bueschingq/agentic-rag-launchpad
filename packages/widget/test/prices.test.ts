import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type PriceRow, type PriceTable, plainText, rowsAnswering, widgetStrings } from "@launchpad/theme";
import { parseMarkdown } from "../src/markdown.ts";
import { deniesListedPrice, priceReplacement, rowLine } from "../src/prices.ts";

// Kemp's pricing page (round 6).
const kemp: PriceTable = {
  rows: [
    {
      plan: "Standard",
      amount: "$4,500",
      value: 4500,
      currency: "USD",
      period: "year",
      url: "https://kemp.ax/pricing",
      line: "Standard $4,500 / year",
    },
    {
      plan: "Enterprise",
      amount: "$5,300",
      value: 5300,
      currency: "USD",
      period: "year",
      url: "https://kemp.ax/pricing",
      line: "Enterprise $5,300 / year",
    },
    {
      plan: "Enterprise Plus",
      amount: "$6,200",
      value: 6200,
      currency: "USD",
      period: "year",
      url: "https://kemp.ax/pricing",
      line: "Enterprise Plus $6,200 / year",
    },
  ],
  pages: ["https://kemp.ax/pricing"],
  readAt: "2026-11-01T00:00:00Z",
  hash: "abc",
};
const t = widgetStrings("en");
const pricing = [{ title: "Pricing | Kemp", href: "https://kemp.ax/pricing" }];

// Postmark's page as a proved table reads it (round 7): each plan per tier, and overage rates.
const row = (plan: string, value: number, extra: Partial<PriceRow> = {}): PriceRow => ({
  plan,
  amount: `$${value.toFixed(2)}`,
  value,
  currency: "USD",
  period: "month",
  url: "https://pm.example/pricing",
  line: `${plan} $${value}`,
  ...extra,
});
const tiers: PriceTable = {
  rows: [
    row("Basic", 15, { qualifiers: ["10,000 emails"] }),
    row("Basic", 55, { qualifiers: ["50,000 emails"] }),
    row("Pro", 16.5, { qualifiers: ["10,000 emails"] }),
    row("Pro", 1.3, { unit: "per 1,000 extra emails", period: undefined, addOn: true }),
    row("Dedicated IPs", 50, { unit: "per IP", addOn: true }),
  ],
  pages: ["https://pm.example/pricing"],
  readAt: "2026-11-02T00:00:00Z",
  hash: "tiers",
};
const flat: PriceTable = { ...tiers, rows: [row("Basic", 15), row("Pro", 16.5)] };
const toggled: PriceTable = {
  ...tiers,
  rows: [row("Pro", 37, { qualifiers: ["billed annually"] }), row("Pro", 52, { qualifiers: ["billed monthly"] })],
};

describe("rowsAnswering", () => {
  it("takes the plans the question names, the longest name first", () => {
    assert.deepEqual(
      rowsAnswering("How much is Enterprise Plus?", kemp).map((r) => r.plan),
      ["Enterprise Plus"],
    );
    assert.deepEqual(
      rowsAnswering("Standard or enterprise: what's the price?", kemp).map((r) => r.plan),
      ["Standard", "Enterprise"],
    );
  });

  it("takes every plan when the question names none", () => {
    assert.equal(rowsAnswering("What are your prices?", kemp).length, 3);
  });

  it("matches on the qualifier: a tier the table has, never another tier's row", () => {
    assert.deepEqual(
      rowsAnswering("How much is the Basic plan for 50,000 emails a month?", tiers).map((r) => r.value),
      [55],
    );
    assert.deepEqual(
      rowsAnswering("How much is Basic for 10k emails?", tiers).map((r) => r.value),
      [15],
    );
    assert.deepEqual(rowsAnswering("How much is the Basic plan for 300,000 emails?", tiers), []);
    assert.deepEqual(rowsAnswering("How much is the Basic plan for 50,000 emails a month?", flat), []);
  });

  it("matches on what's priced: overage isn't the plan's price", () => {
    assert.deepEqual(rowsAnswering("What do extra emails cost on Pro?", flat), []);
    assert.deepEqual(
      rowsAnswering("What do extra emails cost on Pro?", tiers).map((r) => r.value),
      [1.3],
    );
  });

  it("matches on the period: what paying monthly costs isn't the billed-annually rate", () => {
    assert.deepEqual(
      rowsAnswering("What's Pro cost if I pay monthly?", toggled).map((r) => r.value),
      [52],
    );
    assert.deepEqual(rowsAnswering("How much is Standard per month?", kemp), []);
    assert.deepEqual(
      rowsAnswering("Was kostet Standard pro Jahr?", kemp).map((r) => r.value),
      [4500],
    );
  });

  it("says nothing of a plan the table doesn't have, or of two prices it can't tell apart", () => {
    assert.deepEqual(rowsAnswering("How much is the Ultra plan?", kemp), []);
    const twins = { ...tiers, rows: [row("Pro", 37), row("Pro", 52)] };
    assert.deepEqual(rowsAnswering("How much is Pro per month?", twins), []);
    assert.deepEqual(rowsAnswering("How much is Pro for 10 users?", twins), []);
  });
});

describe("the replacement never states a figure that wasn't asked (round 7, Postmark)", () => {
  it("points to the pricing page, with no figure, when no row is what was asked", () => {
    const basic = priceReplacement(
      "How much is the Basic plan for 50,000 emails a month?",
      "Basic is $16.50 per month.",
      flat,
      [],
      t,
      "en",
    );
    assert.ok(basic?.pointer);
    assert.doesNotMatch(basic.answer, /\d/);
    assert.equal(basic.source.href, "https://pm.example/pricing");
    const extra = priceReplacement("What do extra emails cost on Pro?", "Extra emails on Pro are $15.00.", flat, [], t, "en");
    assert.ok(extra?.pointer);
    assert.doesNotMatch(extra.answer, /\d/);
  });

  it("leaves a correct answer on overage alone", () => {
    assert.equal(
      priceReplacement("What do extra emails cost on Pro?", "Extra emails on Pro cost $1.30 per 1,000.", flat, [], t, "en"),
      undefined,
    );
  });

  it("states the row when it is what was asked", () => {
    const r = priceReplacement("How much is the Basic plan for 50,000 emails?", "Basic is $16.50 per month.", tiers, [], t, "en");
    assert.equal(r?.pointer, undefined);
    assert.match(r?.answer ?? "", /\$55\.00 per month \(50,000 emails\)/);
  });

  it("never shows the reader's own notes", () => {
    const r = row("Portfolio", 23.5, {
      qualifiers: ["period as the page states for its other plans", "billing toggle: the other cycle", "billed annually"],
    });
    assert.equal(rowLine(r, t), "- **Portfolio**: $23.50 per month (billed annually)");
  });

  it("a wrong figure doesn't pass beside a right one", () => {
    const yearly = { ...tiers, rows: [row("Premium", 210, { period: "year" }), row("Premium", 20)] };
    const r = priceReplacement("How much is Premium?", "Premium is $200 per user per year, or $20 monthly.", yearly, [], t, "en");
    assert.ok(r);
  });

  it("with no table confirmed: another row's figure is pointed away from, a figure the rows lack isn't", () => {
    const shifted = priceReplacement(
      "Was kostet Kemp?",
      "Enterprise: $4,500. Enterprise Plus: $5,300.",
      undefined,
      [],
      widgetStrings("de"),
      "de",
      kemp,
    );
    assert.ok(shifted?.pointer);
    assert.equal(shifted.answer, widgetStrings("de").pricesOnPage);
    assert.equal(
      priceReplacement("Was kostet Kemp?", "Standard: $4,500. Cloud: $0.41 pro Stunde.", undefined, [], t, "de", kemp),
      undefined,
    );
    assert.equal(priceReplacement("How much is Standard?", "Standard costs $4,800 per year.", undefined, [], t, "en", kemp), undefined);
  });
});

describe("rowLine", () => {
  it("states the amount, unit, period and qualifiers", () => {
    const row = {
      plan: "Premium",
      amount: "$26.00",
      value: 26,
      unit: "per user",
      period: "month" as const,
      qualifiers: ["billed annually"],
    };
    assert.equal(
      rowLine({ ...row, url: "https://x.com/plans", line: "" }, t),
      "- **Premium**: $26.00 per user per month (billed annually)",
    );
    assert.equal(
      rowLine({ ...row, plan: "*Pro*", period: "once", qualifiers: [], unit: undefined, url: "", line: "" }, t),
      "- **Pro**: $26.00",
    );
  });
});

describe("priceReplacement", () => {
  it("replaces a reply that gives a plan another plan's price with the confirmed rows asked about", () => {
    const r = priceReplacement("How much is Standard?", "The Standard plan costs $6,200 per year.", kemp, pricing, t, "en");
    assert.ok(r);
    assert.equal(r.answer, "The prices on our pricing page:\n\n- **Standard**: $4,500 per year");
    assert.deepEqual(r.source, { title: "Pricing | Kemp", href: "https://kemp.ax/pricing" });
    // Rendered with no Markdown syntax left.
    assert.equal(plainText(parseMarkdown(r.answer)), "The prices on our pricing page:\nStandard: $4,500 per year");
  });

  it("replaces a blog's figure for a table plan, citing the pricing page by its address when it wasn't cited", () => {
    const r = priceReplacement(
      "What does Enterprise cost?",
      "Enterprise is $5,300 per year.",
      kemp,
      [{ title: "What does a load balancer cost?", href: "https://kemp.ax/blog/cost" }],
      t,
    );
    assert.ok(r);
    assert.deepEqual(r.source, { title: "kemp.ax/pricing", href: "https://kemp.ax/pricing" });
    assert.match(r.answer, /Enterprise\*\*: \$5,300 per year$/);
  });

  it("replaces a reply that says the prices aren't listed, with every plan", () => {
    const r = priceReplacement(
      "What are your prices?",
      "Our website does not list specific prices. Please contact sales.",
      kemp,
      pricing,
      t,
      "en",
    );
    assert.ok(r);
    assert.equal(r.answer.split("\n").length, 5);
  });

  it("leaves a reply that matches the table alone", () => {
    assert.equal(
      priceReplacement(
        "What are your prices?",
        "Standard is $4,500, Enterprise $5,300 and Enterprise Plus $6,200 a year.",
        kemp,
        pricing,
        t,
      ),
      undefined,
    );
    assert.equal(priceReplacement("How much is Standard?", "Standard costs $4,500 per year.", undefined, pricing, t), undefined);
  });

  it("speaks the visitor's language", () => {
    const r = priceReplacement("Was kostet Standard?", "Standard kostet 6.200 $ pro Jahr.", kemp, pricing, widgetStrings("de"), "de");
    assert.ok(r);
    assert.equal(r.answer, "Die Preise auf unserer Preisseite:\n\n- **Standard**: $4,500 pro Jahr");
  });
});

describe("the chat with the pricing page's own pairings (round 7)", () => {
  const url = "https://example-hosting.test/plans";
  const row = (plan: string, value: number, period: "month" | "year") => ({ plan, amount: `$${value}`, value, period, url, line: "" });
  const rows = [row("Solo 2", 12, "month"), row("Solo 2", 120, "year"), row("Team 10", 40, "month"), row("Team 10", 400, "year")];
  const facts: PriceTable = { rows, pages: [url], readAt: "2026-11-02T00:00:00Z", hash: "x" };
  const cited = [{ title: "Plans", href: url, passages: [] }] as never[];
  it("takes a denial of a listed price as no answer", () => {
    assert.equal(deniesListedPrice("How much is Team 10?", "Our Plans page doesn't list the price for Team 10.", facts, cited), true);
    assert.equal(deniesListedPrice("How much is Solo 2 per year?", "It does not state an annual price.", facts, cited), true);
  });
  it("leaves answers, and denials of other things", () => {
    assert.equal(deniesListedPrice("How much is Team 10?", "Team 10 is $40 a month.", facts, cited), false);
    assert.equal(
      deniesListedPrice("How much is the SSO add-on?", "Our Plans page doesn't list a price for the SSO add-on.", facts, cited),
      false,
    );
    assert.equal(deniesListedPrice("How much is Team 10?", "Our Plans page doesn't list it.", undefined, cited), false);
  });
  it("replaces a contradiction with the rows of the plan asked about, in both periods", () => {
    const t = widgetStrings("en");
    const r = priceReplacement("How much is Team 10?", "Team 10 is $12 a month.", facts, cited, t);
    assert.match(r?.answer ?? "", /Team 10/);
    assert.doesNotMatch(r?.answer ?? "", /Solo 2/);
    assert.equal(r?.source.href, url);
  });
});
