// The price table (round 6, item 1): each plan's price read from the pricing pages' facts, with its
// unit, period and qualifiers, and the page and line it came from. The facts below are the lines
// the sync stored (or, for ShareFile's second Enterprise price, now stores) for the real pages on
// 1 Nov 2026.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PageFacts, PriceTable } from "@launchpad/db";
import { checkPriceClaims, priceRowsHash } from "@launchpad/theme";
import { isPricingPage, joinFigures, placeDates, statedFacts } from "../src/lib/content-plan.ts";
import { buildPriceTable, needsConfirmingAgain, pagePriceRows, readPriceLine, replacesTable } from "../src/lib/price-table.ts";

const facts = (lines: [string, string][]): PageFacts => ({ prices: lines.map(([figure, line]) => ({ figure, line })) });

const KEMP = facts([
  ["$ 2,205", "Individual: $ 2,205 per year"],
  ["$ 4,500", "Standard: $ 4,500 Popular"],
  ["$ 5,300", "Enterprise: $ 5,300"],
  ["$ 6,200", "Enterprise Plus: $ 6,200"],
]);
const KEMP_DE = facts([
  ["$ 2,205", "Individual: $ 2,205 pro Jahr"],
  ["$ 4,500", "Standard: $ 4,500 Am beliebtesten"],
  ["$ 5,300", "Enterprise: $ 5,300"],
  ["$ 6,200", "Enterprise Plus: $ 6,200"],
]);
const CHEF = facts([
  ["$ 59", "Business: $ 59 per node, per year"],
  ["$ 189", "Enterprise: $ 189"],
]);
const SHAREFILE = facts([
  ["$ 18.15", "Advanced: $ 18.15"],
  ["$ 16.50", "Advanced: $ 16.50 Per user/month Minimum of 3 users"],
  ["$ 28.59", "Premium: $ 28.59"],
  ["$ 26.00", "Premium: $ 26.00"],
  ["$ 42.00", "Enterprise: $ 42.00"],
  ["$ 35.00", "Enterprise: $ 35.00"],
  ["$ 77.00", "Virtual Data Room: $ 77.00"],
  ["$ 69.30", "Virtual Data Room: $ 69.30 Per user/month Minimum of 5 users"],
  [
    "$1,000",
    "A Trusted Leader in Secure Document Workflow Solutions: “ShareFile was probably saving us well over $1,000 a month, which more than covers our subscription c…",
  ],
]);
const AGENTIC = facts([
  ["$ 700", "Starter: $ 700 monthly"],
  ["$ 1,925", "$ 1,925 Claim QuickStart Pro Offer"],
  ["$700", "$700/month*"],
  ["$0.008", "$0.008 (usage of first 10,000 tokens/month are included)"],
]);
const NOW = new Date("2026-11-01T12:00:00Z");
const row = (t: PriceTable, plan: string, value: number) => t.rows.find((r) => r.plan === plan && r.value === value);

describe("isPricingPage", () => {
  it("takes pricing pages by address, buying pages, and pages titled for their plans and prices", () => {
    assert.ok(isPricingPage("https://kemptechnologies.com/pricing", "LoadMaster Load Balancer Pricing Hub - Kemp"));
    assert.ok(isPricingPage("https://kemptechnologies.com/de/pricing", "LoadMaster Load Balancer Preise"));
    assert.ok(isPricingPage("https://www.sharefile.com/plans", "ShareFile Plans & Pricing - Get Free Trial"));
    assert.ok(isPricingPage("https://www.sharefile.com/plans/sharefile-premium", "ShareFile Premium"));
    assert.ok(isPricingPage("https://www.chef.io/how-to-buy", "Pricing & Plans - Buy Chef Products & Solutions"));
    assert.ok(isPricingPage("https://www.example.com/buy", null));
    assert.ok(isPricingPage("https://www.example.com/products/x", "Plans & Pricing"));
  });

  it("leaves out quote forms, FAQs, support and contact pages, and articles about prices", () => {
    assert.ok(!isPricingPage("https://kemptechnologies.com/quote-request", "Get a LoadMaster - Get a Quote to buy a Kemp Load Balancer"));
    assert.ok(!isPricingPage("https://www.chef.io/pricing/aws-systems-manager-faq", "AWS Systems Manager FAQ"));
    assert.ok(!isPricingPage("https://kemptechnologies.com/pricing/support-subscriptions", "LoadMaster Support Subscriptions"));
    assert.ok(
      !isPricingPage("https://www.sharefile.com/blogs/how-much-does-sharefile-cost", "How much does ShareFile cost? Pricing explained"),
    );
    assert.ok(!isPricingPage("https://www.example.com/about", "About us"));
  });
});

