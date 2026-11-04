// The DA agent pilot's result (docs/ANSWER-QUALITY-PLAN.md, "Pilot result"): while a deployment
// has the data augmentation agents on, its saved configurations and every ask's own filter keep
// their generated text out of retrieval and citation, joined with "and" to the intent and language
// filters. With the agents off, nothing changes.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { languageFilter, NOT_GENERATED, withoutGenerated } from "@launchpad/theme";
import { labelFilter } from "../src/lib/content-plan.ts";
import { excludesGenerated, excludingGenerated, intentSearchConfig, searchConfigFor, withGeneratedExclusion } from "../src/lib/prompt.ts";

const CLAUSE = { not: { prop: "generated", by: "data-augmentation" } };
const de = languageFilter("de").filter_expression.field;

describe("the generated-text exclusion", () => {
  it("is the clause the pilot measured", () => {
    assert.deepEqual(NOT_GENERATED, CLAUSE);
    assert.equal(excludesGenerated({ augmentation: null }), false);
    assert.equal(excludesGenerated({ augmentation: { tasks: [] } }), true);
  });

  it("leaves the saved configurations as they were with the agents off", () => {
    assert.deepEqual(searchConfigFor("P", "en", null, undefined, false), searchConfigFor("P", "en", null));
    assert.equal(searchConfigFor("P", "en", null).filter_expression, undefined);
    const price = labelFilter("price");
    assert.deepEqual(intentSearchConfig("P", "en", "price", price, null, false).filter_expression, price);
  });

  it("is the default configuration's filter, and and-ed with each intent's pages, with the agents on", () => {
    assert.deepEqual(searchConfigFor("P", "en", null, undefined, true).filter_expression, { field: CLAUSE });
    const price = labelFilter("price");
    assert.deepEqual(intentSearchConfig("P", "en", "price", price, null, true).filter_expression, {
      field: { and: [price.field, CLAUSE] },
    });
    // Everything else is the configuration it was.
    const { filter_expression: _a, ...on } = intentSearchConfig("P", "en", "price", price, null, true);
    const { filter_expression: _b, ...off } = intentSearchConfig("P", "en", "price", price, null);
    assert.deepEqual(on, off);
  });

  it("joins an ask's intent and language filter (validation, the preview) only with the agents on", () => {
    const both = { field: { and: [labelFilter("events").field, de] } };
    assert.deepEqual(excludingGenerated(both, false), both);
    assert.deepEqual(excludingGenerated(both, true), { field: { and: [labelFilter("events").field, de, CLAUSE] } });
    assert.deepEqual(excludingGenerated({ field: de }, true), { field: { and: [de, CLAUSE] } });
    assert.equal(withoutGenerated(undefined, false), undefined);
    assert.deepEqual(withoutGenerated(undefined, true), CLAUSE);
  });

  it("is added to or taken out of a saved configuration, leaving the rest as saved", () => {
    const price = labelFilter("price");
    const saved = { ...intentSearchConfig("Edited in the dashboard", "en", "price", price, null), query: "" };
    const on = withGeneratedExclusion(saved, true);
    assert.deepEqual(on.filter_expression, { field: { and: [price.field, CLAUSE] } });
    assert.equal("query" in on, false);
    assert.deepEqual(withGeneratedExclusion(on, true), on, "once, however often it's saved");
    const { query: _q, ...plain } = saved;
    assert.deepEqual(withGeneratedExclusion(on, false), plain);
    // The default configuration has no filter of its own.
    const base = searchConfigFor("P", "en", null);
    assert.deepEqual(withGeneratedExclusion(base, true), searchConfigFor("P", "en", null, undefined, true));
    assert.deepEqual(withGeneratedExclusion(withGeneratedExclusion(base, true), false), base);
    assert.deepEqual(withGeneratedExclusion(base, false), base);
  });
});
