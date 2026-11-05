// The price table from what three untuned sites' pricing pages serve (round 7 release check): the
// text below is what the sniffer's extractor 3 makes of each page (fixtures/pricing-pages/*.md,
// from apps/sniffer/e2e/fixtures/pricing/*.html, fetched once on 1 Nov 2026; buzzsprout's with its
// monthly view added, as the sniffer loads a billing toggle that reloads the page). Each shape also
// has a synthetic case, so the rules hold for other sites.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import type { PageFacts, PriceTable } from "@launchpad/db";
import { checkPriceClaims } from "@launchpad/theme";
import { isPricingPage, joinFigures, placeDates, statedFacts } from "../src/lib/content-plan.ts";
import { buildPriceTable, pagePriceRows, readPriceLine } from "../src/lib/price-table.ts";

const NOW = new Date("2026-11-01T12:00:00Z");
const markdown = (name: string) => readFileSync(new URL(`fixtures/pricing-pages/${name}.md`, import.meta.url), "utf8");
const factsOf = (url: string, text: string): PageFacts => {
  const joined = joinFigures(text);
  return statedFacts({ url, text: joined }, "price", placeDates(joined, { date: NOW, from: "sitemap" }), NOW);
};
const tableOf = (url: string, text: string): PriceTable => buildPriceTable([{ url, facts: factsOf(url, text) }], NOW, "en");
const rows = (t: PriceTable) => t.rows.map((r) => [r.plan, r.value, r.period ?? null, Boolean(r.addOn)]);

const TRANSISTOR = "https://transistor.fm/pricing/";
const ALFRED = "https://www.alfredapp.com/shop/";
const BUZZSPROUT = "https://www.buzzsprout.com/pricing";

describe("transistor.fm /pricing/: plan names from the cards' headings, yearly figures from data-yearly, add-ons marked", () => {
  const t = tableOf(TRANSISTOR, markdown("transistor"));

  it("has each plan per month and per year, and the transcription add-ons", () => {
    assert.deepEqual(rows(t), [
      ["Starter", 19, "month", false],
      ["Starter", 190, "year", false],
      ["Professional", 49, "month", false],
      ["Professional", 490, "year", false],
      ["Business", 99, "month", false],
      ["Business", 990, "year", false],
      ["Transcription (5 hrs per month)", 5, "month", true],
      ["Transcription (5 hrs per month)", 50, "year", true],
      ["Transcription (20 hrs per month)", 20, "month", true],
      ["Transcription (20 hrs per month)", 200, "year", true],
      ["Enterprise 1", 199, "month", false],
      ["Enterprise 1", 1990, "year", false],
    ]);
  });

  it("names no row after the page title, a badge or a feature line", () => {
    for (const bad of [/pricing/i, /recommended/i, /most popular/i, /show notes/i, /^subscription add-ons$/i]) {
      assert.ok(!t.rows.some((r) => bad.test(r.plan)), `no row named ${bad}`);
    }
  });

  it("is what the claim check needs: a mislabel contradicts, and Enterprise 1's own price doesn't", () => {
    const pages = [TRANSISTOR];
    const wrong = checkPriceClaims("The Professional plan is $99 per month.", t, pages);
    assert.ok(wrong.contradictions.some((c) => c.plan === "Professional"));
    const right = checkPriceClaims("Professional is $49 per month and Business is $99 per month.", t, pages);
    assert.deepEqual(right.contradictions, []);
  });
});

describe("alfredapp.com /shop/: the cards wrapped in links, and the old flattened line", () => {
  it("reads Single License £34 and Mega Supporter £59 from the cards", () => {
    assert.deepEqual(rows(tableOf(ALFRED, markdown("alfred"))), [
      ["Single License", 34, null, false],
      ["Mega Supporter", 59, null, false],
    ]);
  });

  it("reads them from the line the sync stored before extractor 3: 'Heading: Plan £34 Qualifier Plan £59 …'", () => {
    const line =
      "Buy the Alfred 5 Powerpack: Single License £34 Single User v5 License Mega Supporter £59 Single User Free Lifetime Upgrades";
    const table = buildPriceTable(
      [
        {
          url: ALFRED,
          facts: {
            prices: [
              { figure: "£34", line },
              { figure: "£59", line },
            ],
          },
        },
      ],
      NOW,
    );
    assert.deepEqual(rows(table), [
      ["Single License", 34, null, false],
      ["Mega Supporter", 59, null, false],
    ]);
  });

  it("takes /shop/ as a pricing page by its title", () => {
    assert.ok(isPricingPage(ALFRED, "Buy the Alfred Powerpack"));
  });
});

