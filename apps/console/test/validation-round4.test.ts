// Round 4 in validation: the shared verdict's soft no-answers and Check this signals, the intent
// questions and the decisions they need, checks carried over to a reworded answer, the run at
// half the pages, what an automatic run opened, and a starter taken off the live chat.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AskResult } from "@launchpad/par-client";
import {
  carriedOver,
  checkCarries,
  failingStarters,
  generatedAfterIntents,
  halfwayDue,
  halfwayNote,
  intentQuestions,
  judgeAnswer,
  leaksInternals,
  needsCheck,
  needsDecision,
  nothingOpen,
  openedSince,
  passedNote,
  passReasons,
  type RunQuestion,
  reviewNotes,
  runCounts,
  STARTER_FAILURE,
  sourcePassages,
  thinRun,
  type ValidationRun,
  validationPassed,
  withIntentQuestions,
  withoutStarter,
} from "../src/lib/validation-rules.ts";

const by = { by: "u1", name: "Dana Ruiz", at: "2026-10-30T14:02:00Z", verified: true };
const strong = (url: string, title: string, text: string, id = "r1") => ({
  [id]: {
    title,
    origin: { url },
    fields: { "/t/text": { paragraphs: { [`${id}/t/text/0-50`]: { score: 0.3, score_type: "RERANKER", text } } } },
  },
});
const ask = (answer: string, resources: Record<string, unknown>, cited = true): AskResult => ({
  answer,
  status: "success",
  citations: cited ? Object.fromEntries(Object.keys(resources).map((id) => [`${id}/t/text/0-50`, [[0, 5]] as [number, number][]])) : {},
  retrieval_results: { resources },
});

describe("the shared verdict in a run", () => {
  it("reads crayola.com's painted-wall reply as No answer, shown as written", () => {
    const reply =
      "We don’t have specific stain-removal steps for crayon on painted walls. Our Ultra-Clean Washable Markers and Crayons are designed to be washable from painted walls. For more help, please contact us.";
    const q = judgeAnswer(
      { question: "How do I get crayon off a painted wall?", own: true },
      ask(reply, strong("https://www.crayola.com/ultra-clean", "Ultra-Clean Products", "Washable from walls")),
    );
    assert.equal(q.answered, false);
    assert.equal(q.declined, true);
    assert.equal(q.answer, reply);
    assert.deepEqual(q.sources, []);
    // The partner's own question: it needs a decision before the run passes.
    assert.ok(needsDecision(q));
  });

  // Round 6 (item 6): a reply whose only content is a pointer is a deflection, held until a person
  // decides with a reason (it was a Check this, counted as answered, in round 4).
  it("holds telerik.com's “Contact Support.” as a deflection", () => {
    const q = judgeAnswer(
      { question: "How do I contact support?", own: false, intent: "support" },
      ask(
        "Contact Support.",
        strong("https://www.telerik.com/kendo-react-ui/components/grid", "React Grid Overview", "A data grid for React."),
      ),
      undefined,
      undefined,
      { brand: "Telerik" },
    );
    assert.equal(q.verdict, "deflection");
    assert.equal(q.answered, false);
    assert.equal(q.declined, true);
    assert.equal(q.intent, "support");
    assert.match(q.holds?.[0]?.text ?? "", /only points elsewhere/);
    assert.ok(needsCheck(q));
    assert.ok(!needsCheck({ ...q, acknowledged: { ...by, reason: "Support is by ticket only." } }));
  });

  it("matches a source by the passage it was cited for, and leaves the client's name out", () => {
    const resources = strong("https://www.telerik.com/contact", "Contact Us", "Reach our support team by phone or by ticket.");
    const q = judgeAnswer(
      { question: "How do I contact Telerik support?", own: false },
      ask("You can reach our support team by phone or by submitting a ticket.", resources),
      undefined,
      undefined,
      { brand: "Telerik" },
    );
    assert.equal(q.checks, undefined);
    assert.deepEqual(sourcePassages(ask("x", resources), [{ title: "Contact Us", url: "https://www.telerik.com/contact" }]), [
      { title: "Contact Us", url: "https://www.telerik.com/contact", text: "Reach our support team by phone or by ticket." },
    ]);
  });

  it("keeps the executive's short price answer free of Check this", () => {
    const q = judgeAnswer(
      "How much does Telerik DevCraft Complete cost?",
      ask(
        "Telerik DevCraft Complete costs $1,299.",
        strong("https://www.telerik.com/purchase.aspx", "Telerik DevCraft", "DevCraft Complete $1,299"),
      ),
      undefined,
      { expected: "en", followsVisitor: false },
      { brand: "Telerik" },
    );
    assert.deepEqual([q.answered, q.flags, q.checks], [true, ["price"], undefined]);
  });
});

