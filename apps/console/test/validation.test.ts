import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ValidationQuestion } from "@launchpad/db";
import {
  aboutSeconds,
  answerFigures,
  answerFlags,
  answerSources,
  answersFailed,
  chosenStarters,
  confirmationBy,
  contentFromCounts,
  draftProblem,
  estimateSeconds,
  expectedLanguage,
  figureList,
  isLegalPage,
  isOverviewPage,
  judgeAnswer,
  LEAK_FAILURE,
  LEAK_PHRASES,
  leaksInternals,
  locateFigures,
  pageSettled,
  parseGeneratedQuestions,
  partialContentNote,
  passReasons,
  questionWords,
  quotedReason,
  type RunQuestion,
  rejectQuestion,
  removedProblems,
  rerunDue,
  reviewNotes,
  runCounts,
  STARTER_FAILURE,
  sameQuestion,
  sourceToCheck,
  starterProblem,
  starterStatus,
  startersNotAsked,
  taskScore,
  unacknowledgedFlags,
  validationPassed,
  waitingOnPages,
} from "../src/lib/validation-rules.ts";

const paragraphs = (score: number) => ({ fields: { "/t/body": { paragraphs: { p: { score, score_type: "RERANKER" } } } } });
const resource = (url: string, title: string, score = 0.3) => ({ title, origin: { url }, ...paragraphs(score) });

describe("generated questions", () => {
  it("parses questions, dropping numbering, duplicates and non-questions", () => {
    const text =
      '1. What are your opening hours?\n- Do you accept new patients?\nHere are some questions:\n"What are your opening hours?"\n4) How do I book?';
    assert.deepEqual(parseGeneratedQuestions(text), ["What are your opening hours?", "Do you accept new patients?", "How do I book?"]);
  });

  it("never keeps a fallback question", () => {
    const text = [
      "What can you tell me about Complete Set of CMS Tools for Content Creators and Developers?",
      "Tell me about One CMS Unifying Content, Experiences & AI?",
      "Can you tell me about Sitefinity Cloud?",
      "How much does Sitefinity cost?",
    ].join("\n");
    assert.deepEqual(parseGeneratedQuestions(text), ["How much does Sitefinity cost?"]);
    assert.equal(rejectQuestion("What can you tell me about Pricing?"), "fallback");
  });

  it("leaves out legal, privacy, cookie, accessibility and thank-you questions", () => {
    const text = [
      "What is your privacy policy?",
      "How do I change my cookie settings?",
      "Where can I read your accessibility statement?",
      "What are your terms of use?",
      "What happens after the thank-you page?",
      "Wie finde ich die Datenschutzerklärung?",
      "Can I book a Sitefinity demo?",
    ].join("\n");
    assert.deepEqual(parseGeneratedQuestions(text), ["Can I book a Sitefinity demo?"]);
  });

  it("drops a question that asks what a chosen starter or another generated one does", () => {
    // kemptechnologies.com: generated beside the chosen starter "Can I start a 30-day free trial?".
    assert.ok(sameQuestion("How do I start a 30-day free trial?", "Can I start a 30-day free trial?"));
    assert.ok(sameQuestion("How much does LoadMaster cost?", "What does LoadMaster cost?"));
    assert.ok(sameQuestion("How can I contact support?", "How do I contact support?"));
    assert.ok(sameQuestion("Wie kann ich eine kostenlose Testversion starten?", "Kann ich eine kostenlose Testversion starten?"));
    assert.ok(!sameQuestion("How do I contact support?", "How do I contact sales?"));
    assert.ok(!sameQuestion("What is LoadMaster?", "How much does LoadMaster cost?"));
    assert.ok(!sameQuestion("Is there a free trial?", "Can I extend my free trial?"));
    assert.deepEqual(questionWords("How do I start a 30-day free trial?"), ["start", "day", "free", "trial"]);
    const text = [
      "How do I start a 30-day free trial?",
      "How do I contact support?",
      "How can I contact support?",
      "What does LoadMaster cost?",
      "How do I contact sales?",
    ].join("\n");
    assert.deepEqual(parseGeneratedQuestions(text, 4, 150, ["Can I start a 30-day free trial?"]), [
      "How do I contact support?",
      "What does LoadMaster cost?",
      "How do I contact sales?",
    ]);
  });

  it("leaves out questions about the chatbot's own material", () => {
    assert.equal(rejectQuestion("What does the context say about pricing?"), "meta");
    assert.equal(rejectQuestion("What is mentioned on this page about support?"), "meta");
    assert.equal(rejectQuestion("How do I contact support?"), undefined);
  });

  it("prefers visitor-task pages and skips legal pages when choosing what to generate from", () => {
    assert.ok(taskScore({ url: "https://www.progress.com/sitefinity-cms/how-to-buy", title: "How to buy" }) > 0);
    assert.ok(
      taskScore({ url: "https://a.example/pricing", title: "Pricing" }) > taskScore({ url: "https://a.example/about", title: "About" }),
    );
    assert.ok(isLegalPage({ url: "https://www.crayola.com/privacy-policy", title: "Privacy Policy" }));
    assert.ok(isLegalPage({ url: "https://a.example/legal/terms", title: null }));
    assert.ok(isLegalPage({ url: "https://a.example/forms/thank-you", title: "Thank You" }));
    assert.ok(!isLegalPage({ url: "https://a.example/products/markers", title: "Markers" }));
  });
});