describe("buzzsprout.com /pricing: the cards inside a <form>, billed annually and monthly", () => {
  it("has each plan's annual and monthly price", () => {
    const t = tableOf(BUZZSPROUT, markdown("buzzsprout"));
    assert.deepEqual(
      t.rows.map((r) => [r.plan, r.value, r.qualifiers?.find((q) => q.startsWith("billed"))]),
      [
        ["Audio", 15, "billed annually"],
        ["Audio + Video", 25, "billed annually"],
        ["Multi-Podcast", 30, "billed annually"],
        ["Audio", 18, "billed monthly"],
        ["Audio + Video", 30, "billed monthly"],
        ["Multi-Podcast", 36, "billed monthly"],
      ],
    );
    assert.ok(t.rows.every((r) => r.period === "month"));
    // The FAQ's archive plan in a sentence isn't a row.
    assert.ok(!t.rows.some((r) => r.value === 5));
  });
});

describe("the shapes, on other sites", () => {
  it("a plan's name from its heading, past a feature list, a badge and a select button's text", () => {
    const t = tableOf(
      "https://example.com/pricing",
      "# Simple pricing for teams\n\n## Solo\n\n$9 /mo\n\n- One user\n\n- Email support\n\nBest value\n\n## Team 10\n\n$29 /mo\n\n- Ten users\n\n- Priority support\n\n- Shared inbox",
    );
    assert.deepEqual(rows(t), [
      ["Solo", 9, "month", false],
      ["Team 10", 29, "month", false],
    ]);
  });

  it("a feature line or a badge right above a bare figure never names it", () => {
    const t = tableOf("https://example.com/pricing", "## Plans\n\n- Unlimited projects\n\n$12\n\nMost popular\n\n$24");
    assert.deepEqual(t.rows, []);
  });

  it("the line shape 'Heading: Plan €12 qualifier words Plan €20'", () => {
    const line = "Get Widget Pro 3 today: Personal €12 one seat, email support Studio €20 five seats";
    assert.deepEqual(
      ["€12", "€20"].map((figure) => readPriceLine({ figure, line }, "u")?.plan),
      ["Personal", "Studio"],
    );
  });

  it("short qualifier words between a plan and its figure, and a plan with a digit", () => {
    assert.equal(readPriceLine({ figure: "$19", line: "Pro only $19 per month" }, "u")?.plan, "Pro");
    const from = readPriceLine({ figure: "$1,229", line: "Business: from $1,229 per year" }, "u");
    assert.deepEqual([from?.plan, from?.qualifiers], ["Business", ["from"]]);
    const e1 = readPriceLine({ figure: "$199", line: "Enterprise 1: $199 /mo" }, "u");
    assert.deepEqual([e1?.plan, e1?.value, e1?.period], ["Enterprise 1", 199, "month"]);
    assert.equal(readPriceLine({ figure: "$9", line: "Podcast hosting pricing: $9 /mo" }, "u"), undefined);
    assert.equal(readPriceLine({ figure: "$49", line: "Recommended: $49 /mo" }, "u"), undefined);
  });

  it("a digit in a plan's name isn't read as a price", () => {
    const facts = factsOf("https://example.com/pricing", "Enterprise 1 $199/mo");
    assert.deepEqual(
      facts.prices?.map((p) => p.figure),
      ["$199"],
    );
  });

  it("add-ons under an add-ons heading are rows marked as add-ons", () => {
    const t = tableOf(
      "https://example.com/pricing",
      "## Starter\n\n€10 per month\n\n## Extras\n\nExtra storage (100 GB) €3 per month\n\nPriority support €15 per month",
    );
    assert.deepEqual(rows(t), [
      ["Starter", 10, "month", false],
      ["Extra storage (100 GB)", 3, "month", true],
      ["Priority support", 15, "month", true],
    ]);
  });

  it("a monthly price billed annually is per month, with how it's billed as a qualifier", () => {
    const r = readPriceLine({ figure: "$25", line: "Plus: $25 / month, billed annually" }, "u");
    assert.equal(r?.period, "month");
    assert.deepEqual(r?.qualifiers, ["billed annually"]);
  });

  it("a yearly figure written out from a toggle's attributes takes its plan's name", () => {
    const t = tableOf("https://example.com/pricing", "## Basic\n\n€8 /mo\n\n€80 per year\n\nFor one site");
    assert.deepEqual(rows(t), [
      ["Basic", 8, "month", false],
      ["Basic", 80, "year", false],
    ]);
    assert.ok(pagePriceRows("u", { prices: [] }).length === 0);
  });
});
