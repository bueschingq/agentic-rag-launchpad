// The answering rules version guard (round 5, item 6): what decides an answer under the latest
// rules (the user prompt and each intent's, the system prompt's rules, the retrieval settings) is
// recorded per ANSWERING_RULES version in fixtures/answering-rules.json. Changing it without a
// bump fails here: deployments would never be re-checked onto the change (jobs/rules-rollout.ts
// only touches deployments below ANSWERING_RULES), or worse, it would reach them unchecked.
//
// After a deliberate change: bump ANSWERING_RULES in src/lib/prompt.ts, say what changed in
// ANSWERING_RULES_CHANGES, then record with RECORD_RULES=1 node --test apps/console/test/answering-rules.test.ts.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { describe, it } from "node:test";
import { ROUTE_INTENTS } from "@launchpad/theme";
import {
  ANSWERING_RULES,
  ANSWERING_RULES_CHANGES,
  answeringRulesFingerprint,
  composeUserPrompt,
  INTENT_CONFIGS_SINCE,
  intentConfigs,
  intentSearchConfig,
  PARTIAL_RULE,
} from "../src/lib/prompt.ts";

const RECORD = new URL("fixtures/answering-rules.json", import.meta.url);
const hash = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);

describe("the answering rules version", () => {
  it("changes only with a version bump", () => {
    const recorded = JSON.parse(readFileSync(RECORD, "utf8")) as Record<string, string>;
    const now = hash(answeringRulesFingerprint());
    if (process.env.RECORD_RULES && !recorded[ANSWERING_RULES]) {
      writeFileSync(RECORD, `${JSON.stringify({ ...recorded, [ANSWERING_RULES]: now }, null, 2)}\n`);
      return;
    }
    assert.equal(now, recorded[ANSWERING_RULES], "the answering rules changed: bump ANSWERING_RULES in src/lib/prompt.ts and record it");
    assert.ok(ANSWERING_RULES_CHANGES[ANSWERING_RULES], "say what the version changes");
  });

  it("never lets the model say the whole website lacks something, and lets it name the page it read", () => {
    assert.match(PARTIAL_RULE, /Never say that our website, our site or our pages as a whole don't list/);
    assert.match(PARTIAL_RULE, /naming it \("Our pricing page doesn't list a price for 300 devices"\)/);
    assert.ok(composeUserPrompt("en").includes(PARTIAL_RULE));
  });

  it("gives each intent its own line and keeps it to the intent's labelled pages", () => {
    for (const intent of ROUTE_INTENTS) {
      const filter = { field: { prop: "label", labelset: "launchpad_page", label: intent } };
      const config = intentSearchConfig("PROMPT", "en", intent, filter, null);
      assert.deepEqual(config.filter_expression, filter);
      assert.notEqual((config.prompt as { user: string }).user, composeUserPrompt("en"));
    }
    assert.match(composeUserPrompt("auto", "events"), /call an event over only if its full date, with the year, is before today/i);
    // Round 6: the routed events configuration lists upcoming events soonest first.
    const events = intentSearchConfig(
      "PROMPT",
      "en",
      "events",
      { field: { prop: "label", labelset: "launchpad_page", label: "events" } },
      null,
    );
    assert.match((events.prompt as { user: string }).user, /list the upcoming events soonest first, by their full date with the year/);
  });

  it("routes only deployments that have the intent configurations", () => {
    const d = { systemPrompt: "P", searchConfig: "launchpad-default" };
    assert.equal(intentConfigs({ ...d, answeringRules: INTENT_CONFIGS_SINCE - 1 }), undefined);
    assert.equal(intentConfigs({ ...d, answeringRules: INTENT_CONFIGS_SINCE })?.price, "launchpad-default-price");
    assert.equal(intentConfigs({ ...d, systemPrompt: "", answeringRules: 9 }), undefined);
  });
});
