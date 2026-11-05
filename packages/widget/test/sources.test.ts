// The source links under an answer (item 5, round 4): at most two, related to the question or
// the answer, in the visitor's language when there's one. The cases are real retrievals from the
// reviewers' round-4 Knowledge Boxes, asked as partner tests on 2026-10-30 (fixtures/).

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import type { RetrievedResource } from "@launchpad/par-client/ask-stream";
import { brandWords, citedSources, MAX_SOURCES, pickSources, sourcesFor } from "../src/sources.ts";

interface Case {
  where: string;
  question: string;
  answer: string;
  brand: string;
  language: string;
  resources: Record<string, RetrievedResource>;
  citations: Record<string, unknown>;
}
const CASES = JSON.parse(readFileSync(new URL("./fixtures/sources-round4.json", import.meta.url), "utf8")) as Record<string, Case>;
const shown = (tag: string) => {
  const c = CASES[tag]!;
  return sourcesFor(c.resources, c.citations, { question: c.question, answer: c.answer, language: c.language, brand: c.brand }).map(
    (s) => s.title,
  );
};

describe("sources that fit the answer, on the reviewers' own questions", () => {
  it("never shows more than two", () => {
    for (const tag of Object.keys(CASES)) assert.ok(shown(tag).length <= MAX_SOURCES, tag);
  });

  it('"Can I watch a demo?" doesn\'t cite "What is sFlow?" or the on-call sysadmin post (whatsupgold.com)', () => {
    // Ten pages cited, nine of them for the same "Start your free trial · Watch a demo" band.
    assert.equal(citedSources(CASES["wug-demo"]!.resources, CASES["wug-demo"]!.citations).length, 10);
    assert.deepEqual(shown("wug-demo"), ["Editions and Pricing - Compare Plans"]);
    assert.deepEqual(shown("wug-trial"), [], "only the band: none rather than unrelated pages");
  });

  it("keeps the German price answer to the German pricing page, never the Spanish one (whatsupgold.com)", () => {
    assert.equal(shown("wug-de-price")[0], "Preise und Lizenzierung WhatsUp Gold");
    const all = shown("wug-de-price-all");
    assert.deepEqual(all, ["Preise und Lizenzierung WhatsUp Gold"], "asked of every page: German, Spanish and English retrieved");
  });

  it('"Where can I find free coloring pages?" doesn\'t cite cards or bookmarks (crayola.com)', () => {
    assert.deepEqual(shown("cr-coloring"), ["Free Printable Coloring Pages, Sheets & Activities"]);
  });

  it('"How do I contact Crayola customer support?" doesn\'t cite the Scribble Scrubbie page (crayola.com)', () => {
    assert.deepEqual(shown("cr-support"), ["Global Support"]);
  });

  it("still cites DevCraft's own page for its price (telerik.com, Exec's regression)", () => {
    assert.equal(shown("ex-devcraft")[0], "Telerik DevCraft");
  });

  it('shows no React overview page for "Contact Support." (telerik.com, SE)', () => {
    assert.deepEqual(shown("se-support"), []);
  });

  it("keeps a comparison page that answers the comparison (the demo)", () => {
    assert.equal(shown("demo-wordpress")[0], "Compare Sitefinity to Top CMS Alternatives");
  });
});

describe("pickSources", () => {
  const page = (id: string, title: string, passages: string[], language = "en") => ({
    id,
    title,
    href: `https://acme.com/${id}`,
    passages,
    language,
  });

  it("prefers the visitor's language, and drops other languages when one in it fits", () => {
    const pages = [page("es", "Precios de WhatsUp Gold", ["Precio desde 1.229 $"], "es"), page("de", "Preise", ["Preis ab 1.229 $"], "de")];
    const ctx = { question: "Was kostet es?", answer: "Der Preis beginnt bei 1.229 $.", brand: "WhatsUp Gold" };
    assert.deepEqual(
      pickSources(pages, { ...ctx, language: "de" }).map((s) => s.title),
      ["Preise"],
    );
    // No page in the visitor's language: the others stay.
    assert.deepEqual(
      pickSources([pages[0]!], { ...ctx, language: "de" }).map((s) => s.title),
      ["Precios de WhatsUp Gold"],
    );
  });

  it("prefers a page that shares a word with the question to one that only shares words with the answer", () => {
    const pages = [page("a", "Opening hours", ["We open at 8am on weekdays."]), page("b", "Insurance", ["Most plans are accepted."])];
    assert.deepEqual(
      pickSources(pages, { question: "When are your opening hours?", answer: "We open at 8am. Most plans are accepted." }).map(
        (s) => s.title,
      ),
      ["Opening hours"],
    );
  });

  it("shows none when nothing relates to the question or the answer", () => {
    assert.deepEqual(
      pickSources([page("a", "Careers", ["Join our team."])], { question: "Do you sell bicycles?", answer: "Yes, two models." }),
      [],
    );
  });

  it("doesn't count the client's brand, or a number in the question, as a match", () => {
    assert.deepEqual([...brandWords("Sitefinity assistant")], ["sitefinity"]);
    const pages = [page("a", "Hattiesburg Clinic", ["Our network serves 300 doctors at WhatsUp Gold sites."])];
    assert.deepEqual(
      pickSources(pages, { question: "What does WhatsUp Gold cost for 300 devices?", answer: "", brand: "WhatsUp Gold" }),
      [],
    );
  });
});
