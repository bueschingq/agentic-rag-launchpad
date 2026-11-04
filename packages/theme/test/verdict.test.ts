import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  answerChecks,
  bestScore,
  declines,
  detectLanguage,
  hasConcreteDetail,
  isAnswered,
  languageFilter,
  logReplyFacts,
  MIN_RERANKER_SCORE,
  normalizeQuestion,
  questionHash,
  retrievalLanguage,
  saysSiteLacks,
  showsModelText,
  tellsToContact,
  verdict,
} from "../src/index.ts";

// The same three visits in each language: an answer from the site, an off-topic question the
// model found nothing for, and an off-topic one the model answered politely from weak matches.
const strong = { score: 0.31, type: "RERANKER" };
const weak = { score: 0.003, type: "RERANKER" };
const CASES = {
  en: { answer: "We're open 8 to 6, Monday to Friday.", polite: "We don't sell bicycles, but our team can help." },
  es: { answer: "Abrimos de 8 a 18, de lunes a viernes.", polite: "No vendemos bicicletas, pero nuestro equipo puede ayudarle." },
  de: {
    answer: "Wir haben montags bis freitags von 8 bis 18 Uhr geöffnet.",
    polite: "Wir verkaufen keine Fahrräder, aber unser Team hilft gern.",
  },
};

describe("the shared verdict", () => {
  for (const [language, c] of Object.entries(CASES)) {
    it(`gives the widget and the question log the same verdict (${language})`, () => {
      // Widget-shaped facts, as the stream gives them.
      const widget = {
        answered: verdict({ answer: c.answer, status: "success", best: strong, citations: { r1: [] } }),
        noContext: verdict({ answer: "", status: "no_context", best: strong }),
        nothing: verdict({ answer: "", status: "no_retrieval_data" }),
      };
      // Log-shaped rows for the same replies (status code, resources retrieved, answer).
      const log = {
        answered: verdict(logReplyFacts({ status: 0, resources_count: 5, answer: c.answer })),
        noContext: verdict(logReplyFacts({ status: -2, resources_count: 7, answer: "" })),
        nothing: verdict(logReplyFacts({ status: -3, resources_count: 0, answer: "" })),
      };
      assert.deepEqual(Object.values(widget).map(isAnswered), Object.values(log).map(isAnswered));
      assert.deepEqual(Object.values(widget).map(isAnswered), [true, false, false]);
    });

    it(`only the widget can catch a polite answer from weak matches (${language})`, () => {
      assert.equal(verdict({ answer: c.polite, status: "success", best: weak, citations: { r1: [] } }), "low-relevance");
      // The log has no relevance score: the same reply counts as answered there.
      assert.ok(isAnswered(verdict(logReplyFacts({ status: 0, resources_count: 6, answer: c.polite }))));
    });
  }

  it("goes by Agentic RAG's status, not the English sentence", () => {
    assert.equal(verdict({ answer: "Not enough data to answer this.", status: "no_context" }), "no-context");
    // Without a status, Agentic RAG's own sentence still says it.
    assert.equal(verdict({ answer: "Not enough data to answer this." }), "no-context");
    assert.equal(verdict({ answer: "Yes.", status: "error" }), "empty");
    assert.equal(verdict({ answer: "Yes.", best: { score: MIN_RERANKER_SCORE, type: "RERANKER" } }), "answered");
  });

  it("reads the log's status codes and retrieval count", () => {
    assert.deepEqual(logReplyFacts({ status: "0", resources_count: "8", answer: "Yes." }), { answer: "Yes.", status: "success" });
    assert.equal(logReplyFacts({ status: 0, resources_count: 0, answer: "Yes." }).status, "no_retrieval_data");
    assert.equal(logReplyFacts({ status: -1, resources_count: 3, answer: "x" }).status, "error");
    assert.equal(logReplyFacts({}).status, "no_retrieval_data");
  });

  it("finds the best paragraph in a synchronous answer's retrieval results", () => {
    const resources = {
      a: { fields: { "/t/text": { paragraphs: { p1: { score: 0.12, score_type: "RERANKER" } } } } },
      b: { fields: { "/t/text": { paragraphs: { p2: { score: 0.4, score_type: "RERANKER" }, p3: { score: "x" } } } } },
    };
    assert.deepEqual(bestScore(resources), { score: 0.4, type: "RERANKER" });
    assert.equal(bestScore({}), undefined);
  });
});

