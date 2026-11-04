// Round 5 in the chat: intent questions asked of their intent's configuration and pages first,
// falling back to the deployment's own (item 3), and grounding, so a cited answer whose figures
// stand on the pages it cites shows whatever its reranker score (item 1). The grounding case is
// the raw Agentic RAG stream for kemptechnologies.com's "What are your prices?" (fixtures/), which
// scored 0.0112 and showed "Sorry, I couldn't find an answer".

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { type RetrievedResource, toStreamItem } from "@launchpad/par-client/ask-stream";
import { isAnswered, questionIntents } from "@launchpad/theme";
import { intentPages, PAGE_LABELSET, pagesFilter, routedIntent, staysInLanguage } from "../src/route.ts";
import { bestScore, citedPassages, MIN_RERANKER_SCORE, showsModelText, verdict } from "../src/sources.ts";

const CONFIGS = { price: "launchpad-default-price", contact: "launchpad-default-contact", events: "launchpad-default-events" };

describe("intent routing", () => {
  it("routes an intent question to the first of its intents that has a configuration", () => {
    assert.equal(routedIntent("What are your prices?", CONFIGS, questionIntents), "price");
    assert.equal(routedIntent("Was kostet LoadMaster?", CONFIGS, questionIntents), "price");
    assert.equal(routedIntent("¿Cuánto cuesta?", CONFIGS, questionIntents), "price");
    assert.equal(routedIntent("When is the next WhatsUp Gold webinar?", CONFIGS, questionIntents), "events");
    // Support comes before contact, but has no configuration here.
    assert.equal(routedIntent("How do I contact support?", CONFIGS, questionIntents), "contact");
    // "When is…" on a site with events is asked of them first; the default configuration still answers
    // what they don't (round 7).
    assert.equal(routedIntent("When are you open?", CONFIGS, questionIntents), "events");
    assert.equal(routedIntent("What are your hours?", CONFIGS, questionIntents), undefined);
    // Nothing routed by an older console, or a deployment without intent configurations.
    assert.equal(routedIntent("What are your prices?", undefined, questionIntents), undefined);
    assert.equal(routedIntent("What are your prices?", {}, questionIntents), undefined);
  });

  it("asks of the intent's pages, joined with the language filter so the configuration's own can't be dropped", () => {
    assert.deepEqual(pagesFilter(undefined, undefined), {});
    assert.deepEqual(pagesFilter("de", undefined), {
      filter_expression: { field: { prop: "language", language: "de", only_primary: true } },
    });
    assert.deepEqual(pagesFilter(undefined, "events"), {
      filter_expression: { field: { prop: "label", labelset: PAGE_LABELSET, label: "events" } },
    });
    // A price question reads buying pages too (telerik.com's /purchase.aspx is its price list).
    assert.deepEqual(pagesFilter("de", "price"), {
      filter_expression: {
        field: {
          and: [
            { prop: "language", language: "de", only_primary: true },
            {
              or: [
                { prop: "label", labelset: PAGE_LABELSET, label: "price" },
                { prop: "label", labelset: PAGE_LABELSET, label: "buy" },
              ],
            },
          ],
        },
      },
    });
  });

  it("names key pages sent before labels existed by resource id, until they're read again", () => {
    assert.deepEqual(intentPages("trial", ["8556d55fbdb94f3dad5a442c8f9d54b9"]), {
      or: [
        { prop: "label", labelset: PAGE_LABELSET, label: "trial" },
        { prop: "resource", id: "8556d55fbdb94f3dad5a442c8f9d54b9" },
      ],
    });
  });
});