describe("the intent questions", () => {
  it("asks price, contact and support always, buy and trial only where a key page exists, worded from the pages", () => {
    assert.deepEqual(
      intentQuestions([]).map((q) => [q.intent, q.question]),
      [
        // Round 5: the phrasing bank's generic wording too ("What are your prices?", the SE's).
        ["price", "What are your prices?"],
        ["price", "How much do your products cost?"],
        ["contact", "How do I contact you?"],
        ["support", "How do I contact support?"],
      ],
    );
    const telerik = intentQuestions([
      { intent: "price", url: "https://www.telerik.com/purchase.aspx", title: "Purchase Telerik" },
      { intent: "buy", url: "https://www.telerik.com/purchase/request-a-quote" },
      { intent: "contact", url: "https://www.telerik.com/contact", title: "Contact Us" },
      { intent: "trial", url: "https://www.telerik.com/try", title: "Free Trial" },
    ]);
    assert.deepEqual(
      telerik.map((q) => q.question),
      [
        "What are your prices?",
        "How much do your products cost?",
        "How do I contact sales?",
        "How do I contact support?",
        "Where can I buy your products?",
        "Can I get a free trial?",
      ],
    );
    const wug = intentQuestions([
      { intent: "price", url: "https://www.whatsupgold.com/pricing", title: "Editions and Pricing - Compare Plans" },
    ]);
    assert.equal(wug[1]?.question, "How much do your plans cost?");
    const demo = intentQuestions([
      { intent: "trial", url: "https://www.progress.com/sitefinity-cms/request-demo", title: "Request a Demo" },
    ]);
    assert.equal(demo.at(-1)?.question, "Can I book a demo?");
    // In the site's main language.
    assert.equal(intentQuestions([], "de")[2]?.question, "Wie kann ich Sie kontaktieren?");
  });

  it("leaves five generated questions however many intent questions there are (round 6)", () => {
    assert.equal(generatedAfterIntents(5), 5);
    assert.equal(generatedAfterIntents(13), 5);
  });

  it("are added to the last run's list by Bring up to date, in place of generated questions that left nothing open", () => {
    const answered = (question: string, over: Partial<RunQuestion> = {}): RunQuestion => ({
      question,
      answer: "Yes, here is how.",
      sources: [],
      answered: true,
      ...over,
    });
    const last: RunQuestion[] = [
      answered("What does Telerik UI for Blazor include?"),
      answered("How much do your products cost?"),
      answered("Which frameworks do you support?"),
      answered("Is there a free trial for Kendo UI?", { answered: false, answer: "" }),
      answered("What is new in the latest release?"),
      answered("How long is the licence?"),
      answered("Do you offer volume discounts?", { own: true }),
      answered("Where are your offices?", { own: true }),
      answered("Can I try it free?", { starter: true, starterOnly: true }),
    ];
    const intents = intentQuestions([
      { intent: "price", url: "https://www.telerik.com/purchase.aspx", title: "Purchase Telerik" },
      { intent: "contact", url: "https://www.telerik.com/contact", title: "Contact Us" },
    ]);
    const list = withIntentQuestions(last, intents);
    // The price question was asked already: it stays where it was, as the price intent.
    assert.deepEqual(
      list.map((q) => [q.question, q.intent ?? (q.own ? "own" : "generated")]),
      [
        ["What are your prices?", "price"],
        ["How do I contact sales?", "contact"],
        ["How do I contact support?", "support"],
        ["What does Telerik UI for Blazor include?", "generated"],
        ["How much do your products cost?", "price"],
        ["Which frameworks do you support?", "generated"],
        // No answer last time: it stays, since leaving it out would need a reason.
        ["Is there a free trial for Kendo UI?", "generated"],
        ["What is new in the latest release?", "generated"],
        // Round 6: five generated questions are kept, so nothing makes room.
        ["How long is the licence?", "generated"],
        ["Do you offer volume discounts?", "own"],
        ["Where are your offices?", "own"],
      ],
    );
    // Starter-only questions are left to the run, which adds every starter itself.
    assert.ok(!list.some((q) => q.question === "Can I try it free?"));
    // Nothing to add: the list as it was.
    assert.deepEqual(
      withIntentQuestions(
        last.filter((q) => !q.starterOnly),
        [],
      ).map((q) => q.question),
      last.filter((q) => !q.starterOnly).map((q) => q.question),
    );
  });
});

