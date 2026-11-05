// Events reach the chat in every language (round 7): "when is…" counts as an events question on a site
// with events, an events question's second ask reads every language, and a date question citing a page
// with stored dates, answered with no day and month, gets the handoff card.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { questionIntents } from "@launchpad/theme";
import { datelessEvent, routedIntent, staysInLanguage } from "../src/route.ts";

const events = { events: "chat-events" };
const route = (q: string, configs: Record<string, string> | undefined = events) => routedIntent(q, configs, questionIntents);

describe("which questions are asked of the events pages", () => {
  it("'when is…' in each language, on a site with events", () => {
    for (const q of [
      "Wann ist MVTec auf der embedded world?",
      "When is your next show?",
      "¿Cuándo es la feria?",
      "Quand a lieu le salon ?",
    ])
      assert.equal(route(q), "events", q);
  });

  it("not on a site with no events", () => {
    assert.equal(route("Wann ist MVTec auf der embedded world?", { price: "chat-price" }), undefined);
    assert.equal(routedIntent("Wann ist MVTec auf der embedded world?", undefined, questionIntents), undefined);
  });

  it("not when it names another intent, or asks nothing about when", () => {
    assert.equal(route("When does support open?", { ...events, support: "chat-support" }), "support");
    assert.equal(route("When does support open?"), undefined);
    assert.equal(route("What does HALCON do?"), undefined);
    assert.equal(route("What's the next step after installing?"), undefined);
  });
});

describe("the second ask's languages", () => {
  it("an events question reads every language", () => {
    assert.equal(staysInLanguage("¿Hay algún webinar próximo?", questionIntents("¿Hay algún webinar próximo?")), false);
    assert.equal(staysInLanguage("Gibt es ein bevorstehendes Webinar?", questionIntents("Gibt es ein bevorstehendes Webinar?")), false);
  });

  it("a price, contact or phone question still stays in the visitor's language", () => {
    assert.equal(staysInLanguage("Was kostet es?", questionIntents("Was kostet es?")), true);
    assert.equal(staysInLanguage("Wie ist Ihre Telefonnummer?", questionIntents("Wie ist Ihre Telefonnummer?")), true);
    // An events question that also asks for a contact keeps to the market's pages.
    assert.equal(staysInLanguage("Who do I contact about the webinar?", ["events", "contact"]), true);
  });
});

describe("the chat's check on a date question", () => {
  const pages = ["/de/wissensportal/events", "/knowledge-base/events"];
  const cited = [{ href: "https://www.mvtec.com/de/wissensportal/events/" }];
  const q = "Wann findet das nächste Webinar statt?";

  it("catches the false 'no exact day' of round 7 (saved replies, verification U2)", () => {
    assert.equal(
      datelessEvent(
        q,
        "Das nächste Webinar findet im November 2026 statt: „Fortgeschrittenes Deep Learning für die industrielle Bildverarbeitung“. Ein genaues Datum nennt die Seite „Veranstaltungen, Messen & Webinare“ nicht.",
        cited,
        pages,
      ),
      true,
    );
    assert.equal(
      datelessEvent(
        "Wann ist MVTec auf der embedded world?",
        "Wir sind im März 2027 auf der embedded world vertreten. Den genauen Termin nennt unsere Seite nicht. Sie finden uns in Halle 2, Stand 2-541.",
        cited,
        pages,
      ),
      true,
    );
  });

  it("leaves a reply that gives the day, in any language or order", () => {
    for (const answer of [
      "Das nächste Webinar findet am 5. November 2026 statt.",
      "The next webinar is on November 5, 2026.",
      "Die SPS findet vom 24. bis 26. November 2026 statt.",
      "El próximo seminario es el 5 de noviembre.",
    ])
      assert.equal(datelessEvent(q, answer, cited, pages), false, answer);
  });

  it("leaves other questions, replies citing other pages, and chats with no stored events", () => {
    const none = "Ein genaues Datum nennt die Seite nicht.";
    assert.equal(datelessEvent("Was macht HALCON?", none, cited, pages), false);
    assert.equal(datelessEvent(q, none, [{ href: "https://www.mvtec.com/de/produkte" }], pages), false);
    assert.equal(datelessEvent(q, none, cited, undefined), false);
    assert.equal(datelessEvent(q, none, cited, []), false);
  });
});