describe("the leak check", () => {
  it("fails answers that talk about how the chatbot works, in the served languages", () => {
    for (const answer of [
      "The guide in the context covers alcohol markers for adults.",
      "The context does not specify which edition suits 300 devices.",
      "Based on the provided text, the trial lasts 30 days.",
      "According to the documents provided, support is 24/7.",
      "Not enough data to answer this. Please contact us.",
      "El contexto no indica el precio.",
      "Según los documentos proporcionados, abrimos a las 8.",
      "Der Kontext enthält keine Preise.",
      "Laut dem bereitgestellten Text gibt es eine Testversion.",
      "Le contexte ne précise pas la date.",
      "Il contesto non specifica il prezzo.",
      "De context vermeldt geen prijs.",
      "O contexto não menciona o preço.",
    ])
      assert.ok(leaksInternals(answer), answer);
  });

  it("allows ordinary uses of the word", () => {
    for (const answer of [
      "In the context of headless CMS, Sitefinity serves content through APIs.",
      "Sitefinity provides personalization out of the box.",
      "Im Kontext von Headless-CMS liefert Sitefinity Inhalte über APIs.",
      "We're open 8 to 6, Monday to Friday.",
    ])
      assert.ok(!leaksInternals(answer), answer);
  });

  it("marks the answer failed with the reason, as the widget shows it", () => {
    const q = judgeAnswer("What markers do you have for adults?", {
      answer: "The guide in the context covers alcohol markers.",
      status: "success",
      citations: { r1: [] },
      retrieval_results: { resources: { r1: resource("https://www.crayola.com/blog/alcohol-markers", "Alcohol markers") } },
    });
    assert.equal(q.answered, true);
    assert.equal(q.failure, LEAK_FAILURE);
  });
});

describe("answers to check against the site", () => {
  const plain = [{ url: "https://a.example/devcraft", overview: false }];
  it("flags prices and currency amounts", () => {
    for (const answer of [
      "DevCraft Complete costs $1,499 per developer.",
      "It's 1.299 € per year.",
      "Plans start at USD 99 a month.",
      "The licence is 250 euros.",
      "From £45.",
    ])
      assert.deepEqual(answerFlags(answer, plain), ["price"], answer);
  });

  it("flags dates and deadlines", () => {
    for (const answer of [
      "The next webinar is on 12 November 2026.",
      "Join us on March 15 for the release webinar.",
      "Registration closes on 2026-11-30.",
      "Das Webinar findet am 15. März statt.",
      "El seminario es el 15 de marzo.",
      "The application deadline is next Friday.",
    ])
      assert.deepEqual(answerFlags(answer, plain), ["date"], answer);
  });

  it("leaves ordinary answers alone", () => {
    for (const answer of [
      "We're open 8 to 6, Monday to Friday.",
      "Sitefinity 15.4 supports headless delivery.",
      "You may contact our sales team for a quote.",
      "We have offices in 16 countries.",
    ])
      assert.deepEqual(answerFlags(answer, plain), [], answer);
  });

  it("flags an answer whose sources are all overview pages", () => {
    assert.ok(isOverviewPage({ url: "https://a.example/", title: "Welcome" }));
    assert.ok(isOverviewPage({ url: "https://a.example/blog", title: "Blog Listing" }));
    assert.ok(isOverviewPage({ url: "https://a.example/tag/markers", title: "Markers" }));
    assert.ok(isOverviewPage({ url: "https://a.example/company", title: "About" }));
    assert.ok(isOverviewPage({ url: "https://a.example/x", title: "X" }, true));
    assert.ok(!isOverviewPage({ url: "https://a.example/products/markers", title: "Alcohol markers" }));
    assert.deepEqual(answerFlags("We make markers.", [{ url: "https://a.example/", overview: true }]), ["overview-sources"]);
    assert.deepEqual(
      answerFlags("We make markers.", [
        { url: "https://a.example/", overview: true },
        { url: "https://a.example/markers", overview: false },
      ]),
      [],
    );
  });

  it("flags with the source page linked", () => {
    const q = judgeAnswer("How much is DevCraft Complete for 5 developers?", {
      answer: "DevCraft Complete is $1,499 per developer, so $7,495 for five.",
      status: "success",
      citations: { r1: [] },
      retrieval_results: { resources: { r1: resource("https://www.telerik.com/purchase/devcraft", "Purchase DevCraft") } },
    });
    assert.deepEqual(q.flags, ["price"]);
    assert.equal(q.sources[0]?.url, "https://www.telerik.com/purchase/devcraft");
  });
});