describe("decisions", () => {
  const q = (over: Partial<RunQuestion> = {}): RunQuestion => ({
    question: `Q${Math.random()}?`,
    answer: "A",
    sources: [],
    answered: true,
    ...over,
  });
  const base = [q(), q(), q(), q(), q({ own: true }), q({ own: true })];

  it("holds the pass for an intent or own question with No answer until someone decides", () => {
    const price = q({ question: "How much do your products cost?", intent: "price", answered: false, answer: "" });
    const run = [...base, price];
    assert.ok(!validationPassed(run));
    assert.match(
      passReasons({ at: "", passed: false, questions: run }).join(" "),
      /1 No answer to fix or mark “The site doesn't cover this” \(“How much do your products cost\?”\)/,
    );
    const decided = [...base, { ...price, notCovered: { ...by, reason: "Prices are quoted by sales" } }];
    assert.ok(validationPassed(decided));
    assert.equal(runCounts(decided).undecided.length, 0);
  });

  it("passes on a generated question with No answer, and says so", () => {
    const run: ValidationRun = { at: "", passed: true, questions: [...base, q({ question: "Do you ship to Canada?", answered: false })] };
    assert.ok(validationPassed(run.questions));
    assert.equal(passedNote(run), "Passed: 1 question with No answer and no decision");
    assert.deepEqual(reviewNotes(run).noDecision, ["Do you ship to Canada?"]);
  });

  it("holds the pass for a Check this answer until someone checks it", () => {
    const thin = q({ question: "How do I contact support?", checks: ["short"] });
    assert.ok(!validationPassed([...base, thin]));
    assert.ok(validationPassed([...base, { ...thin, acknowledged: by }]));
  });

  it("notes a price question the site doesn't cover, for Review's quote-button line", () => {
    const run: ValidationRun = {
      at: "",
      passed: true,
      questions: [...base, q({ intent: "price", answered: false, notCovered: { ...by, reason: "By quote" } })],
    };
    assert.equal(reviewNotes(run).priceNotCovered, true);
  });
});

describe("checks carried over to a reworded answer", () => {
  const line = { url: "https://www.telerik.com/purchase.aspx", title: "Purchase" };
  const checked: RunQuestion = {
    question: "How much does DevCraft cost?",
    answer: "DevCraft UI is $1,149 and DevCraft Complete is $1,299 per developer, per year.",
    sources: [],
    answered: true,
    flags: ["price"],
    figures: [
      { figure: "$1,149", kind: "price", page: line, excerpt: "DevCraft UI $1,149" },
      { figure: "$1,299", kind: "price", page: line, excerpt: "DevCraft Complete $1,299" },
    ],
    acknowledged: by,
  };

  it("keeps the check when every figure was checked against the same line: all of them, or only some", () => {
    const some: RunQuestion = {
      ...checked,
      acknowledged: undefined,
      answer: "DevCraft Complete costs $1,299 per developer per year.",
      figures: [{ figure: "$1,299", kind: "price", page: line, excerpt: "DevCraft Complete $1,299" }],
    };
    assert.ok(checkCarries(checked, some));
    assert.deepEqual(carriedOver(checked, some).acknowledged, by);
  });

  it("reopens it for a new figure, another line, or something new to check", () => {
    const fresh = { ...checked, acknowledged: undefined, answer: "Now $1,399." };
    assert.ok(
      !checkCarries(checked, { ...fresh, figures: [{ figure: "$1,399", kind: "price", page: line, excerpt: "DevCraft Complete $1,399" }] }),
    );
    assert.ok(!checkCarries(checked, { ...fresh, figures: [{ figure: "$1,299", kind: "price", page: line, excerpt: "Renewal $1,299" }] }));
    assert.ok(!checkCarries(checked, { ...checked, acknowledged: undefined, flags: ["price", "overview-sources"] }));
    assert.equal(carriedOver(checked, { ...fresh, checks: ["off-source"] }).acknowledged, undefined);
  });
});

