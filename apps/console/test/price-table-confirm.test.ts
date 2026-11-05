// Round 6, item 1: the price table's confirm step as Review reads it, a row corrected by hand, and
// held answers a person kept, shown in Review's "Decisions on the way" (item 6).

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type PriceTable, priceRowsHash } from "@launchpad/theme";
import { canSignOff, editPriceRow, priceTableLine, priceTableState, reviewDecisions } from "../src/lib/review.ts";
import { type RunQuestion, reviewNotes } from "../src/lib/validation-rules.ts";

const PRICING = "https://kemptechnologies.com/pricing";
const rows = [
  { plan: "Standard", amount: "$4,500", value: 4500, url: PRICING, line: "Standard: $4,500" },
  { plan: "Enterprise", amount: "$5,300", value: 5300, url: PRICING, line: "Enterprise: $5,300" },
];
const TABLE: PriceTable = { rows, pages: [PRICING], readAt: "2026-11-01T00:00:00Z", hash: priceRowsHash(rows) };
const base = "/customers/t1/deployments/d1";

describe("the price table on Review", () => {
  it("doesn't hold up sign-off when there's no table (no pricing page, or prices by quote), and says so", () => {
    const line = priceTableLine(base, null, null);
    assert.equal(line.state, "info");
    assert.equal(line.required, false);
    assert.match(line.detail, /no pricing page was found/);
    assert.equal(priceTableLine(base, { ...TABLE, rows: [] }, null).required, false);
    assert.ok(canSignOff([line]));
  });

  it("holds up sign-off until a person confirms the table, and again when its rows change", () => {
    const todo = priceTableLine(base, TABLE, null);
    assert.deepEqual([todo.state, todo.required, canSignOff([todo])], ["todo", true, false]);
    const confirmation = { hash: TABLE.hash, by: "Dana Ruiz", at: "2026-11-01T10:00:00Z" };
    const ok = priceTableLine(base, TABLE, confirmation);
    assert.deepEqual([ok.state, canSignOff([ok])], ["ok", true]);
    assert.match(ok.detail, /confirmed against the pricing page by Dana Ruiz/);
    const changed = priceTableLine(base, { ...TABLE, hash: "other" }, confirmation);
    assert.equal(changed.state, "check");
    assert.equal(priceTableState({ ...TABLE, hash: "other" }, confirmation), "changed");
  });

  it("corrects one row by hand, in the page's own format, with a new hash", () => {
    const edited = editPriceRow(TABLE, 0, { amount: "4.600 $", unit: "per node", period: "year" });
    assert.ok(!("error" in edited));
    assert.equal(edited.plan, "Standard");
    assert.deepEqual([edited.table.rows[0]?.value, edited.table.rows[0]?.unit, edited.table.rows[0]?.period], [4600, "per node", "year"]);
    assert.notEqual(edited.table.hash, TABLE.hash);
    assert.equal(edited.table.hash, priceRowsHash(edited.table.rows));
    // A bare number takes the row's currency.
    const bare = editPriceRow(TABLE, 1, { amount: "5400" });
    assert.ok(!("error" in bare) && bare.table.rows[1]?.value === 5400);
    assert.ok("error" in editPriceRow(TABLE, 0, { amount: "ask us" }));
    assert.ok("error" in editPriceRow(TABLE, 5, { amount: "$1" }));
  });
});

describe("kept answers in Review's Decisions on the way", () => {
  it("lists a held answer a person kept, with what held it, who and why", () => {
    const kept: RunQuestion = {
      question: "Can I get a free trial?",
      answer: "You can book a personalised demo.",
      sources: [],
      answered: false,
      declined: true,
      holds: [{ by: "claim", clear: "decide", text: "It may not answer: it gives a step for a demo, but none for a trial." }],
      acknowledged: {
        by: "u1",
        name: "Dana Ruiz",
        at: "2026-11-01T10:00:00Z",
        verified: true,
        reason: "The trial is booked through the demo form.",
      },
    };
    const lines = reviewDecisions(reviewNotes({ at: "2026-11-01T10:00:00Z", passed: true, questions: [kept] }));
    assert.deepEqual(lines, [
      "“Can I get a free trial?” kept as answered (held: It may not answer: it gives a step for a demo, but none for a trial), by Dana Ruiz (2026-11-01 10:00 UTC): The trial is booked through the demo form.",
    ]);
  });
});