describe("one judge", () => {
  it("judges like the widget: status and reranker score, not the English sentence", () => {
    const noContext = judgeAnswer("Do you sell bicycles?", {
      answer: "Not enough data to answer this.",
      status: "no_context",
      retrieval_results: { resources: { r1: resource("https://a.example/1", "One", 0.4) } },
    });
    assert.equal(noContext.answered, false);
    assert.equal(noContext.answer, "");
    assert.equal(noContext.failure, undefined);
    const weak = judgeAnswer("What's the weather in Boston today?", {
      answer: "We can't help with weather, but our team can help with Sitefinity.",
      status: "success",
      citations: {},
      retrieval_results: { resources: { r1: resource("https://a.example/1", "One", 0.004) } },
    });
    assert.equal(weak.answered, false);
    const good = judgeAnswer(
      { question: "Is there a trial?", own: true },
      {
        answer: "Yes: a 30-day trial.",
        status: "success",
        citations: {},
        retrieval_results: { resources: { r1: resource("https://a.example/trial", "Trial", 0.3) } },
      },
    );
    assert.equal(good.answered, true);
    assert.equal(good.own, true);
  });

  it("takes cited sources first, with http links only", () => {
    const result = {
      answer: "x",
      citations: { "r2/t/body/0-10": [[0, 10]] as [number, number][] },
      retrieval_results: {
        resources: {
          r1: { title: "One", origin: { url: "https://a.example/1" } },
          r2: { title: "Two", origin: { url: "https://a.example/2" } },
        },
      },
    };
    assert.deepEqual(answerSources(result), [{ title: "Two", url: "https://a.example/2" }]);
  });
});

describe("passing", () => {
  const q = (over: Partial<ValidationQuestion> = {}): ValidationQuestion => ({
    question: "Q?",
    answer: "A",
    sources: [{ title: "t", url: "https://a.example/" }],
    answered: true,
    ...over,
  });
  const six = [q(), q(), q(), q(), q({ own: true }), q({ own: true })];
  const by = { by: "u1", name: "Dana Ruiz", at: "2026-10-30T14:02:00Z", verified: true };

  it("needs two of the partner's own questions", () => {
    assert.ok(validationPassed(six));
    assert.ok(!validationPassed([q(), q(), q(), q(), q(), q({ own: true })]));
    assert.ok(!validationPassed(six.slice(0, 4)));
  });

  it("needs most of them answered, and nothing failing", () => {
    assert.ok(validationPassed(six.map((x, i) => (i === 0 ? { ...x, answered: false } : x))));
    assert.ok(!validationPassed(six.map((x, i) => (i < 2 ? { ...x, answered: false } : x))));
    assert.ok(!validationPassed(six.map((x, i) => (i === 0 ? { ...x, failure: LEAK_FAILURE } : x))));
  });

  it("can't pass until every flagged answer is acknowledged", () => {
    const flagged = six.map((x, i) => (i === 0 ? { ...x, flags: ["price" as const] } : x));
    assert.ok(!validationPassed(flagged));
    assert.equal(unacknowledgedFlags({ at: "", passed: false, questions: flagged }), 1);
    const checked = flagged.map((x, i) => (i === 0 ? { ...x, acknowledged: by } : x));
    assert.ok(validationPassed(checked));
    assert.equal(unacknowledgedFlags({ at: "", passed: true, questions: checked }), 0);
  });

  it("says on the Run button what's missing", () => {
    const gen = [1, 2, 3, 4].map((n) => ({ question: `Generated ${n}?`, own: false }));
    assert.equal(draftProblem([]), "Generate questions first");
    assert.equal(draftProblem(gen), "Add 2 of your own questions");
    assert.equal(draftProblem([...gen, { question: "Mine?", own: true }]), "Add 1 of your own question");
    assert.equal(
      draftProblem([...gen, { question: "Mine?", own: true }, { question: "How much does … cost?", own: true }]),
      "Finish the questions marked …",
    );
    assert.equal(draftProblem([...gen, { question: "Mine?", own: true }, { question: "Also mine?", own: true }]), undefined);
    // Fewer generated: the partner fills up to six.
    assert.equal(
      draftProblem([...gen.slice(0, 2), { question: "Mine?", own: true }, { question: "Also mine?", own: true }]),
      "Add 2 of your own questions",
    );
  });
});

describe("who confirmed it", () => {
  it("records the signed-in person, or a typed name in setup mode", () => {
    const named = confirmationBy({ id: "u1", name: "Dana Ruiz", setupMode: false });
    assert.ok(!("error" in named) && named.verified && named.name === "Dana Ruiz" && named.by === "u1");
    assert.ok("error" in confirmationBy({ id: null, name: "Setup admin", setupMode: true }, "  "));
    const typed = confirmationBy({ id: null, name: "Setup admin", setupMode: true }, "Sam Lee");
    assert.ok(!("error" in typed) && !typed.verified && typed.name === "Sam Lee" && typed.by === null);
  });

  it("shows starters nobody chose as Check this", () => {
    assert.equal(starterStatus({ widgetSettings: { starters: ["How much?"] }, confirmations: {} }), "check");
    assert.equal(starterStatus({ widgetSettings: {}, confirmations: {} }), "none");
    assert.equal(
      starterStatus({
        widgetSettings: { starters: ["How much?"] },
        confirmations: { starters: { by: null, name: "Sam", at: "", verified: false } },
      }),
      "confirmed",
    );
  });
});