describe("the run at half the pages", () => {
  const thin: ValidationRun = {
    at: "2026-10-30T10:00:00Z",
    passed: true,
    questions: [],
    content: { answerable: 38, total: 190, partial: true },
  };

  it("runs again by itself once half the pages are answerable, and says when", () => {
    const at = new Date("2026-10-30T10:10:00Z");
    assert.ok(thinRun(thin));
    assert.ok(!halfwayDue(thin, { answerable: 94, total: 190 }, at));
    assert.ok(halfwayDue(thin, { answerable: 95, total: 190 }, at));
    // 45 pages in 10 minutes: 12 more take about 3.
    assert.equal(
      halfwayNote(thin, { answerable: 83, total: 190 }, at),
      "Ran with 38 of 190 pages answerable. Runs again by itself at 95 of 190 pages answerable (now 83, about 3 min).",
    );
    assert.ok(!halfwayDue({ ...thin, autoTried: { at: "2026-10-30T10:05:00Z", error: "x" } }, { answerable: 95, total: 190 }, at));
    assert.ok(!thinRun({ ...thin, content: { answerable: 95, total: 190, partial: true } }));
  });
});

describe("what an automatic run opened, and when the sign-off holds", () => {
  const ok = (question: string, over: Partial<RunQuestion> = {}): RunQuestion => ({
    question,
    answer: "A",
    sources: [],
    answered: true,
    ...over,
  });

  it("lists what's newly open, and checks that were done and reopened", () => {
    const before: ValidationRun = { at: "", passed: true, questions: [ok("Price?", { flags: ["price"], acknowledged: by }), ok("Hours?")] };
    const now = [
      ok("Price?", { flags: ["price"] }),
      ok("Hours?"),
      ok("Contact sales?", { starter: true, answered: false, failure: STARTER_FAILURE }),
    ];
    assert.deepEqual(openedSince(before, now), [
      { question: "Price?", was: "A check", reopened: true },
      { question: "Contact sales?", was: `Failed: ${STARTER_FAILURE}` },
    ]);
  });

  it("holds once a run after the first sync passes with nothing open", () => {
    const questions = [ok("a?"), ok("b?"), ok("c?"), ok("d?"), ok("e?", { own: true }), ok("f?", { own: true })];
    assert.ok(nothingOpen({ at: "", passed: true, questions, content: { answerable: 190, total: 190, partial: false } }));
    assert.ok(!nothingOpen({ at: "", passed: true, questions, content: { answerable: 120, total: 190, partial: true } }));
    assert.ok(!nothingOpen({ at: "", passed: true, questions: [...questions, ok("g?", { checks: ["short"] })] }));
  });
});

describe("a starter that stopped answering", () => {
  it("finds starters with no answer, and takes one out of every language", () => {
    const run: RunQuestion[] = [
      { question: "How do I contact sales?", answer: "", sources: [], answered: false, starter: true, failure: STARTER_FAILURE },
      { question: "Can I try it free?", answer: "Yes, 30 days.", sources: [], answered: true, starter: true },
    ];
    assert.deepEqual(
      failingStarters(run).map((q) => q.question),
      ["How do I contact sales?"],
    );
    const settings = {
      starters: ["How do I contact sales?", "Can I try it free?"],
      translations: { de: { starters: ["How do I contact sales?", "Wie erreiche ich den Vertrieb?"] } },
    };
    assert.deepEqual(withoutStarter(settings, "how do I contact sales"), {
      starters: ["Can I try it free?"],
      translations: { de: { starters: ["Wie erreiche ich den Vertrieb?"] } },
    });
  });
});