describe("questionHash", () => {
  it("is stable: the same input gives the same 16 hex digits, in every runtime", () => {
    assert.equal(questionHash("Do you sell bicycles?"), "0df96078e26f14f1");
    assert.equal(questionHash("¿Venden bicicletas?"), questionHash("¿Venden bicicletas?"));
    assert.match(questionHash(""), /^[0-9a-f]{16}$/);
  });

  it("ignores case, runs of whitespace and compatibility forms, not punctuation or accents", () => {
    const h = questionHash("Do you sell bicycles?");
    assert.equal(questionHash("  do YOU   sell\tbicycles? "), h);
    assert.equal(questionHash("Ｄｏ you sell bicycles？"), h);
    assert.notEqual(questionHash("Do you sell bicycles"), h);
    assert.notEqual(questionHash("Verkaufen Sie Fahrräder?"), questionHash("Verkaufen Sie Fahrrader?"));
    assert.equal(normalizeQuestion(" Verkaufen  Sie\nFAHRRÄDER? "), "verkaufen sie fahrräder?");
  });

  it("tells different questions apart", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 5000; i++) seen.add(questionHash(`Question number ${i}?`));
    assert.equal(seen.size, 5000);
  });
});

describe("the language of a question or answer", () => {
  // Questions and answers from the round-3 onboardings and the widget's languages.
  const SAMPLES: Record<string, string[]> = {
    en: [
      "How much does WhatsUp Gold cost?",
      "Which plan includes Network Traffic Analysis Plus?",
      "What's the difference between WhatsUp Gold Premium and Total Plus?",
      "Yes. We monitor AWS and Microsoft Azure cloud resources through their APIs.",
    ],
    de: [
      "Kann WhatsUp Gold Cisco-Switches per SNMP überwachen?",
      "Was kostet WhatsUp Gold?",
      "Ja. Wir überwachen AWS- und Azure-Cloud-Ressourcen sowie jeden über deren APIs verfügbaren Parameter.",
    ],
    es: ["¿Cuánto cuesta WhatsUp Gold?", "¿Venden bicicletas?", "Sí. Abrimos de 8 a 18, de lunes a viernes."],
    fr: ["Combien coûte WhatsUp Gold ?", "Oui, nous proposons un essai gratuit de 30 jours."],
    nl: ["Hoeveel kost WhatsUp Gold?", "Ja, we bieden een gratis proefversie van 30 dagen aan."],
    pt: ["Quanto custa o WhatsUp Gold?", "Sim, oferecemos uma avaliação gratuita de 30 dias."],
    it: ["Quanto costa WhatsUp Gold?", "Sì, offriamo una prova gratuita di 30 giorni."],
  };
  for (const [language, texts] of Object.entries(SAMPLES)) {
    it(`tells ${language}`, () => {
      for (const text of texts) assert.equal(detectLanguage(text), language, text);
    });
  }

  it("says nothing when it can't tell", () => {
    assert.equal(detectLanguage("WhatsUp Gold"), undefined);
    assert.equal(detectLanguage("Pricing?"), undefined);
    // Italian or Portuguese, too close to call.
    assert.equal(detectLanguage("Posso provare WhatsUp Gold gratis?"), undefined);
  });

  it("asks in the question's language only where the KB holds pages in several", () => {
    const held = ["en", "de", "en-us"];
    assert.equal(retrievalLanguage("Does WhatsUp Gold monitor AWS?", "de", held), "en");
    assert.equal(retrievalLanguage("Kann ich es kostenlos testen?", "en", held), "de");
    // Too short to tell: the page's language.
    assert.equal(retrievalLanguage("WhatsUp Gold?", "de", held), "de");
    // A language the KB doesn't hold, or a KB in one language: across all pages.
    assert.equal(retrievalLanguage("¿Cuánto cuesta?", "en", held), undefined);
    assert.equal(retrievalLanguage("How much is it?", "en", ["en"]), undefined);
    assert.deepEqual(languageFilter("de"), { filter_expression: { field: { prop: "language", language: "de", only_primary: true } } });
  });
});