describe("the answer's language", () => {
  const answered = (answer: string) => ({
    answer,
    status: "success",
    citations: { r1: [] },
    retrieval_results: { resources: { r1: resource("https://www.whatsupgold.com/cloud-monitoring", "Cloud monitoring") } },
  });
  // The same visit in every language the widget serves: the right answer, and one in German.
  const VISITS = [
    { lang: "en", q: "Does WhatsUp Gold monitor AWS and Azure?", a: "Yes. We monitor AWS and Azure resources through their APIs." },
    { lang: "es", q: "¿WhatsUp Gold supervisa AWS y Azure?", a: "Sí. Supervisamos los recursos de AWS y Azure con sus API." },
    {
      lang: "fr",
      q: "Est-ce que WhatsUp Gold surveille AWS et Azure ?",
      a: "Oui, nous surveillons les ressources AWS et Azure avec leurs API.",
    },
    { lang: "nl", q: "Kan WhatsUp Gold AWS en Azure bewaken?", a: "Ja, we bewaken AWS- en Azure-resources via hun koppelingen." },
    {
      lang: "pt",
      q: "O WhatsUp Gold pode monitorar a AWS e o Azure?",
      a: "Sim, monitoramos os recursos da AWS e do Azure com as suas APIs.",
    },
    { lang: "it", q: "WhatsUp Gold può monitorare AWS e Azure?", a: "Sì, monitoriamo le risorse AWS e Azure con le loro API." },
  ] as const;
  const german = "Ja. Wir überwachen AWS- und Azure-Cloud-Ressourcen über deren APIs.";

  for (const v of VISITS) {
    it(`fails an answer in another language than the question (${v.lang})`, () => {
      assert.equal(expectedLanguage(v.q, "auto"), v.lang, v.q);
      const right = judgeAnswer(v.q, answered(v.a), undefined, { expected: v.lang, followsVisitor: true });
      assert.equal(right.failure, undefined, v.a);
      const wrong = judgeAnswer(v.q, answered(german), undefined, { expected: v.lang, followsVisitor: true });
      assert.equal(wrong.answered, true);
      assert.match(wrong.failure ?? "", /^Answered in German, asked in /);
      assert.ok(!validationPassed([wrong, ...Array.from({ length: 6 }, () => ({ ...right, own: true }))]));
    });
  }

  it("fails German answers to English questions, as on whatsupgold.com; German to German passes", () => {
    const q = judgeAnswer("Does WhatsUp Gold monitor AWS and Azure cloud resources?", answered(german), undefined, {
      expected: "en",
      followsVisitor: true,
    });
    assert.equal(q.failure, "Answered in German, asked in English");
    const de = judgeAnswer("Kann WhatsUp Gold Cisco-Switches per SNMP überwachen?", answered(german), undefined, {
      expected: "de",
      followsVisitor: true,
    });
    assert.equal(de.failure, undefined);
  });

  it("holds a deployment in one language to that language, and keeps the leak check", () => {
    assert.equal(expectedLanguage("Kann ich es testen?", "en"), "en");
    assert.equal(expectedLanguage("WhatsUp Gold?", "auto"), undefined);
    const q = judgeAnswer("Kann ich es testen?", answered(german), undefined, { expected: "en", followsVisitor: false });
    assert.equal(q.failure, "Answered in German: this chat answers in English");
    const both = judgeAnswer(
      "Can I try it?",
      answered("Laut dem bereitgestellten Text gibt es eine Testversion, die Sie 30 Tage nutzen können."),
      undefined,
      { expected: "en", followsVisitor: true },
    );
    assert.equal(both.failure, `${LEAK_FAILURE}; Answered in German, asked in English`);
  });
});

describe("the page to check a flagged figure against", () => {
  // whatsupgold.com, 2026-10-30: the first source (Network Discovery) shows another price.
  const paragraph = (text: string) => ({ fields: { "/t/body": { paragraphs: { p: { score: 0.4, score_type: "RERANKER", text } } } } });
  const result = {
    answer: "The Business plan starts at $1,229 per year for 50 devices.",
    status: "success",
    citations: { "nd/t/body/0-100": [[0, 60]] as [number, number][] },
    retrieval_results: {
      resources: {
        nd: {
          title: "Network Discovery Tools",
          origin: { url: "https://www.whatsupgold.com/network-discovery" },
          // The cited passage, as Agentic RAG names it.
          fields: {
            "/t/body": {
              paragraphs: {
                "nd/t/body/0-100": { score: 0.4, score_type: "RERANKER", text: "Business starting from $ 1,169 for 50 devices" },
              },
            },
          },
        },
        pr: {
          title: "Editions and Pricing - Compare Plans",
          origin: { url: "https://www.whatsupgold.com/pricing" },
          ...paragraph("Enterprise Scale"),
        },
      },
    },
    augmented_context: { paragraphs: { "pr/t/body/1135-1522": { text: "Business starting from $ 1,229 for 50 devices, per year" } } },
  };

  it("links the page that shows the price, not the first source", () => {
    const q = judgeAnswer("How much does the Business plan cost for 50 devices?", result);
    assert.deepEqual(q.flags, ["price"]);
    assert.equal(q.sources[0]?.title, "Network Discovery Tools");
    assert.deepEqual(q.check, { title: "Editions and Pricing - Compare Plans", url: "https://www.whatsupgold.com/pricing", found: true });
  });

  it("says when no page the chatbot read shows the figure", () => {
    const q = judgeAnswer("How much is it?", { ...result, answer: "It's $999 a year.", augmented_context: undefined });
    assert.deepEqual(q.check, { title: "Network Discovery Tools", url: "https://www.whatsupgold.com/network-discovery", found: false });
  });

  it("reads figures however they're written, and dates the same way", () => {
    assert.deepEqual(answerFigures("Business: $1,229; Enterprise: 2.049 €; USD 3,469.00", ["price"]), ["1229", "2049", "3469"]);
    assert.deepEqual(answerFigures("Support ended on December 1, 2024.", ["date"]), ["2024"]);
    const check = sourceToCheck("Support ended on December 1, 2024.", ["date"], {
      retrieval_results: {
        resources: {
          x: { title: "Xamarin", origin: { url: "https://www.telerik.com/xamarin-ui" }, ...paragraph("Retired in May 2023.") },
          s: {
            title: "Silverlight",
            origin: { url: "https://www.telerik.com/products/silverlight" },
            ...paragraph("Until December 1, 2024."),
          },
        },
      },
    });
    assert.deepEqual(check, { title: "Silverlight", url: "https://www.telerik.com/products/silverlight", found: true });
  });
});