describe("round 5: Check this decisions, and named intent questions", () => {
  const ok = (question: string, over: Partial<RunQuestion> = {}): RunQuestion => ({
    question,
    answer: "A",
    sources: [],
    answered: true,
    ...over,
  });
  const base = [ok("a?"), ok("b?"), ok("c?"), ok("d?"), ok("e?", { own: true }), ok("f?", { own: true })];
  const thin = ok("How do I contact support?", {
    answer: "Contact Support.",
    checks: ["short"],
    sources: [{ title: "Support", url: "https://www.telerik.com/support" }],
  });

  it("doesn't count an unchecked Check this as answered", () => {
    const c = runCounts([...base, thin]);
    assert.equal(c.answered, 6);
    assert.equal(c.counted, 7);
    assert.equal(runCounts([...base, { ...thin, acknowledged: by }]).answered, 7);
  });

  it("lets a person say the site doesn't cover a Check this answer, which decides it", () => {
    const decided = { ...thin, notCovered: { ...by, reason: "Support is by ticket only" } };
    assert.ok(!needsCheck(decided));
    assert.ok(validationPassed([...base, decided]));
    assert.equal(runCounts([...base, decided]).notCovered, 1);
  });

  it("carries a check over to the same answer, or a rewording with the same sources", () => {
    const checked = { ...thin, acknowledged: by };
    assert.deepEqual(carriedOver(checked, thin).acknowledged, by);
    assert.deepEqual(carriedOver(checked, { ...thin, answer: "Use Contact Support." }).acknowledged, by);
    assert.equal(
      carriedOver(checked, { ...thin, answer: "Use Contact Support.", sources: [{ title: "Grid", url: "https://www.telerik.com/grid" }] })
        .acknowledged,
      undefined,
    );
    // "The site doesn't cover this" holds while it's still a Check this.
    const decided = { ...thin, notCovered: { ...by, reason: "By ticket" } };
    assert.deepEqual(carriedOver(decided, thin).notCovered, decided.notCovered);
  });

  it("names the product or site in the price and buy questions when the key pages do", () => {
    const demo = [
      { intent: "price", url: "https://www.progress.com/sitefinity-cms/how-to-buy", title: "Sitefinity Pricing and Licensing Information" },
      { intent: "trial", url: "https://www.progress.com/sitefinity-cms/try-now/trial", title: "Request a Sitefinity CMS Trial" },
      { intent: "buy", url: "https://www.progress.com/sitefinity-cms/how-to-buy/request-a-quote", title: "Request a Quote" },
    ];
    // The name visitors see ("Progress") isn't in the titles; "Sitefinity" is, twice.
    const q = intentQuestions(demo, "en", "Progress");
    // Round 5: asked by name beside the generic wording, as a pair; the demo asks "How much do your
    // products cost?" again (the release check's rewording reverted).
    assert.equal(q.find((x) => x.intent === "price" && x.wording === "named")?.question, "How much does Sitefinity cost?");
    assert.ok(q.some((x) => x.question === "How much do your products cost?" && x.wording === "generic"));
    assert.equal(q.find((x) => x.intent === "buy" && x.wording === "named")?.question, "Where can I buy Sitefinity?");
    // A range of products: "How much do Telerik products cost?" (the reranker scored "your products" 0.02).
    const telerik = [
      { intent: "price", url: "https://www.telerik.com/purchase.aspx", title: "Purchase Telerik Software Development Tools" },
    ];
    assert.equal(
      intentQuestions(telerik, "en", "Telerik").find((x) => x.intent === "price" && x.wording === "named")?.question,
      "How much do Telerik products cost?",
    );
    assert.equal(
      intentQuestions(
        [{ intent: "price", url: "https://www.whatsupgold.com/de/preise", title: "Preise und Lizenzierung WhatsUp Gold" }],
        "de",
        "WhatsUp Gold",
      ).find((x) => x.intent === "price" && x.wording === "named")?.question,
      "Was kostet WhatsUp Gold?",
    );
  });
});

