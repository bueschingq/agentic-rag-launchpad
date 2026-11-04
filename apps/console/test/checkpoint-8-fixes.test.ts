// What the build 8 checkpoint found: a trade fair question reaches the events list, and Confirm's card
// shows a replacement without its Markdown.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { routeIntent } from "@launchpad/theme";
import { priceReask, type RunQuestion } from "../src/lib/validation-rules.ts";

describe("a question about a trade fair", () => {
  it("is an events question, in any language", () => {
    for (const q of [
      "Auf welcher Messe ist MVTec als Nächstes?",
      "Which expo are you at?",
      "¿En qué feria estarán?",
      "Sur quel salon serez-vous ?",
      "Op welke beurs staan jullie?",
      "Em que feira estarão?",
      "A quale fiera sarete?",
    ]) {
      assert.equal(routeIntent(q), "events", q);
    }
  });
  it("leaves other questions where they were", () => {
    for (const q of ["Is that fair?", "What does it do?", "Wie funktioniert die Software?"]) assert.equal(routeIntent(q), undefined, q);
  });
});

describe("what Confirm's card shows", () => {
  it("prints a replacement without its Markdown", () => {
    const shown = priceReask({
      question: "How much is Standard?",
      visitorGets: { answer: "- **STANDARD**: US$ 5.79 per seat per month" },
    } as unknown as RunQuestion);
    assert.equal(shown.answer, "- STANDARD: US$ 5.79 per seat per month");
    assert.equal(shown.replaced, "rows");
  });
});