describe("Agentic RAG's no-answer sentence in other languages", () => {
  it("is no answer whatever status came with it, in every served language", () => {
    for (const said of [
      "Not enough data to answer this.",
      "Nicht genügend Daten, um das zu beantworten.",
      "No hay suficientes datos para responder.",
      "Pas assez de données pour répondre à cette question.",
      "Non ci sono abbastanza dati per rispondere.",
      "Niet genoeg gegevens om dit te beantwoorden.",
      "Não há dados suficientes para responder.",
    ]) {
      assert.equal(verdict({ answer: said, status: "success", citations: { a: 1 } }), "no-context", said);
    }
    assert.equal(verdict({ answer: "Nicht genügend Daten? Doch: WhatsUp Gold kostet ab $1,229.", status: "success" }), "answered");
  });
});

describe("soft no-answers, thin answers and sources that don't fit", () => {
  const painted =
    "We don’t have specific stain-removal steps for crayon on painted walls. Our Ultra-Clean Washable Markers and Crayons are designed to be washable from painted walls. For more help, please contact us.";

  it("reads a reply that says the site lacks it, with nothing concrete, as may not answer: shown, but not answered (round 5: was declined)", () => {
    assert.equal(
      verdict({ answer: painted, status: "success", best: { score: 0.2, type: "RERANKER" }, citations: { r1: [] } }),
      "may-not-answer",
    );
    // The question log has no score, and the same rule applies there: the report counts it as a gap.
    assert.equal(verdict(logReplyFacts({ status: 0, resources_count: 4, answer: painted })), "may-not-answer");
    assert.equal(isAnswered("may-not-answer"), false);
    assert.equal(showsModelText("may-not-answer"), true);
    // A weak match still wins: the widget shows its own no-answer text.
    assert.equal(verdict({ answer: painted, status: "success", best: { score: 0.001, type: "RERANKER" } }), "low-relevance");
  });

  it("hears the site lacking it in the widget's seven languages", () => {
    for (const said of [
      "We don't have information about bulk discounts on our website. Please contact us.",
      "The price for that many devices isn't listed on our site.",
      "I couldn't find that on our website.",
      "Dazu haben wir leider keine Informationen. Bitte kontaktieren Sie uns.",
      "Lo siento, no tenemos información sobre eso. Contáctenos.",
      "Nous n'avons pas d'informations à ce sujet. Contactez-nous.",
      "We hebben helaas geen informatie hierover. Neem contact op met ons team.",
      "Não temos informações sobre isso. Entre em contato conosco.",
      "Non abbiamo informazioni su questo. Contattaci.",
    ]) {
      assert.ok(saysSiteLacks(said), said);
      assert.ok(declines(said), said);
    }
  });

  it("keeps a plain no, and a no with something concrete, as answers", () => {
    for (const answer of [
      "We don't sell bicycles, but our team can help.",
      "Taxes are not included.",
      "Water damage is not covered by the warranty.",
      "No. There is no setup fee.",
      "Es gibt keine Einrichtungsgebühr.",
      "No vendemos bicicletas, pero nuestro equipo puede ayudarle.",
      // Lacks it, but says how to get it: a quote, a figure, a link, a list.
      "We don't list a price for 300 devices; please request a quote.",
      "No tenemos un precio publicado para 300 dispositivos. Los planes parten de $1,229 al año.",
      "We don't have a store in Denver. See [our locations](https://example.com/locations).",
      "Our website does not provide a direct comparison. It notes that WhatsUp Gold offers application, device, server, cloud, and on-premises monitoring.",
    ]) {
      assert.equal(declines(answer), false, answer);
    }
  });

  it("knows what's concrete: a figure, a day, a free price, a quote, a link, an address, steps", () => {
    for (const text of [
      "Call 1-800-CRAYOLA.",
      "Closed on Sundays.",
      "Montags geschlossen.",
      "The trial is free.",
      "Es ist kostenlos.",
      "Pricing is by quote.",
      "Fordern Sie ein Angebot an.",
      "Visit crayola.com to shop.",
      "Write to help@example.com.",
      "- Blot the stain\n- Rinse with warm water",
    ]) {
      assert.ok(hasConcreteDetail(text), text);
    }
    for (const text of [
      "Contact Support.",
      "Please contact us for help.",
      "You may contact us.",
      "We can help connect you with the right team.",
    ]) {
      assert.equal(hasConcreteDetail(text), false, text);
    }
  });

  it("knows when a reply sends the visitor to the team, in the widget's languages", () => {
    for (const text of [
      "Contact Support.",
      "Please contact us to discuss becoming a partner.",
      "Get in touch with our sales team.",
      "Bitte kontaktieren Sie unser Vertriebsteam.",
      "Contacte con ventas para una cotización.",
      "Contactez-nous.",
      "Neem contact op met ons.",
      "Entre em contato conosco.",
      "Contattaci per un preventivo.",
    ]) {
      assert.ok(tellsToContact(text), text);
    }
    for (const text of ["Plans start at $29 per user per month.", "Our contact lenses are sold in packs of 6."]) {
      assert.equal(tellsToContact(text), false, text);
    }
  });

  it("flags a short answer with nothing concrete, and sources that share no word with the question", () => {
    const react = [{ title: "React Grid Overview" }, { title: "React Drawing Overview" }];
    assert.deepEqual(answerChecks({ question: "How do I contact support?", answer: "Contact Support.", sources: react }), [
      "short",
      "off-source",
    ]);
    assert.deepEqual(
      answerChecks({
        question: "How do I contact support?",
        answer: "Contact Support.",
        sources: [{ title: "Contact Us", text: "Support" }],
      }),
      ["short"],
    );
    // One form of the word, or another word for a price, is the same word.
    const cost = { question: "How much does WhatsUp Gold cost?", answer: "From $1,229 per year.", brand: "WhatsUp Gold" };
    assert.deepEqual(answerChecks({ ...cost, sources: [{ title: "Editions and Pricing - Compare Plans" }] }), []);
    assert.deepEqual(answerChecks({ ...cost, question: "Was kostet WhatsUp Gold?", sources: [{ title: "Preise und Lizenzierung" }] }), []);
    assert.deepEqual(
      answerChecks({
        question: "How do I get crayon off a painted wall?",
        answer: "Use a damp cloth.",
        sources: [{ title: "Crayons on Painted Walls" }],
      }),
      ["short"],
    );
  });

  it("leaves out the client's name, and doesn't judge across languages or without sources", () => {
    const facts = { question: "How much does a Crayola 24-pack cost?", answer: "A 24-pack costs $1.99." };
    // Every Crayola page says "Crayola": without the brand, the 24-pack question doesn't match this one.
    assert.deepEqual(answerChecks({ ...facts, sources: [{ title: "Crayola Experience Tickets" }] }), []);
    assert.deepEqual(answerChecks({ ...facts, sources: [{ title: "Crayola Experience Tickets" }], brand: "Crayola" }), ["off-source"]);
    // A German question answered from a source in English: a translation, not judged.
    assert.deepEqual(
      answerChecks({
        question: "Kann ich eine Demo sehen?",
        answer: "Ja, Sie können auf unserer Website eine persönliche Demo mit unseren Experten anfordern.",
        sources: [{ title: "Network Monitoring Tools", text: "See how it works with your network and your team", language: "en" }],
      }),
      [],
    );
    assert.deepEqual(
      answerChecks({ question: "How do I contact support?", answer: "Through the Contact Support form on our website.", sources: [] }),
      [],
    );
  });
});
