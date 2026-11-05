import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HANDOFF_VERDICTS, isAnswered } from "@launchpad/theme";
import { parseInline, parseMarkdown, plainText } from "../src/markdown.ts";
import { bestScore, MIN_RERANKER_SCORE, mayBeNoContext, NO_CONTEXT_ANSWER, showsModelText, verdict } from "../src/sources.ts";

describe("parseMarkdown", () => {
  it("reads bold, italics and lists, the way real answers use them", () => {
    // From a real Agentic RAG answer on 2026-10-30.
    assert.deepEqual(parseMarkdown("The listed contract rate is **$85–100 per hour** for this role."), [
      {
        kind: "p",
        inline: [
          { kind: "text", text: "The listed contract rate is " },
          { kind: "strong", children: [{ kind: "text", text: "$85–100 per hour" }] },
          { kind: "text", text: " for this role." },
        ],
      },
    ]);
    const blocks = parseMarkdown("All of them:\n\n- C-8QH3\n- *C-893J*\n\nAnd more.");
    assert.deepEqual(
      blocks.map((b) => b.kind),
      ["p", "ul", "p"],
    );
    assert.deepEqual(blocks[1], {
      kind: "ul",
      start: 1,
      items: [[{ kind: "text", text: "C-8QH3" }], [{ kind: "em", children: [{ kind: "text", text: "C-893J" }] }]],
    });
  });

  it("numbers lists from where they start, and joins indented lines to their item", () => {
    const [list] = parseMarkdown("3. Book\n   online\n4. Come in");
    assert.deepEqual(list, {
      kind: "ol",
      start: 3,
      items: [[{ kind: "text", text: "Book online" }], [{ kind: "text", text: "Come in" }]],
    });
  });

  it("turns headings into bold lines and keeps line breaks within a paragraph", () => {
    assert.deepEqual(
      parseMarkdown("## Hours\nMon–Fri\n9–5").map((b) => b.kind),
      ["h", "p"],
    );
    assert.deepEqual(parseMarkdown("Mon–Fri\n9–5")[0], {
      kind: "p",
      inline: [{ kind: "text", text: "Mon–Fri" }, { kind: "br" }, { kind: "text", text: "9–5" }],
    });
  });

  it("leaves arithmetic, snake_case and lone markers alone", () => {
    assert.deepEqual(parseInline("2 * 3 * 4"), [{ kind: "text", text: "2 * 3 * 4" }]);
    assert.deepEqual(parseInline("set max_page_size"), [{ kind: "text", text: "set max_page_size" }]);
    assert.deepEqual(parseInline("a ** b"), [{ kind: "text", text: "a ** b" }]);
  });

  it("holds an unclosed ** as bold while the answer streams", () => {
    assert.deepEqual(parseInline("Open **Mon", true), [
      { kind: "text", text: "Open " },
      { kind: "strong", children: [{ kind: "text", text: "Mon" }] },
    ]);
    assert.deepEqual(parseInline("Open **Mon"), [{ kind: "text", text: "Open **Mon" }]);
  });

  it("parses links for the renderer to vet, and gives plain text for screen readers", () => {
    const blocks = parseMarkdown("See [our hours](https://acme.com/hours) or `call`.");
    assert.deepEqual(blocks[0], {
      kind: "p",
      inline: [
        { kind: "text", text: "See " },
        { kind: "link", href: "https://acme.com/hours", children: [{ kind: "text", text: "our hours" }] },
        { kind: "text", text: " or " },
        { kind: "code", text: "call" },
        { kind: "text", text: "." },
      ],
    });
    assert.equal(plainText(parseMarkdown("**Hi**\n\n- a\n- b")), "Hi\na\nb");
  });
});

describe("verdict", () => {
  const strong = { score: 0.49, type: "RERANKER" };
  const cited = { "r1/t/body/0-50": [[0, 10]] };

  it("counts a cited answer with a relevant match as answered", () => {
    assert.equal(verdict({ answer: "Yes, several.", status: "success", best: strong, citations: cited }), "answered");
  });

  it("treats Agentic RAG's own no-context replies as no answer", () => {
    assert.equal(verdict({ answer: "", status: "no_retrieval_data" }), "no-context");
    assert.equal(verdict({ answer: NO_CONTEXT_ANSWER, status: "no_context", best: strong }), "no-context");
    assert.equal(verdict({ answer: NO_CONTEXT_ANSWER }), "no-context");
    assert.equal(verdict({ answer: "  " }), "empty");
  });

  it("doesn't trust an answer drawn from a weak match", () => {
    // "How much does it cost to hire through you?" on a recruiting KB: answered from an unrelated CV.
    const weak = { score: 0.0021, type: "RERANKER" };
    assert.equal(
      verdict({ answer: "The listed contract rate is $85–100 per hour.", status: "success", best: weak, citations: cited }),
      "low-relevance",
    );
    assert.equal(verdict({ answer: "Yes.", best: { score: MIN_RERANKER_SCORE, type: "RERANKER" } }), "answered");
    // Other score types aren't on a 0–1 scale.
    assert.equal(verdict({ answer: "Yes.", best: { score: 0.001, type: "BM25" } }), "answered");
  });

  it("trusts a relevant answer that Agentic RAG didn't cite", () => {
    // Real answers that sum up many pages often come back with no citations at all.
    assert.equal(verdict({ answer: "Several candidates are based in Texas.", best: strong, citations: {} }), "answered");
  });

  it("counts an uncited answer as no answer when there's no relevance score, but keeps its words", () => {
    const v = verdict({ answer: "Several of our clinics offer it.", best: { score: 0.03, type: "BOTH" }, citations: {} });
    assert.equal(v, "uncited");
    assert.ok(showsModelText(v));
    // Saying the site lacks it, with nothing concrete: it may not answer, shown as written with the
    // handoff (round 4's "declined", round 5's negative claim).
    const declined = verdict({ answer: "I couldn't find that; please call us.", best: { score: 0.03, type: "BOTH" }, citations: {} });
    assert.equal(declined, "may-not-answer");
    assert.ok(showsModelText(declined));
    assert.ok(!showsModelText("low-relevance"));
    // No citations item at all: citations are off for this KB, so nothing to judge.
    assert.equal(verdict({ answer: "Yes.", best: { score: 0.03, type: "BOTH" } }), "answered");
  });

  it("holds back the start of the no-context sentence while it streams", () => {
    assert.ok(mayBeNoContext("Not enough"));
    assert.ok(!mayBeNoContext("Not every clinic"));
    assert.ok(!mayBeNoContext(""));
  });

  it("finds the best-scoring paragraph across resources", () => {
    const resources = {
      a: {
        id: "a",
        fields: { "/t/text": { paragraphs: { p1: { score: 0.1, score_type: "RERANKER" }, p2: { score: 0.4, score_type: "RERANKER" } } } },
      },
      b: { id: "b", fields: { "/t/text": { paragraphs: { p3: { score: 0.2, score_type: "RERANKER" } } } } },
      c: { id: "c" },
    };
    assert.deepEqual(bestScore(resources), { score: 0.4, type: "RERANKER" });
    assert.equal(bestScore({}), undefined);
  });
});

describe("the handoff card's outcomes (round 6, item 6)", () => {
  it("shows the reply's words with the card for may-not-answer, deflection and substituted, and never counts them answered", () => {
    for (const v of HANDOFF_VERDICTS) {
      assert.equal(isAnswered(v), false, v);
      assert.equal(showsModelText(v), true, v);
    }
    assert.deepEqual([...HANDOFF_VERDICTS].sort(), ["deflection", "may-not-answer", "substituted"]);
  });
});
