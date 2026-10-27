import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { addDays, costCents, isoDate, parseLogDate, startOfUtcDay, yearMonth } from "../src/dates.ts";

describe("rollup dates", () => {
  it("parses Agentic RAG's naive UTC log timestamps", () => {
    assert.equal(parseLogDate("2026-10-27 01:35:34.166467").toISOString(), "2026-10-27T01:35:34.166Z");
    assert.equal(parseLogDate("2026-10-27T01:35:34Z").toISOString(), "2026-10-27T01:35:34.000Z");
  });

  it("works in UTC days", () => {
    const day = startOfUtcDay(new Date("2026-10-27T23:59:59-05:00"));
    assert.equal(day.toISOString(), "2026-10-28T00:00:00.000Z");
    assert.equal(isoDate(addDays(day, -1)), "2026-10-27");
    assert.equal(yearMonth(day), "2026-10");
  });

  it("prices query tokens in cents, or not at all without a rate", () => {
    // M0: about 0.19 Nuclia tokens per answer.
    assert.equal(costCents(10_000 * 0.19, 0.008), 1520);
    assert.equal(costCents(2.131384, undefined), undefined);
  });
});