describe("“What can you tell me about …” questions in a run", () => {
  const ok = (question: string, own = false): RunQuestion => ({ question, answer: "A", sources: [], answered: true, ...(own && { own }) });
  const fallback = [
    "What can you tell me about One CMS Unifying Content, Experiences & AI?",
    "What can you tell me about Complete Set of CMS Tools for Content Creators and Developers?",
    "What can you tell me about Sitefinity CMS Features & CDP Capabilities?",
  ];

  it("counts them as neither generated nor the partner's own (the demo's run, 2026-10-30)", () => {
    // 1 generated + 3 fallback + 3 own: 7 asked and answered, but only 4 count.
    const run = [ok("How do I request a trial?"), ...fallback.map((q) => ok(q)), ok("A?", true), ok("B?", true), ok("C?", true)];
    const c = runCounts(run);
    assert.deepEqual([c.counted, c.own, c.fallback], [4, 3, 3]);
    assert.ok(!validationPassed(run));
    // Typed by the partner: still not theirs.
    const typed = judgeAnswer({ question: String(fallback[0]), own: true }, { answer: "We unify content.", status: "success" });
    assert.equal(typed.own, undefined);
    assert.equal(typed.fallback, true);
  });

  it("says so on the Run button", () => {
    const gen = ["How do I request a trial?", ...fallback].map((question) => ({ question, own: false }));
    const own = [1, 2, 3].map((n) => ({ question: `Mine ${n}?`, own: true }));
    assert.equal(draftProblem([...gen, ...own]), "Rewrite the 3 “tell me about” questions, or add 2 more");
    assert.equal(
      draftProblem([...gen.slice(0, 1), ...own, { question: "Two?", own: false }, { question: "Three?", own: false }]),
      undefined,
    );
  });

  it("are never starters, whatever their source", () => {
    for (const q of fallback) assert.ok(starterProblem(q));
    assert.equal(starterProblem("What does Sitefinity Cloud include?"), undefined);
  });
});

describe("what a run records", () => {
  const q = (over: Partial<RunQuestion> = {}): RunQuestion => ({ question: "Q?", answer: "A", sources: [], answered: true, ...over });

  it("notes partial content, for the result and the review screen", () => {
    const run = { at: "", passed: true, questions: [q()], content: { answerable: 52, total: 202, partial: true } };
    assert.equal(
      partialContentNote(run),
      "Ran on partial content: 52 of 202 pages were answerable, early in the first sync. It runs again by itself when the sync finishes.",
    );
    assert.equal(partialContentNote({ ...run, content: { answerable: 200, total: 207, partial: false } }), undefined);
    assert.equal(partialContentNote({ at: "", passed: true, questions: [] }), undefined);
  });

  it("quotes a typed reason with one full stop, never two", () => {
    assert.equal(quotedReason("Bought only from retailers."), "“Bought only from retailers.”");
    assert.equal(quotedReason(" Ask sales! "), "“Ask sales!”");
    assert.equal(quotedReason("Quoted by sales only"), "“Quoted by sales only”.");
  });

  it("counts what's answerable now as the Content card does", () => {
    // Content showed 160 of 183 while the note said "Now 106 of 188": both now come from these counts.
    const counts = { indexed: 160, queued: 15, processing: 5, failed: 3, skipped: 40, removed: 2 };
    assert.deepEqual(contentFromCounts(counts, null), { answerable: 160, total: 183, partial: true });
    assert.equal(contentFromCounts(counts, new Date("2026-10-30T20:00:00Z")).partial, false);
    assert.equal(contentFromCounts({ ...counts, queued: 0, processing: 0 }, null).partial, false);
  });

  it("tells answers that failed from flags still waiting for a person", () => {
    const six = [q(), q(), q(), q(), q({ own: true }), q({ own: true })];
    assert.ok(!answersFailed(six.map((x, i) => (i === 0 ? { ...x, flags: ["price" as const] } : x))));
    assert.ok(answersFailed(six.map((x, i) => (i === 0 ? { ...x, failure: LEAK_FAILURE } : x))));
    assert.ok(answersFailed(six.map((x, i) => (i < 2 ? { ...x, answered: false } : x))));
  });

  it("estimates a run from its size, at the last run's pace", () => {
    // Four at a time (round 6): 9 questions are 3 rounds.
    assert.equal(estimateSeconds(9), 3 * 8 + 2);
    assert.equal(estimateSeconds(8, { seconds: 12, questions: Array.from({ length: 8 }, () => q()) }), 2 * 6 + 2);
    assert.equal(aboutSeconds(26), "about 25 s");
    assert.equal(aboutSeconds(245), "about 4 min");
  });
});