describe("readPriceLine", () => {
  it("reads the plan, amount, value, currency, unit and period", () => {
    assert.deepEqual(readPriceLine({ figure: "$ 59", line: "Business: $ 59 per node, per year" }, "https://www.chef.io/how-to-buy"), {
      plan: "Business",
      amount: "$ 59",
      value: 59,
      currency: "USD",
      unit: "per node",
      period: "year",
      url: "https://www.chef.io/how-to-buy",
      line: "Business: $ 59 per node, per year",
    });
    const vdr = readPriceLine({ figure: "$ 69.30", line: "Virtual Data Room: $ 69.30 Per user/month Minimum of 5 users" }, "u");
    assert.equal(vdr?.unit, "per user");
    assert.equal(vdr?.period, "month");
    assert.deepEqual(vdr?.qualifiers, ["minimum of 5 users"]);
    const euro = readPriceLine({ figure: "24,75 €", line: "Basis: ab 24,75 € pro Monat" }, "u");
    assert.equal(euro?.value, 24.75);
    assert.equal(euro?.currency, "EUR");
    assert.equal(euro?.period, "month");
    assert.deepEqual(euro?.qualifiers, ["from"]);
  });

  it("leaves badges and buttons out, and reads a starting price", () => {
    const standard = readPriceLine({ figure: "$ 4,500", line: "Standard: $ 4,500 Popular" }, "u");
    assert.equal(standard?.plan, "Standard");
    assert.equal(standard?.unit, undefined);
    const wug = readPriceLine({ figure: "$ 1,229", line: "Business: starting from $ 1,229 * for 50 devices, per year" }, "u");
    assert.equal(wug?.plan, "Business");
    assert.equal(wug?.period, "year");
    assert.deepEqual(wug?.qualifiers, ["from", "for 50 devices"]);
  });

  it("takes no row from a figure without its plan: a sentence, a customer's quote, a bare figure, a heading about prices", () => {
    assert.equal(readPriceLine({ figure: "$ 1,925", line: "$ 1,925 Claim QuickStart Pro Offer" }, "u"), undefined);
    assert.equal(
      readPriceLine(
        {
          figure: "$1,000",
          line: "A Trusted Leader in Secure Document Workflow Solutions: “ShareFile was probably saving us well over $1,000 a month",
        },
        "u",
      ),
      undefined,
    );
    assert.equal(readPriceLine({ figure: "$ 1,229", line: "starting from: $ 1,229 * for 50 devices, per year" }, "u"), undefined);
    assert.equal(readPriceLine({ figure: "$ 9", line: "Pricing: $ 9 a month" }, "u"), undefined);
  });
});

describe("the price table of the real cases", () => {
  it("Kemp: Standard $4,500, Enterprise $5,300, Enterprise Plus $6,200, from /pricing, once whatever the languages", () => {
    const t = buildPriceTable(
      [
        { url: "https://kemptechnologies.com/de/pricing", facts: KEMP_DE },
        { url: "https://kemptechnologies.com/quote-request", facts: {} },
        { url: "https://kemptechnologies.com/pricing", facts: KEMP },
      ],
      NOW,
      "en",
    );
    assert.deepEqual(
      t.rows.map((r) => [r.plan, r.value, r.url]),
      [
        ["Individual", 2205, "https://kemptechnologies.com/pricing"],
        ["Standard", 4500, "https://kemptechnologies.com/pricing"],
        ["Enterprise", 5300, "https://kemptechnologies.com/pricing"],
        ["Enterprise Plus", 6200, "https://kemptechnologies.com/pricing"],
      ],
    );
    assert.equal(row(t, "Standard", 4500)?.line, "Standard: $ 4,500 Popular");
    assert.equal(t.pages[0], "https://kemptechnologies.com/pricing");
    assert.equal(t.hash, priceRowsHash(t.rows));
  });

  it("chef.io: Business $59 and Enterprise $189, per node, per year", () => {
    const t = buildPriceTable([{ url: "https://www.chef.io/how-to-buy", facts: CHEF }], NOW);
    const enterprise = row(t, "Enterprise", 189);
    assert.equal(row(t, "Business", 59)?.unit, "per node");
    assert.equal(enterprise?.unit, "per node");
    assert.equal(enterprise?.period, "year");
    assert.match(enterprise?.qualifiers?.join(" ") ?? "", /as the page states for its other plans/);
  });

  it("sharefile.com/plans: Premium $26.00 per user/month, with $28.59 labelled as the other billing cycle", () => {
    const t = buildPriceTable([{ url: "https://www.sharefile.com/plans", facts: SHAREFILE }], NOW);
    const premium = row(t, "Premium", 26);
    const other = row(t, "Premium", 28.59);
    assert.equal(premium?.unit, "per user");
    assert.equal(premium?.period, "month");
    assert.match(premium?.qualifiers?.join(" ") ?? "", /billing toggle: \$ 28\.59 on the other billing cycle/);
    assert.match(other?.qualifiers?.join(" ") ?? "", /the other billing cycle to \$ 26\.00/);
    // No customer's quote becomes a plan.
    assert.ok(!t.rows.some((r) => r.value === 1000));
    assert.deepEqual([...new Set(t.rows.map((r) => r.plan))], ["Advanced", "Premium", "Enterprise", "Virtual Data Room"]);
  });

  it("agentic-rag: only the named plan; prices no plan names stay prices to check", () => {
    const rows = pagePriceRows("https://www.progress.com/agentic-rag/pricing", AGENTIC);
    assert.deepEqual(
      rows.map((r) => [r.plan, r.value, r.period]),
      [["Starter", 700, "month"]],
    );
  });

  it("is what the claim check pairs answers against: Kemp's mislabel is a contradiction", () => {
    const t = buildPriceTable([{ url: "https://kemptechnologies.com/pricing", facts: KEMP }], NOW);
    const claims = checkPriceClaims("Standard costs $6,200, Enterprise $4,500 and Enterprise Plus $5,300.", t, [
      "https://kemptechnologies.com/pricing",
    ]);
    assert.ok(claims.contradictions.some((c) => c.plan === "Standard" && c.table.value === 4500));
    const right = checkPriceClaims("Standard is $4,500, Enterprise $5,300 and Enterprise Plus $6,200.", t, [
      "https://kemptechnologies.com/pricing",
    ]);
    assert.deepEqual(right.contradictions, []);
  });
});