describe("generated text kept out while the agents are on (PublicWidgetConfig.excludeGenerated)", () => {
  const NOT_GENERATED = { not: { prop: "generated", by: "data-augmentation" } };
  const de = { prop: "language", language: "de", only_primary: true };
  const events = { prop: "label", labelset: PAGE_LABELSET, label: "events" };

  it("leaves every filter as it was with the agents off", () => {
    for (const exclude of [undefined, false]) {
      assert.deepEqual(pagesFilter(undefined, undefined, undefined, exclude), {});
      assert.deepEqual(pagesFilter("de", undefined, undefined, exclude), { filter_expression: { field: de } });
      assert.deepEqual(pagesFilter("de", "events", undefined, exclude), { filter_expression: { field: { and: [de, events] } } });
    }
  });

  it("joins the not-generated clause with the language and intent filters, with the agents on", () => {
    assert.deepEqual(pagesFilter(undefined, undefined, undefined, true), { filter_expression: { field: NOT_GENERATED } });
    assert.deepEqual(pagesFilter("de", undefined, undefined, true), { filter_expression: { field: { and: [de, NOT_GENERATED] } } });
    assert.deepEqual(pagesFilter(undefined, "events", undefined, true), { filter_expression: { field: { and: [events, NOT_GENERATED] } } });
    assert.deepEqual(pagesFilter("de", "events", undefined, true), {
      filter_expression: { field: { and: [de, events, NOT_GENERATED] } },
    });
  });
});

describe("grounding in the chat (kemptechnologies.com, “What are your prices?”, round 5)", () => {
  const [raw] = JSON.parse(readFileSync(new URL("./fixtures/raw-ask-prices.json", import.meta.url), "utf8")) as { body: string }[];
  const items = raw!.body
    .split("\n")
    .filter(Boolean)
    .map((line) => toStreamItem(JSON.parse(line)));
  // As the widget collects it (element.ts #collect).
  let answer = "";
  let status: string | undefined;
  let resources: Record<string, RetrievedResource> = {};
  let citations: Record<string, unknown> | undefined;
  let augmented: Record<string, { text?: unknown }> = {};
  for (const item of items) {
    if (item.type === "answer") answer += item.text;
    else if (item.type === "status") status = item.status;
    else if (item.type === "retrieval") resources = item.resources;
    else if (item.type === "citations") citations = item.citations;
    else if (item.type === "other" && item.itemType === "augmented_context")
      augmented = (item.raw as { augmented: { paragraphs: typeof augmented } }).augmented.paragraphs;
  }
  const question = "What are your prices?";
  const best = bestScore(resources);

  it("is the case the score floor hid: a success, cited, best paragraph under the floor", () => {
    assert.equal(status, "success");
    assert.ok(best && best.type === "RERANKER" && best.score < MIN_RERANKER_SCORE, `best ${best?.score}`);
    assert.equal(Object.keys(citations ?? {}).length, 6);
    assert.match(answer, /\$2,205 per year/);
  });

  it("reads the cited paragraphs as the model did: neighbours retrieval never listed come from the augmented context", () => {
    const passages = citedPassages(resources, citations, augmented);
    assert.equal(passages.length, 6);
    const text = passages.join("\n");
    for (const figure of ["2,205", "4,500", "5,300", "6,200", "0.41"]) assert.ok(text.includes(figure), figure);
    // Retrieval alone holds only some of them for the cited paragraphs.
    assert.ok(!citedPassages(resources, citations, {}).join("\n").includes("5,300"));
  });

  it("shows the prices: grounded content beats the score floor", () => {
    const v = verdict({
      answer,
      status,
      resources,
      citations,
      best,
      question,
      language: "en",
      passages: citedPassages(resources, citations, augmented),
    });
    assert.ok(isAnswered(v), v);
    assert.ok(showsModelText(v), v);
  });

  it("still keeps off-topic replies out: nothing concrete on the cited pages, under the floor", () => {
    const v = verdict({
      answer: "Our clinic offers many services and our team is happy to help.",
      status: "success",
      best: { score: 0.003, type: "RERANKER" },
      citations: { "r1/t/body/0-50": [[0, 10]] },
      question: "Do you sell bicycles?",
      passages: ["Opening hours: Monday to Friday."],
    });
    assert.ok(!isAnswered(v), v);
  });
});

describe("the visitor's language on the second ask (round 6, teamleader.eu)", () => {
  it("keeps price, contact and reach-us questions in their language, and lets others read every page", () => {
    for (const q of [
      "Quels sont vos prix ?",
      "Wie lautet Ihre Telefonnummer?",
      "Quel est votre numéro de téléphone ?",
      "What's your email address?",
    ])
      assert.ok(staysInLanguage(q, questionIntents(q)), q);
    for (const q of ["Is there a warranty?", "Was ist neu in Version 15?"]) assert.ok(!staysInLanguage(q, questionIntents(q)), q);
  });
});
