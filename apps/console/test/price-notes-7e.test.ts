// Fix cycle 7e: the note on figures no row has, from toggl.com's stored pricing page in the fourth
// release check (review-kit/round-7/verification/U1). No network and no database.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import type { PageFacts, PriceRow, PriceTable } from "@launchpad/db";
import { priceRowsHash } from "@launchpad/theme";
import { stillUnplaced } from "../src/lib/content-plan.ts";
import { currentUnplaced } from "../src/lib/price-table.ts";
import { pricePrompt } from "../src/lib/price-table-model.ts";
import { addPriceRow, editPriceRow } from "../src/lib/review.ts";

const fixture = (name: string) => readFileSync(new URL(`fixtures/${name}`, import.meta.url), "utf8");

const row = (plan: string, amount: string, value: number): PriceRow => ({
  plan,
  amount,
  value,
  currency: "USD",
  url: "https://toggl.com/pricing",
  line: `${plan}: ${amount}`,
});
const rows = [row("Starter", "$9", 9), row("Premium", "$16", 16)];
const prices = [
  { figure: "$9", line: "Starter: $9" },
  { figure: "$16", line: "$16" },
  { figure: "$12", line: "$12" },
  { figure: "$24", line: "$24" },
];
const table = (over: Partial<PriceTable> = {}): PriceTable => ({
  rows,
  pages: ["https://toggl.com/pricing"],
  readAt: "2026-11-02T00:00:00Z",
  hash: priceRowsHash(rows),
  ...over,
});
const pages = [{ url: "https://toggl.com/pricing", facts: { prices } as PageFacts }];
const figures = (t: PriceTable) => (t.unplaced ?? []).map((f) => f.figure);

describe("the note on figures no row has", () => {
  it("shows on a table read before the note existed, with no model call", () => {
    assert.deepEqual(figures(currentUnplaced(table(), pages)), ["$12", "$24"]);
    assert.equal(currentUnplaced(table(), pages).hash, table().hash, "the rows, and so a confirmation, are untouched");
  });

  it("clears for a figure a person's row now has, and only that one", () => {
    const noted = currentUnplaced(table(), pages);
    const one = addPriceRow(noted, { plan: "Starter", amount: "$ 12", period: "month", note: "billed monthly" });
    assert.ok("table" in one);
    if (!("table" in one)) return;
    assert.deepEqual(figures(one.table), ["$24"]);
    const both = addPriceRow(one.table, { plan: "Premium", amount: "$24", period: "month" });
    assert.ok("table" in both);
    if (!("table" in both)) return;
    assert.equal(both.table.unplaced, undefined);
    assert.deepEqual(figures(currentUnplaced(both.table, pages)), []);
  });

  it("clears for a row a person corrected to that figure", () => {
    const noted = currentUnplaced(table(), pages);
    const edited = editPriceRow(noted, 0, { amount: "$12" });
    assert.ok("table" in edited);
    if ("table" in edited) assert.deepEqual(figures(edited.table), ["$24"]);
  });

  it("a stored note goes stale no more, by value and currency", () => {
    const stored = [{ figure: "$12", url: "u", line: "$12" }];
    assert.deepEqual(stillUnplaced([row("Starter", "$ 12", 12)], stored), []);
    assert.deepEqual(stillUnplaced([{ ...row("Starter", "€12", 12), currency: "EUR" }], stored), stored);
  });

  it("Toggl's $12 and $24: the model already reads them, and nothing beside them names a plan", () => {
    const text = fixture("pricing-bare-figures.txt");
    assert.ok(text.length < 14_000);
    const prompt = pricePrompt({ url: "https://toggl.com/pricing", text });
    const lines = text.split("\n").filter((l) => l.trim());
    const at = lines.indexOf("$12");
    assert.ok(prompt.includes("$12") && prompt.includes("$24"), "the whole page goes in the one call");
    const neighbours = lines.slice(Math.max(0, at - 3), at + 4).join(" ");
    assert.doesNotMatch(neighbours, /\b(?:Starter|Premium|Free|Enterprise)\b/);
  });
});