describe("the toggle's second price, as the sync now reads the page (extractor 6)", () => {
  it("takes the plan's name, so the table has both of ShareFile's Enterprise prices", () => {
    const markdown =
      "##### Enterprise\n\nControl that scales with collaboration\n\nWatch Video\n\n$ 42.00\n\n$ 35.00\n\n###### Get Enterprise if you:\n\n- Need secure collaboration";
    const text = joinFigures(markdown);
    assert.match(text, /Enterprise: \$ 42\.00\n\nEnterprise: \$ 35\.00/);
    const stated = statedFacts(
      { url: "https://www.sharefile.com/plans", text },
      "price",
      placeDates(text, { date: NOW, from: "sitemap" }),
      NOW,
    );
    const t = buildPriceTable([{ url: "https://www.sharefile.com/plans", facts: stated }], NOW);
    assert.deepEqual(
      t.rows.map((r) => [r.plan, r.value]),
      [
        ["Enterprise", 42],
        ["Enterprise", 35],
      ],
    );
  });

  it("doesn't name a figure that follows another plan's unnamed figure", () => {
    const text = joinFigures("Starter: $ 700 monthly\n\n$ 1,925\n\nClaim QuickStart Pro Offer");
    assert.doesNotMatch(text, /Starter: \$ 1,925/);
  });
});

describe("re-reads and the confirmation", () => {
  const t = buildPriceTable([{ url: "https://kemptechnologies.com/pricing", facts: KEMP }], NOW);

  it("replaces the stored table only when its rows change", () => {
    assert.equal(replacesTable(undefined, t, undefined), true);
    assert.equal(
      replacesTable(t, buildPriceTable([{ url: "https://kemptechnologies.com/pricing", facts: KEMP }], new Date()), undefined),
      false,
    );
    const changed = buildPriceTable(
      [{ url: "https://kemptechnologies.com/pricing", facts: facts([["$ 4,900", "Standard: $ 4,900"]]) }],
      NOW,
    );
    assert.equal(replacesTable(t, changed, { hash: t.hash, by: "Sam", at: NOW.toISOString() }), true);
    assert.equal(needsConfirmingAgain(changed, { hash: t.hash, by: "Sam", at: NOW.toISOString() }), true);
    assert.equal(needsConfirmingAgain(t, { hash: t.hash, by: "Sam", at: NOW.toISOString() }), false);
    assert.equal(needsConfirmingAgain(t, undefined), false);
  });

  it("keeps a row a person corrected while the other rows read the same", () => {
    const edited: PriceTable = { ...t, rows: t.rows.map((r) => (r.plan === "Individual" ? { ...r, unit: "per appliance" } : r)) };
    edited.hash = priceRowsHash(edited.rows);
    const confirmation = { hash: edited.hash, by: "Sam", at: NOW.toISOString(), edited: ["Individual"] };
    assert.equal(replacesTable(edited, t, confirmation), false);
    const moved = buildPriceTable(
      [
        {
          url: "https://kemptechnologies.com/pricing",
          facts: facts(
            (KEMP.prices ?? []).map((p): [string, string] => [p.figure.replace("6,200", "6,400"), p.line.replace("6,200", "6,400")]),
          ),
        },
      ],
      NOW,
    );
    assert.equal(replacesTable(edited, moved, confirmation), true);
  });
});
