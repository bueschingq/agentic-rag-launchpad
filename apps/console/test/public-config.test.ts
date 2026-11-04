// Round 5, item 3: what the public config tells the widget about intent routing, and the widget's
// page filter matching the one the console's intent configurations are saved with.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { intentConfigName, ROUTE_INTENTS } from "@launchpad/theme";
import { intentPages, PAGE_LABELSET as WIDGET_LABELSET } from "../../../packages/widget/src/route.ts";
import { intentRoutes, LABELLED_SINCE } from "../src/app/api/public/deployments/[id]/config/intents.ts";
import { EXTRACTOR_VERSION, labelFilter, PAGE_LABELSET } from "../src/lib/content-plan.ts";
import { INTENT_CONFIGS_SINCE, intentConfigs } from "../src/lib/prompt.ts";

const TODAY = new Date("2026-10-31T12:00:00Z");
const CONFIGS = Object.fromEntries(ROUTE_INTENTS.map((i) => [i, intentConfigName("launchpad-default", i)]));
const rid = (n: number) => n.toString(16).padStart(32, "0");
const page = (n: number, keyIntent: string | null, extractorVersion = LABELLED_SINCE, facts: object | null = null) => ({
  resourceId: rid(n),
  keyIntent,
  extractorVersion,
  facts: facts as never,
});

describe("the public config's intent routing", () => {
  it("routes only the intents the KB holds pages for", () => {
    const routing = intentRoutes(
      [
        page(1, "price"),
        page(2, "contact"),
        page(3, "faq"),
        page(4, null, LABELLED_SINCE, { events: [{ date: "2026-11-05", line: "Thursday, November 5", readAs: "5 November 2026" }] }),
      ],
      CONFIGS,
      TODAY,
    );
    assert.deepEqual(routing, {
      intentConfigs: {
        // A price question reads buying pages too, and the other way round.
        price: "launchpad-default-price",
        buy: "launchpad-default-buy",
        events: "launchpad-default-events",
        support: "launchpad-default-support",
        contact: "launchpad-default-contact",
      },
    });
  });

  it("doesn't route events once the dates are past, nor anything for a deployment with no intent configurations", () => {
    const past = page(4, null, LABELLED_SINCE, { events: [{ date: "2026-10-01", line: "Thursday, October 1", readAs: "1 October 2026" }] });
    assert.deepEqual(intentRoutes([past], CONFIGS, TODAY), {});
    assert.deepEqual(intentRoutes([page(1, "price")], {}, TODAY), {});
    assert.equal(
      intentConfigs({ systemPrompt: "Be helpful.", searchConfig: "launchpad-default", answeringRules: INTENT_CONFIGS_SINCE - 1 }),
      undefined,
    );
    assert.equal(intentConfigs({ systemPrompt: "", searchConfig: "launchpad-default", answeringRules: INTENT_CONFIGS_SINCE }), undefined);
  });

  it("names key pages sent before labels existed by resource id, until they're read again", () => {
    const routing = intentRoutes([page(7, "trial", LABELLED_SINCE - 1), page(8, "trial", LABELLED_SINCE - 1)], CONFIGS, TODAY);
    assert.deepEqual(routing, { intentConfigs: { trial: "launchpad-default-trial" }, intentPages: { trial: [rid(7), rid(8)] } });
  });

  it("asks with the same page filter the console saves the intent configurations with", () => {
    assert.equal(WIDGET_LABELSET, PAGE_LABELSET);
    assert.ok(LABELLED_SINCE <= EXTRACTOR_VERSION, "labels are written from LABELLED_SINCE on");
    for (const intent of ROUTE_INTENTS) {
      assert.deepEqual(intentPages(intent), labelFilter(intent).field, intent);
      assert.deepEqual(intentPages(intent, [rid(1)]), labelFilter(intent, [rid(1)]).field, intent);
    }
  });
});
