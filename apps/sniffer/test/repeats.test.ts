// The reader's repeated lines (fix cycle 7d): boilerplate goes, a short line repeated between the items
// of a list or table stays with its item. From what imeche.org, kemptechnologies.com, chef.io and
// agentic-rag's pricing pages serve.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { dropRepeats, EXTRACT_SCRIPT } from "../src/content.ts";

describe("dropRepeats", () => {
  it("keeps a date under each event that has it (imeche.org's /events)", () => {
    const kept = dropRepeats([
      "CONFERENCE",
      "Crane Safety 2026",
      "Manchester, 11 November 2026",
      "CONFERENCE",
      "Nuclear Lifting 2026",
      "Manchester, 11 November 2026",
      "CONFERENCE",
      "Fire Safety on the Railway",
      "Birmingham, 11 November 2026",
    ]);
    assert.deepEqual(kept.slice(3, 6), ["CONFERENCE", "Nuclear Lifting 2026", "Manchester, 11 November 2026"]);
  });

  it("keeps each plan's unit and period (Kemp, chef, agentic-rag)", () => {
    const kept = dropRepeats([
      "### Standard",
      "starting from",
      "$ 4,500",
      "per year",
      "### Enterprise",
      "starting from",
      "$ 5,300",
      "per year",
      "### Business",
      "$ 59",
      "per node",
      "per year",
      "### Enterprise Plus",
      "$ 189",
      "per node",
      "per year",
      "Starter",
      "$ 700",
      "monthly",
      "Pro",
      "$ 1,925",
      "monthly",
    ]);
    assert.equal(kept.filter((b) => b === "per year").length, 4);
    assert.equal(kept.filter((b) => b === "starting from").length, 2);
    assert.equal(kept.filter((b) => b === "per node").length, 2);
    assert.equal(kept.filter((b) => b === "monthly").length, 2);
    assert.deepEqual(kept.slice(kept.indexOf("$ 5,300") - 1, kept.indexOf("$ 5,300") + 2), ["starting from", "$ 5,300", "per year"]);
  });

  it("drops calls to action, wherever they are", () => {
    const kept = dropRepeats(["Plan A", "Learn more", "Plan B", "Learn more", "Plan C", "Contact us", "Plan D", "Contact us"]);
    assert.deepEqual(kept, ["Plan A", "Learn more", "Plan B", "Plan C", "Contact us", "Plan D"]);
  });

  it("drops a carousel's cloned card and a long repeated line", () => {
    const long = "This sentence is the sort of long marketing paragraph a page repeats in a band further down its length.";
    const kept = dropRepeats(["## Card", "$ 10", "per month", "Other", "## Card", "$ 10", "per month", long, "Between", long]);
    assert.deepEqual(kept, ["## Card", "$ 10", "per month", "Other", long, "Between"]);
  });

  it("drops a block of plain repeated lines, but not one or two", () => {
    const three = dropRepeats(["A one", "B two", "C three", "New", "A one", "B two", "C three"]);
    assert.deepEqual(three, ["A one", "B two", "C three", "New"]);
    const one = dropRepeats(["Item 1", "Online", "Item 2", "Online"]);
    assert.deepEqual(one, ["Item 1", "Online", "Item 2", "Online"]);
  });

  it("the script the page runs carries it, and parses", () => {
    assert.ok(EXTRACT_SCRIPT.includes("dropRepeats"));
    assert.doesNotThrow(() => new Function(`return ${EXTRACT_SCRIPT}`));
  });
});