describe("round 3: correct answers stop failing on their language", () => {
  const answered = (answer: string, url = "https://www.telerik.com/devcraft", title = "Telerik DevCraft") => ({
    answer,
    status: "success",
    citations: { r1: [] },
    retrieval_results: { resources: { r1: resource(url, title) } },
  });
  const english = { expected: "en" as const, followsVisitor: false };

  it("passes the executive's DevCraft answer with only its price flag to check (telerik.com)", () => {
    const q = judgeAnswer(
      { question: "How much does Telerik DevCraft Complete cost?", own: true },
      answered("Telerik DevCraft Complete costs **$1,299 per developer, per year**."),
      undefined,
      english,
    );
    assert.equal(q.failure, undefined);
    assert.equal(q.languageCheck, undefined);
    assert.deepEqual(q.flags, ["price"]);
    for (const answer of [
      "Teeth whitening costs $350 per session.",
      "Plans start at $29 per user per month.",
      "Parking: $5 per hour, $20 per day.",
    ]) {
      const judged = judgeAnswer("How much is it?", answered(answer), undefined, { expected: "en", followsVisitor: true });
      assert.equal(judged.failure, undefined, answer);
    }
  });

  it("asks a person to check a weak mismatch, never fails it", () => {
    const q = judgeAnswer(
      "Can I try it?",
      answered("Sie können die Testversion nutzen und testen. You can try it for free."),
      undefined,
      english,
    );
    assert.equal(q.failure, undefined);
    assert.equal(q.languageCheck, "It may be in German, though this chat answers in English");
    const six = Array.from(
      { length: 6 },
      (_, i): RunQuestion => ({ question: `Q${i}?`, answer: "A", sources: [], answered: true, own: i < 2 }),
    );
    assert.ok(!validationPassed([...six, q]));
    assert.equal(unacknowledgedFlags({ at: "", passed: false, questions: [q] }), 1);
    const checked = { ...q, acknowledged: { by: null, name: "Sam", at: "", verified: false } };
    assert.ok(validationPassed([...six, checked]));
    // A check isn't a failure: no alert.
    assert.ok(!answersFailed([...six, q]));
  });
});

describe("“the page” in an answer (the demo, round 3; reconciled with the prompt in round 6)", () => {
  it("fails answers that talk about the text or the provided pages they read", () => {
    for (const answer of [
      "According to the text, the trial lasts 30 days.",
      "The provided pages do not list a fixed license price.",
      "Las páginas proporcionadas no indican el precio.",
      "Die vorliegenden Seiten nennen keinen Preis.",
    ]) {
      assert.ok(leaksInternals(answer), answer);
    }
  });

  it("allows naming a page visitors can open", () => {
    for (const answer of [
      "See our Pricing page for current plans.",
      "Rates can change: link the page that gives them.",
      "Visit the page for Telerik UI for Blazor.",
      "Consulte la página de precios.",
    ]) {
      assert.ok(!leaksInternals(answer), answer);
    }
    assert.ok(LEAK_PHRASES.some((re) => re.test("Answer only from the provided context.")));
  });
});