describe("round 5: pointing to a page isn't talking about how it works", () => {
  // whatsupgold.com's re-check (round 5): validation failed these as leaks.
  const PARTIAL = [
    "Für 300 Geräte nennt unsere Website keinen konkreten Preis. Die Preise beginnen bei 1.229 $ pro Jahr für 50 Geräte im Business-Paket, 2.049 $ für Enterprise und 3.469 $ für Enterprise Plus. Für ein Angebot für 300 Geräte kontaktieren Sie bitte unseren Vertrieb über die Seite „Preise und Lizenzierung WhatsUp Gold“.",
    "No publicamos un precio específico para 300 dispositivos. Los planes comienzan en $1,229 al año para 50 dispositivos, pero el costo para 300 dispositivos depende del plan y la configuración. Comuníquese con nuestro equipo de ventas en la página Precios de WUG para conocer las opciones y solicitar una cotización.",
    "Fordern Sie auf unserer Seite „Preise und Lizenzierung WhatsUp Gold“ ein Angebot für Ihre 300 Geräte an.",
    "Contact Sales on our Editions and Pricing – Compare Plans page for a quote tailored to 300 devices.",
  ];

  it("passes a named page, a link or our pricing page, in the widget's languages", () => {
    for (const answer of [
      ...PARTIAL,
      "Visit our Support Resources page and select **Contact Support**.",
      "Besuchen Sie die Seite [Preise](https://www.whatsupgold.com/de/preise).",
      "Consulte la página de precios.",
      "Rendez-vous sur la page Tarifs pour demander un devis.",
      "Ga naar de pagina Prijzen voor een offerte.",
      "Acesse a página Preços para pedir um orçamento.",
      "Visita la pagina Prezzi per richiedere un preventivo.",
    ]) {
      assert.ok(!leaksInternals(answer), answer);
    }
    const de = judgeAnswer(
      { question: "Was kostet WhatsUp Gold für 300 Geräte?", own: true },
      ask(
        PARTIAL[0] ?? "",
        strong("https://www.whatsupgold.com/de/preise", "Preise und Lizenzierung WhatsUp Gold", "Preis ab $ 1,229 für 50 Geräte pro Jahr"),
      ),
      undefined,
      { expected: "de", followsVisitor: true },
      { brand: "WhatsUp Gold" },
    );
    assert.deepEqual([de.answered, de.failure, de.checks], [true, undefined, undefined]);
  });

  it("still fails the text, context or provided pages the model read as its source, in the widget's languages", () => {
    for (const answer of [
      "Based on the provided text, the trial lasts 30 days.",
      "The text doesn't mention a price.",
      "The plan names are not shown in the available text.",
      "The provided pages do not state the requirements of an agency partnership program.",
      "The extracted text does not show the unit.",
      "Según el texto, abrimos a las 8.",
      "Las páginas proporcionadas no indican el precio.",
      "Die bereitgestellten Seiten nennen keinen Preis.",
      "Le texte fourni ne précise pas le prix.",
      "De verstrekte tekst vermeldt geen prijs.",
      "As páginas fornecidas não indicam o preço.",
      "Le pagine fornite non indicano il prezzo.",
    ]) {
      assert.ok(leaksInternals(answer), answer);
    }
  });

  it("allows naming the page it read, as the prompt asks (round 6)", () => {
    for (const answer of [
      "The page also shows annual billing.",
      "Our pricing page lists Basics at $9.99 per user/month.",
      "The page does not list a fixed license price; request a quote on our Request a Quote page.",
      "Die Preisseite nennt keinen Preis für 300 Geräte.",
      "La página de precios no indica el precio para 300 dispositivos.",
    ]) {
      assert.ok(!leaksInternals(answer), answer);
    }
  });
});

describe("the leak check on the reviewers' answers", () => {
  it("fails none of the accepted answers (round 6: naming the page read is allowed)", async () => {
    const { readFileSync } = await import("node:fs");
    const pairs: { kind: string; answer: string }[] = JSON.parse(
      readFileSync(new URL("../../../packages/theme/test/fixtures/round4-answers.json", import.meta.url), "utf8"),
    );
    const answers = pairs.filter((p) => p.kind === "answer");
    assert.ok(answers.length > 220);
    assert.deepEqual(
      answers.filter((p) => leaksInternals(p.answer)).map((p) => p.answer.slice(0, 72)),
      [],
    );
  });
});