describe("each flagged figure beside the text that states it", () => {
  // The synced text of telerik.com's "Buy UI for ASP.NET Core" page and whatsupgold.com's
  // /pricing and /cloud-monitoring, as the sync stored them on 2026-10-30 (shortened).
  const TELERIK = {
    url: "https://www.telerik.com/purchase/aspnet-core-ui",
    title: "Buy UI for ASP.NET Core",
    text: [
      "> Check out what's included in Telerik UI for ASP.NET Core.",
      "",
      "# Buy Telerik UI for ASP.NET Core",
      "",
      "##### Telerik UI for ASP.NET Core",
      "",
      "###### Subscription",
      "",
      "Everything .NET developers need to build modern, high-performance web apps faster.",
      "",
      "$ 849",
      "",
      "per developer, per year",
      "",
      "Buy Now",
      "",
      "##### DevCraft UI",
      "",
      "Get started quickly with the essential UI and AI developer tools for modern apps.",
      "",
      "$ 1,149",
      "",
      "##### DevCraft Complete",
      "",
      "Everything a team needs to build, test, report and deliver production-ready apps.",
      "",
      "$ 1,299",
    ].join("\n"),
  };
  const DEVCRAFT = {
    url: "https://www.telerik.com/devcraft",
    title: "Telerik DevCraft",
    text: "##### DevCraft UI\n\n$ 1,149\n\nAnd more.",
  };
  const PRICING = {
    url: "https://www.whatsupgold.com/pricing",
    title: "Editions and Pricing - Compare Plans",
    lang: "en",
    text: "# Pricing\n\n### Business\n\nIdeal for small to medium-sized businesses.\n\nstarting from\n\n$ 1,229 *\n\nfor 50 devices, per year\n\nContact Sales",
  };
  const CLOUD = {
    url: "https://www.whatsupgold.com/cloud-monitoring",
    title: "Cloud Monitoring Tools",
    lang: "en",
    text: "## WhatsUp Gold Licensing\n\n### Business\n\nstarting from\n\n$ 1,229\n\nfor 50 devices, per year",
  };

  it("shows the executive's $1,149 under its row label on the cited Buy page, so it reads as a bundle price", () => {
    const answer =
      "Our UI component libraries start at $849 per developer, per year. Some subscription pages list $1,149 for Telerik UI for ASP.NET Core.";
    const [p849, p1149] = locateFigures(answer, ["price"], [DEVCRAFT, TELERIK], { cited: [TELERIK.url] });
    assert.deepEqual(p1149, {
      figure: "$1,149",
      kind: "price",
      page: { title: "Buy UI for ASP.NET Core", url: TELERIK.url },
      label: "Buy Telerik UI for ASP.NET Core › DevCraft UI",
      excerpt: "$ 1,149",
      mark: [0, 7],
      more: 1,
    });
    assert.equal(p849?.excerpt, "$ 849 per developer, per year");
    assert.equal(p849?.label, "Telerik UI for ASP.NET Core › Subscription");
  });

  it("opens /pricing for whatsupgold.com's $1,229, not the cited product page", () => {
    const [f] = locateFigures("The Business plan starts at **$1,229 per year for 50 devices**.", ["price"], [CLOUD, PRICING], {
      cited: [CLOUD.url],
      language: "en",
    });
    assert.equal(f?.page?.url, "https://www.whatsupgold.com/pricing");
    assert.equal(f?.label, "Pricing › Business");
    assert.equal(f?.excerpt, "starting from $ 1,229 * for 50 devices, per year");
    assert.equal(f?.excerpt?.slice(...(f.mark ?? [0, 0])), "$ 1,229");
  });

  it("matches figures however they're written, and says when no synced page states one", () => {
    const pages = [
      { url: "https://example.com/preise", title: "Preise", text: "| Plan | Preis |\n|---|---|\n| Pro | 1.299,00 € pro Jahr |" },
    ];
    const [found, missing] = locateFigures("Pro costs $ 1,299; Max costs $7,995.", ["price"], pages);
    assert.equal(found?.page?.url, "https://example.com/preise");
    assert.equal(found?.excerpt, "Pro | 1.299,00 € pro Jahr");
    assert.equal(found?.excerpt?.slice(...(found.mark ?? [0, 0])), "1.299,00 €");
    assert.deepEqual(missing, { figure: "$7,995", kind: "price" });
    assert.equal(figureList([found, missing].filter((f) => f !== undefined)), "$ 1,299 and $7,995");
  });

  it("places a date by its day and year, in the sentence of a long paragraph", () => {
    const long = `${"Telerik keeps older products working for a while. ".repeat(4)}Support for Silverlight ends on December 1, 2024, after which no fixes ship. ${"More text follows here. ".repeat(6)}`;
    const [f] = locateFigures(
      "Support ended on December 1, 2024.",
      ["date"],
      [{ url: "https://www.telerik.com/products/silverlight", title: "Silverlight", text: long }],
    );
    assert.equal(f?.figure, "December 1, 2024");
    assert.equal(f?.excerpt, "Support for Silverlight ends on December 1, 2024, after which no fixes ship.");
    assert.equal(f?.excerpt?.slice(...(f.mark ?? [0, 0])), "December 1, 2024");
  });
});

describe("starters, checks and removals, for the review", () => {
  const q = (over: Partial<RunQuestion> = {}): RunQuestion => ({ question: "Q?", answer: "A", sources: [], answered: true, ...over });
  const who = { by: null, name: "Quinton", at: "2026-10-30T15:00:00.000Z", verified: false };

  it("fails a starter with no answer, and asks every chosen starter", () => {
    const starter = judgeAnswer(
      { question: "How do I get crayon off a wall?", own: false, starter: true },
      { answer: "", status: "no_context" },
    );
    assert.equal(starter.failure, STARTER_FAILURE);
    assert.equal(starter.starter, true);
    const settings = { starters: ["Can I try it?"], translations: { de: { starters: ["Kann ich es testen?", "can I try it?"] } } };
    assert.deepEqual(chosenStarters(settings), ["Can I try it?", "Kann ich es testen?"]);
    const run = { at: "", passed: true, questions: [q({ question: "Can I try it" })] };
    assert.deepEqual(startersNotAsked(run, chosenStarters(settings)), ["Kann ich es testen?"]);
    const six = Array.from({ length: 6 }, (_, i) => q({ question: `Q${i}?`, own: i < 2 }));
    assert.ok(validationPassed(six));
    assert.ok(!validationPassed(six, ["Can I try it?"]));
  });

  it("passes a No answer the site doesn't cover, with the reason on review", () => {
    const six = Array.from({ length: 6 }, (_, i) => q({ question: `Q${i}?`, own: i < 2 }));
    const price = q({ question: "How much is a 64-count box?", answer: "", answered: false, own: true });
    assert.ok(!validationPassed([...six.slice(0, 4), price, q({ question: "Q5?", answered: false })]));
    const decided = { ...price, notCovered: { ...who, reason: "Prices are on retailer sites only" } };
    assert.ok(validationPassed([...six.slice(0, 5), decided]));
    assert.deepEqual(reviewNotes({ at: "", passed: true, questions: [decided] }).notCovered, [
      { question: "How much is a 64-count box?", reason: "Prices are on retailer sites only", name: "Quinton", at: who.at },
    ]);
  });

  it("asks why a question with a problem left the list, however it left", () => {
    const last = {
      at: "",
      passed: false,
      questions: [
        q({ question: "How do I get crayon off a painted wall?", answer: "", answered: false, own: true }),
        q({ question: "How much is DevCraft?", flags: ["price"], own: true }),
        q({ question: "Where can I buy them?" }),
        q({ question: "Starter?", answer: "", answered: false, starter: true, starterOnly: true }),
      ],
    };
    // Reworded into another question, as the UX designer did: still a removal.
    const draft = [
      { question: "Where can I buy Crayola products?", own: true },
      { question: "Where can I buy them?", own: false },
    ];
    assert.deepEqual(removedProblems(last, draft), [
      { question: "How do I get crayon off a painted wall?", was: "No answer" },
      { question: "How much is DevCraft?", was: "A price to check" },
    ]);
    const notes = reviewNotes({
      ...last,
      removed: [{ ...who, question: "How do I get crayon off a painted wall?", was: "No answer", reason: "Not on the site" }],
    });
    assert.deepEqual(notes.removed, [
      { question: "How do I get crayon off a painted wall?", reason: "Not on the site", name: "Quinton", at: who.at, was: "No answer" },
    ]);
  });

  it("counts starters and prices as Review words them", () => {
    const notes = reviewNotes({
      at: "",
      passed: false,
      questions: [
        q({ question: "How much do the UI libraries cost?", starter: true, flags: ["price"] }),
        q({ question: "Can I try it free?", starter: true }),
        q({ question: "Where are the demos?", starter: true, flags: ["price"], acknowledged: who }),
        q({ question: "How much is DevCraft?", flags: ["price"], acknowledged: { ...who, name: "Sam" } }),
      ],
    });
    assert.equal(notes.startersAsked, 3);
    assert.equal(notes.startersAnswered, 3);
    assert.deepEqual([notes.pricesChecked, notes.pricesToCheck], [2, 1]);
    assert.deepEqual(notes.starterPrices, { checked: 1, toCheck: 1, checkedBy: ["Quinton"] });
    assert.deepEqual(notes.pricesCheckedBy, ["Quinton", "Sam"]);
  });

  it("shows failures and checks together", () => {
    const questions = [
      q({ failure: LEAK_FAILURE }),
      q({ flags: ["price"] }),
      q({ languageCheck: "It may be in German" }),
      ...Array.from({ length: 4 }, (_, i) => q({ question: `Q${i}?`, own: i < 2 })),
    ];
    assert.deepEqual(passReasons({ at: "", passed: false, questions }), [
      "1 answer failing",
      "1 price to check",
      "1 other answer to check",
    ]);
  });
});

describe("running again by itself", () => {
  const partial = { at: "2026-10-30T15:00:00.000Z", passed: false, questions: [], content: { answerable: 52, total: 202, partial: true } };
  const now = new Date("2026-10-30T15:30:00.000Z");

  it("runs again once the first sync has finished and its pages are processed, once", () => {
    const finishedAt = new Date("2026-10-30T15:28:00.000Z");
    assert.ok(!rerunDue(partial, { partial: true, processing: 30, finishedAt: null }, now));
    assert.ok(!rerunDue(partial, { partial: false, processing: 4, finishedAt }, now));
    assert.ok(rerunDue(partial, { partial: false, processing: 0, finishedAt }, now));
    // Still processing ten minutes on: run anyway.
    assert.ok(rerunDue(partial, { partial: false, processing: 4, finishedAt: new Date("2026-10-30T15:15:00.000Z") }, now));
    // The run after the sync isn't partial, so it doesn't repeat; a failed try waits.
    assert.ok(
      !rerunDue({ ...partial, content: { ...partial.content, partial: false } }, { partial: false, processing: 0, finishedAt }, now),
    );
    assert.ok(!rerunDue({ ...partial, autoTried: { at: "2026-10-30T15:20:00.000Z" } }, { partial: false, processing: 0, finishedAt }, now));
    // A partial run from days ago (before this rule) waits for a person.
    assert.ok(!rerunDue({ ...partial, at: "2026-10-27T15:00:00.000Z" }, { partial: false, processing: 0, finishedAt }, now));
  });

  it("knows which questions wait on pages added by hand", () => {
    const added = { by: null, name: "Q", at: "t", verified: false };
    const run = {
      at: "",
      passed: false,
      questions: [
        {
          question: "How do I get crayon off a painted wall?",
          answer: "",
          sources: [],
          answered: false,
          added: { ...added, urls: ["https://www.crayola.com/stain-tips/regular-crayons-on-painted-walls-stain-tip"] },
        },
        { question: "Done?", answer: "", sources: [], answered: false, added: { ...added, urls: ["u"], askedAgain: "t2" } },
      ],
    };
    assert.deepEqual(
      waitingOnPages(run).map((w) => [w.index, w.urls.length]),
      [[0, 1]],
    );
    assert.ok(pageSettled("indexed") && pageSettled("failed") && !pageSettled("queued") && !pageSettled(undefined));
  });
});
