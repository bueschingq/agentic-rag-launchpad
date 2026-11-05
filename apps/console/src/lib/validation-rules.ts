// The rules validation judges by, apart from asking: the question list (generated, the
// partner's own and the widget's starters), the leak and language checks, the price, date and
// overview flags (with each figure beside the text that states it), what passing means, every
// way past a problem (a check, "The site doesn't cover this", a removal with its reason), how
// long a run takes, and who confirmed what. Pure, so the validation panel can use it in the
// browser, the worker's jobs can use it, and it runs under node:test.

import type {
  Confirmation,
  PageFacts,
  PriceReask,
  PriceRow,
  PriceTable,
  ValidationFlag,
  ValidationQuestion,
  ValidationResult,
} from "@launchpad/db";
import type { AskResult } from "@launchpad/par-client";
import {
  type AnswerCheck,
  answerChecks,
  answerLanguage,
  askedKind,
  bestScore,
  checkPriceClaims,
  citedSources,
  confirmedTable,
  contradictionText,
  dateKeys,
  datesIn,
  detectLanguage,
  isAnswered,
  isFrame,
  type Language,
  languageName,
  languageOf,
  negativeClaim,
  pickSources,
  plainPriceQuestion,
  planNameDoubt,
  priceAmounts,
  priceReplacement,
  type RetrievedResource,
  readReply,
  relatedWords,
  showsModelText,
  strangersIn,
  type Verdict,
  type WidgetSettings,
  widgetStrings,
} from "@launchpad/theme";
import { figureValue, matchWords } from "./content-plan.ts";

// Generated from the site, typed by the partner, and the most a run asks (round 5: each intent in
// a visitor's generic wording and by name, the events questions when the site has events,
// generated ones and the partner's own: 20 at most on a single-language site, starters included).
export const GENERATED_QUESTIONS = 4;
export const OWN_QUESTIONS = 2;
export const MIN_QUESTIONS = GENERATED_QUESTIONS + OWN_QUESTIONS;
export const MAX_QUESTIONS = 20;
// Generated questions and the partner's own, at most, besides the intent questions.
export const MAX_OWN_AND_GENERATED = 12;
// The intent questions replace generated ones: 13 intent questions leave 2 generated, 4 leave 4.
// Round 6: two generated questions were too few to test the site (held-out sites): five, spread.
export const GENERATED_TARGET = 5;
export const generatedAfterIntents = (_intents: number) => GENERATED_TARGET;
// Share of the questions that must be answered (6 questions: 5).
export const PASS_SHARE = 0.75;
// The starter-question picker's guide; the widget takes up to 4 of up to 120 characters.
// Measured in the widget at 390 px: about 54 characters fit at 15 px, 50 at 16 px Arial.
export const STARTER_GUIDE = 48;
export const MAX_STARTERS = 4;
export const MAX_STARTER_LENGTH = 120;

export const LEAK_FAILURE = "Talks about how it works internally";
// §2.2: a starter is the first thing visitors click, so no answer to one is a failure.
export const STARTER_FAILURE = "No answer to a starter question";

// The questions every commercial site gets, asked in every run (round 4): price, contact and
// support always; buy and trial or demo when the site has a key page for them; events when a
// synced page states a date still to come (round 5).
export const QUESTION_INTENTS = ["price", "contact", "support", "buy", "trial", "events"] as const;
export type QuestionIntent = (typeof QUESTION_INTENTS)[number];
export const isQuestionIntent = (value: unknown): value is QuestionIntent => QUESTION_INTENTS.includes(value as QuestionIntent);

// A question in the list before the run.
export interface DraftQuestion {
  question: string;
  own: boolean;
  // One of the widget's starter questions: the run adds them itself.
  starter?: boolean;
  // One of the intent questions (QUESTION_INTENTS): it needs a decision when it gets no answer.
  intent?: QuestionIntent;
  // An intent question in a visitor's generic wording, or with the name visitors see: shown as a
  // pair, so "visitors who ask it this way get no answer" is plain.
  wording?: "generic" | "named";
}

// What a run records beyond ValidationResult, in the same jsonb column (no migration): read it
// with asRun().
export interface CheckSource {
  title: string;
  url: string;
  // false: no page the chatbot read shows the figure, so the link is only the first source.
  found: boolean;
}

// A flagged figure beside the text that states it, from the synced text of the page (see
// locateFigures).
export interface FigureCheck {
  // As the answer states it: "$1,149", "December 1, 2024".
  figure: string;
  kind: "price" | "date";
  // The synced page that states it; missing when no page we synced does.
  page?: { title: string; url: string };
  // The heading it sits under there (a pricing card's or a section's), and the sentence or
  // table row around it, the figure at `mark`.
  label?: string;
  excerpt?: string;
  mark?: [number, number];
  // How many other synced pages state it.
  more?: number;
}

// A person's way past a problem, and why.
export interface Decision extends Confirmation {
  reason: string;
}

// A typed reason in quotes, ending the sentence: “Sold by retailers.” as typed, “Sold by
// retailers”. with the full stop added, never “…retailers.”. twice over.
export const quotedReason = (reason: string) => {
  const text = reason.trim();
  return /[.!?…]$/.test(text) ? `“${text}”` : `“${text}”.`;
};

export interface RunQuestion extends ValidationQuestion {
  // The page that shows the flagged price or date, to compare the answer with.
  check?: CheckSource;
  // A "What can you tell me about …" question: asked and shown, but counted as neither
  // generated nor the partner's own, and not in the answered share.
  fallback?: true;
  // One of the widget's starter questions: asked in every run, and failed with no answer.
  starter?: true;
  // Asked only because it's a starter, not from the question list.
  starterOnly?: true;
  // Each flagged figure beside the text that states it.
  figures?: FigureCheck[];
  // What the chat shows instead of this reply (priceReplacement, as the widget does it): the table's
  // rows, or with `pointer` only the link to the pricing page (build 8).
  visitorGets?: { answer: string; pointer?: true };
  // The answer may be in another language than it should, but too little says so to fail it:
  // a person checks it, like a flag.
  languageCheck?: string;
  // "I checked it". For a figure no synced page states, where the person found it; for a held
  // answer (holds), why it's right.
  acknowledged?: Confirmation & { foundAt?: string; reason?: string };
  // No answer, and a person says the site doesn't cover it: it passes with the no-answer reply
  // and the handoff.
  notCovered?: Decision;
  // Pages added by hand for it ("Add these pages"): it's asked again once they're answerable.
  added?: Confirmation & { urls: string[]; askedAgain?: string };
  // An intent question (price, contact, support, buy, trial or demo).
  intent?: QuestionIntent;
  // No answer in the model's own words (the shared verdict's "declined"): the answer is the
  // reply visitors read, with the handoff under it.
  declined?: true;
  // Answered, but Check this (answerChecks in @launchpad/theme): very short with nothing
  // concrete, or no source about the question. Counts once a person clicks I checked it.
  checks?: AnswerCheck[];
  // wording, as in DraftQuestion.
  wording?: "generic" | "named";
  // Says what the site doesn't state, and gives content of the kind asked (the shared verdict's
  // "partly"): answered; its claim is checked against the key pages (holds).
  partly?: true;
  // The model judge's verdict and its one-line reason (lib/judge.ts).
  judge?: { verdict: JudgeVerdict; reason: string };
  // What holds the answer (round 5): a claim that something is missing or over with nothing of
  // the kind asked ("may not answer"), the judge, the key pages' facts, or an answer visitors won't
  // see. Each blocks the pass and the starter until the question is asked again and answered,
  // reworded, or a person decides with a reason (acknowledged.reason, or notCovered).
  holds?: Hold[];
  // A cited answer the chat still hides (low relevance, nothing grounded): the text visitors won't see.
  hiddenAnswer?: string;
  // For a No answer: what the key pages state that the answer didn't use, so the panel leads with it.
  keyFacts?: EvidencePage[];
  // The shared verdict (verdict() in @launchpad/theme), as the chat reaches it for the same text:
  // the same in the chat, the picker, validation and the re-run (round 6, item 6).
  verdict?: Verdict;
  // Every price it states is the confirmed price table's, for its plan, from the pricing page: no
  // price to check (round 6, item 1).
  tableMatched?: true;
  // The same against the pricing page's rows, with no table confirmed yet: a judge reading a few
  // passages doesn't hold it alone (build 8: "$1.65 per month, billed annually at $19.80", Bitwarden's
  // own line, held as mislabelling the annual price).
  pageAgrees?: true;
}

// A key page's lines, as a hold or the No answer panel shows them.
export interface EvidencePage {
  url: string;
  title?: string;
  lines: string[];
}

export interface Hold {
  // "price": the answer contradicts the confirmed price table (round 6, item 1).
  by: "claim" | "judge" | "evidence" | "hidden" | "price";
  // The panel's line: "The pricing page /how-to-buy states $59 and $189; this answer gives neither."
  text: string;
  // "check": I checked it clears it; "decide": a named decision with a reason does.
  clear: "check" | "decide";
  pages?: EvidencePage[];
  // For a price hold: the hash of the table it was checked against. A decision on it carries over
  // only while the table is the same.
  table?: string;
}

// The Check this signals in words, after "Check this against the site:".
export const CHECK_TEXT: Record<AnswerCheck, string> = {
  short: "it's very short and states nothing a visitor can act on",
  "off-source": "none of its sources is about the question",
};

// How much of the content was answerable when the run asked.
export interface ContentAtRun {
  answerable: number;
  // The pages the sync takes (waiting, processing, answerable and failed).
  total: number;
  // The first sync was still loading pages: answers can change once it finishes.
  partial: boolean;
}

// How much is answerable from the sync's page counts, counted as the Content card counts them:
// what a run records, and what the panel's "Now" compares it with.
export function contentFromCounts(
  counts: { indexed: number; queued: number; processing: number; failed: number },
  lastSyncedAt: Date | null,
): ContentAtRun {
  return {
    answerable: counts.indexed,
    total: counts.indexed + counts.queued + counts.processing + counts.failed,
    partial: !lastSyncedAt && counts.queued + counts.processing > 0,
  };
}

// A question taken out of the list after it failed, got no answer or waited for a check.
export interface Removal extends Decision {
  question: string;
  // What its last answer still owed: "No answer", "Failed: …", "A flag to check".
  was: string;
}

export interface ValidationRun extends ValidationResult {
  questions: RunQuestion[];
  content?: ContentAtRun;
  // How long asking took, for the next run's estimate.
  seconds?: number;
  // Every removal with its reason, kept from run to run until the question is asked again.
  removed?: Removal[];
  // Whether the saved prompt had the console's current answering rules, checked when an answer
  // failed on its language: the advice only says to save the prompt when it didn't.
  promptCurrent?: boolean;
  // Started by the worker, not by a person (track C's alerts and Fleet go by it): when the first
  // sync finished, once half the pages were answerable after a run on fewer, or a question asked
  // again once the pages added for it were answerable.
  auto?: "sync-finished" | "half-answerable" | "pages-added" | "pages-changed";
  // Starters the worker took off the live chat after an automatic run: no answer, twice.
  startersRemoved?: StarterRemoval[];
  // The worker's last try at running it again, so a failed try isn't repeated every minute.
  autoTried?: { at: string; error?: string };
  // When the worker last asked the live starters and intent questions again after a sync that
  // changed pages (round 5): the next sync is compared with this, not the run's own time.
  rechecked?: string;
}

export const asRun = (v: ValidationResult | null | undefined): ValidationRun | null => (v ?? null) as ValidationRun | null;

// A starter taken off the live chat by the worker (audited as deployment.starters.removed).
export interface StarterRemoval {
  question: string;
  at: string;
  // "no answer", as the alert words it.
  reason: string;
  // Which automatic run found it.
  auto: NonNullable<ValidationRun["auto"]>;
}

// What the chips insert: a stub the partner completes ("…" marks the part to fill in).
export const QUESTION_STUBS = [
  { label: "Price", text: "How much does … cost?" },
  { label: "Hours and locations", text: "Where is your nearest …, and when is it open?" },
  { label: "Contact", text: "How do I get in touch with … ?" },
  { label: "Trial or demo", text: "Can I try … for free, or book a demo?" },
  { label: "Support", text: "How do I get help with … ?" },
] as const;

export const isUnfinishedStub = (q: string) => q.includes("…");

// ---- the intent questions ----

// Each intent's question in the widget's languages, with the variants a key page's title picks:
// "sales" where the site sells (it has a price or buy page), "you" where it doesn't; a trial, a
// demo, or both; a plan, a quote or the products.
type Wording = {
  price: { products: string; plans: string; quote: string };
  contact: { sales: string; you: string };
  support: string;
  buy: string;
  trial: { trial: string; demo: string; both: string };
};
const INTENT_WORDING: Record<Language, Wording> = {
  en: {
    price: { products: "How much do your products cost?", plans: "How much do your plans cost?", quote: "How do I get a price quote?" },
    contact: { sales: "How do I contact sales?", you: "How do I contact you?" },
    support: "How do I contact support?",
    buy: "Where can I buy your products?",
    trial: { trial: "Can I get a free trial?", demo: "Can I book a demo?", both: "Can I get a free trial or demo?" },
  },
  de: {
    price: { products: "Was kosten Ihre Produkte?", plans: "Was kosten Ihre Tarife?", quote: "Wie bekomme ich ein Angebot?" },
    contact: { sales: "Wie erreiche ich den Vertrieb?", you: "Wie kann ich Sie kontaktieren?" },
    support: "Wie erreiche ich den Support?",
    buy: "Wo kann ich Ihre Produkte kaufen?",
    trial: {
      trial: "Kann ich eine kostenlose Testversion bekommen?",
      demo: "Kann ich eine Demo vereinbaren?",
      both: "Kann ich eine kostenlose Testversion oder Demo bekommen?",
    },
  },
  es: {
    price: { products: "¿Cuánto cuestan sus productos?", plans: "¿Cuánto cuestan sus planes?", quote: "¿Cómo pido un presupuesto?" },
    contact: { sales: "¿Cómo contacto con ventas?", you: "¿Cómo puedo contactarles?" },
    support: "¿Cómo contacto con soporte?",
    buy: "¿Dónde puedo comprar sus productos?",
    trial: {
      trial: "¿Puedo obtener una prueba gratuita?",
      demo: "¿Puedo pedir una demostración?",
      both: "¿Puedo obtener una prueba gratuita o una demostración?",
    },
  },
  fr: {
    price: { products: "Combien coûtent vos produits ?", plans: "Combien coûtent vos offres ?", quote: "Comment obtenir un devis ?" },
    contact: { sales: "Comment contacter le service commercial ?", you: "Comment vous contacter ?" },
    support: "Comment contacter le support ?",
    buy: "Où puis-je acheter vos produits ?",
    trial: {
      trial: "Puis-je obtenir un essai gratuit ?",
      demo: "Puis-je demander une démo ?",
      both: "Puis-je obtenir un essai gratuit ou une démo ?",
    },
  },
  nl: {
    price: { products: "Wat kosten jullie producten?", plans: "Wat kosten jullie abonnementen?", quote: "Hoe vraag ik een offerte aan?" },
    contact: { sales: "Hoe neem ik contact op met sales?", you: "Hoe kan ik contact met jullie opnemen?" },
    support: "Hoe neem ik contact op met support?",
    buy: "Waar kan ik jullie producten kopen?",
    trial: {
      trial: "Kan ik een gratis proefversie krijgen?",
      demo: "Kan ik een demo aanvragen?",
      both: "Kan ik een gratis proefversie of demo krijgen?",
    },
  },
  pt: {
    price: { products: "Quanto custam os seus produtos?", plans: "Quanto custam os seus planos?", quote: "Como peço um orçamento?" },
    contact: { sales: "Como entro em contato com vendas?", you: "Como posso entrar em contato com vocês?" },
    support: "Como entro em contato com o suporte?",
    buy: "Onde posso comprar os seus produtos?",
    trial: {
      trial: "Posso obter uma avaliação gratuita?",
      demo: "Posso pedir uma demonstração?",
      both: "Posso obter uma avaliação gratuita ou uma demonstração?",
    },
  },
  it: {
    price: {
      products: "Quanto costano i vostri prodotti?",
      plans: "Quanto costano i vostri piani?",
      quote: "Come richiedo un preventivo?",
    },
    contact: { sales: "Come contatto il reparto vendite?", you: "Come posso contattarvi?" },
    support: "Come contatto l'assistenza?",
    buy: "Dove posso acquistare i vostri prodotti?",
    trial: {
      trial: "Posso avere una prova gratuita?",
      demo: "Posso richiedere una demo?",
      both: "Posso avere una prova gratuita o una demo?",
    },
  },
};

// The intent questions with the product's or site's name ({name}): the name visitors see, as the
// key pages name it (round 5: on the demo, "How much do your products cost?" got no answer while
// "How much does Sitefinity cost?" did; on telerik.com the reranker scored the generic wording
// 0.02 and "How much do Telerik products cost?" 0.65). Both are asked, as a pair. "many": the name
// is a range of products ("Telerik Software Development Tools").
interface Named {
  price: string;
  priceMany: string;
  buy: string;
  sales: string;
  you: string;
  support: string;
  trial: string;
  demo: string;
  both: string;
  events: string;
}
const NAMED_WORDING: Record<Language, Named> = {
  en: {
    price: "How much does {name} cost?",
    priceMany: "How much do {name} products cost?",
    buy: "Where can I buy {name}?",
    sales: "How do I contact {name} sales?",
    you: "How do I contact {name}?",
    support: "How do I contact {name} support?",
    trial: "Can I get a free trial of {name}?",
    demo: "Can I book a {name} demo?",
    both: "Can I get a free trial or demo of {name}?",
    events: "When is the next {name} webinar or event?",
  },
  de: {
    price: "Was kostet {name}?",
    priceMany: "Was kosten die Produkte von {name}?",
    buy: "Wo kann ich {name} kaufen?",
    sales: "Wie erreiche ich den Vertrieb von {name}?",
    you: "Wie kann ich {name} kontaktieren?",
    support: "Wie erreiche ich den Support von {name}?",
    trial: "Kann ich {name} kostenlos testen?",
    demo: "Kann ich eine Demo von {name} vereinbaren?",
    both: "Kann ich {name} kostenlos testen oder eine Demo bekommen?",
    events: "Wann ist das nächste Webinar oder Event von {name}?",
  },
  es: {
    price: "¿Cuánto cuesta {name}?",
    priceMany: "¿Cuánto cuestan los productos de {name}?",
    buy: "¿Dónde puedo comprar {name}?",
    sales: "¿Cómo contacto con ventas de {name}?",
    you: "¿Cómo puedo contactar con {name}?",
    support: "¿Cómo contacto con el soporte de {name}?",
    trial: "¿Puedo probar {name} gratis?",
    demo: "¿Puedo pedir una demostración de {name}?",
    both: "¿Puedo probar {name} gratis o pedir una demostración?",
    events: "¿Cuándo es el próximo webinar o evento de {name}?",
  },
  fr: {
    price: "Combien coûte {name} ?",
    priceMany: "Combien coûtent les produits {name} ?",
    buy: "Où puis-je acheter {name} ?",
    sales: "Comment contacter le service commercial de {name} ?",
    you: "Comment contacter {name} ?",
    support: "Comment contacter le support de {name} ?",
    trial: "Puis-je essayer {name} gratuitement ?",
    demo: "Puis-je demander une démo de {name} ?",
    both: "Puis-je essayer {name} gratuitement ou demander une démo ?",
    events: "Quand a lieu le prochain webinaire ou événement {name} ?",
  },
  nl: {
    price: "Wat kost {name}?",
    priceMany: "Wat kosten de producten van {name}?",
    buy: "Waar kan ik {name} kopen?",
    sales: "Hoe neem ik contact op met sales van {name}?",
    you: "Hoe neem ik contact op met {name}?",
    support: "Hoe neem ik contact op met support van {name}?",
    trial: "Kan ik {name} gratis proberen?",
    demo: "Kan ik een demo van {name} aanvragen?",
    both: "Kan ik {name} gratis proberen of een demo aanvragen?",
    events: "Wanneer is het volgende webinar of evenement van {name}?",
  },
  pt: {
    price: "Quanto custa o {name}?",
    priceMany: "Quanto custam os produtos {name}?",
    buy: "Onde posso comprar o {name}?",
    sales: "Como entro em contato com vendas da {name}?",
    you: "Como entro em contato com a {name}?",
    support: "Como entro em contato com o suporte da {name}?",
    trial: "Posso experimentar o {name} gratuitamente?",
    demo: "Posso pedir uma demonstração do {name}?",
    both: "Posso experimentar o {name} gratuitamente ou pedir uma demonstração?",
    events: "Quando é o próximo webinar ou evento da {name}?",
  },
  it: {
    price: "Quanto costa {name}?",
    priceMany: "Quanto costano i prodotti {name}?",
    buy: "Dove posso acquistare {name}?",
    sales: "Come contatto il reparto vendite di {name}?",
    you: "Come posso contattare {name}?",
    support: "Come contatto l'assistenza di {name}?",
    trial: "Posso provare {name} gratuitamente?",
    demo: "Posso richiedere una demo di {name}?",
    both: "Posso provare {name} gratuitamente o richiedere una demo?",
    events: "Quando è il prossimo webinar o evento di {name}?",
  },
};

// ---- the visitor phrasing bank (round 5) ----
//
// How visitors ask each intent, in their own generic words: a fixed list, versioned, that is never
// edited to make a site pass (round 5: the release check reworded the demo's failing "How much do
// your products cost?" until it passed). Validation asks the first of each intent's list, besides
// the wording from the key pages' titles; the rest are for the release check's phrasing runs. A
// change is a new version, recorded in the release notes.
export const PHRASING_BANK_VERSION = 1;
export const PHRASING_BANK: Record<"en" | "de" | "fr" | "es", Record<QuestionIntent, readonly string[]>> = {
  en: {
    price: [
      "What are your prices?",
      "How much do your products cost?",
      "Do you have a price list?",
      "How much does it cost?",
      "What does a license cost?",
    ],
    contact: [
      "How can I contact you?",
      "How do I contact sales?",
      "What is your phone number?",
      "How can I talk to someone?",
      "What's your email address?",
    ],
    support: [
      "How do I contact support?",
      "How do I get help?",
      "Where can I get technical support?",
      "How do I open a support ticket?",
      "Is there a support phone number?",
    ],
    buy: ["Where can I buy your products?", "How do I buy?", "Can I buy online?", "Where can I order?", "Do you have resellers?"],
    trial: ["Can I get a free trial?", "Can I see a demo?", "Is there a free version?", "How do I try it?", "Can I book a demo?"],
    events: [
      "Are there any upcoming webinars or events?",
      "When is the next webinar?",
      "Do you have any events coming up?",
      "What webinars are coming up?",
      "Are there any live events soon?",
    ],
  },
  de: {
    price: [
      "Welche Preise haben Sie?",
      "Was kosten Ihre Produkte?",
      "Haben Sie eine Preisliste?",
      "Was kostet das?",
      "Was kostet eine Lizenz?",
    ],
    contact: [
      "Wie kann ich Sie kontaktieren?",
      "Wie erreiche ich den Vertrieb?",
      "Wie lautet Ihre Telefonnummer?",
      "Wie kann ich mit jemandem sprechen?",
      "Wie lautet Ihre E-Mail-Adresse?",
    ],
    support: [
      "Wie erreiche ich den Support?",
      "Wo bekomme ich Hilfe?",
      "Wo bekomme ich technischen Support?",
      "Wie eröffne ich ein Support-Ticket?",
      "Gibt es eine Support-Hotline?",
    ],
    buy: [
      "Wo kann ich Ihre Produkte kaufen?",
      "Wie kann ich kaufen?",
      "Kann ich online kaufen?",
      "Wo kann ich bestellen?",
      "Haben Sie Händler?",
    ],
    trial: [
      "Kann ich eine kostenlose Testversion bekommen?",
      "Kann ich eine Demo sehen?",
      "Gibt es eine kostenlose Version?",
      "Wie kann ich es ausprobieren?",
      "Kann ich eine Demo vereinbaren?",
    ],
    events: [
      "Gibt es demnächst Webinare oder Veranstaltungen?",
      "Wann ist das nächste Webinar?",
      "Haben Sie bald Veranstaltungen?",
      "Welche Webinare stehen an?",
      "Gibt es bald Live-Events?",
    ],
  },
  fr: {
    price: [
      "Quels sont vos prix ?",
      "Combien coûtent vos produits ?",
      "Avez-vous une liste de prix ?",
      "Combien ça coûte ?",
      "Combien coûte une licence ?",
    ],
    contact: [
      "Comment vous contacter ?",
      "Comment contacter le service commercial ?",
      "Quel est votre numéro de téléphone ?",
      "Comment parler à quelqu'un ?",
      "Quelle est votre adresse e-mail ?",
    ],
    support: [
      "Comment contacter le support ?",
      "Comment obtenir de l'aide ?",
      "Où trouver le support technique ?",
      "Comment ouvrir un ticket de support ?",
      "Y a-t-il un numéro de support ?",
    ],
    buy: [
      "Où puis-je acheter vos produits ?",
      "Comment acheter ?",
      "Puis-je acheter en ligne ?",
      "Où commander ?",
      "Avez-vous des revendeurs ?",
    ],
    trial: [
      "Puis-je obtenir un essai gratuit ?",
      "Puis-je voir une démo ?",
      "Existe-t-il une version gratuite ?",
      "Comment l'essayer ?",
      "Puis-je réserver une démo ?",
    ],
    events: [
      "Y a-t-il des webinaires ou des événements à venir ?",
      "Quand a lieu le prochain webinaire ?",
      "Avez-vous des événements prochainement ?",
      "Quels webinaires sont prévus ?",
      "Y a-t-il bientôt des événements en direct ?",
    ],
  },
  es: {
    price: [
      "¿Cuáles son sus precios?",
      "¿Cuánto cuestan sus productos?",
      "¿Tienen una lista de precios?",
      "¿Cuánto cuesta?",
      "¿Cuánto cuesta una licencia?",
    ],
    contact: [
      "¿Cómo puedo contactarles?",
      "¿Cómo contacto con ventas?",
      "¿Cuál es su número de teléfono?",
      "¿Cómo puedo hablar con alguien?",
      "¿Cuál es su correo electrónico?",
    ],
    support: [
      "¿Cómo contacto con soporte?",
      "¿Cómo obtengo ayuda?",
      "¿Dónde consigo soporte técnico?",
      "¿Cómo abro un ticket de soporte?",
      "¿Hay un teléfono de soporte?",
    ],
    buy: [
      "¿Dónde puedo comprar sus productos?",
      "¿Cómo compro?",
      "¿Puedo comprar en línea?",
      "¿Dónde puedo hacer un pedido?",
      "¿Tienen distribuidores?",
    ],
    trial: [
      "¿Puedo obtener una prueba gratuita?",
      "¿Puedo ver una demostración?",
      "¿Hay una versión gratuita?",
      "¿Cómo puedo probarlo?",
      "¿Puedo reservar una demostración?",
    ],
    events: [
      "¿Hay próximos webinars o eventos?",
      "¿Cuándo es el próximo webinar?",
      "¿Tienen eventos próximamente?",
      "¿Qué webinars hay programados?",
      "¿Hay eventos en directo pronto?",
    ],
  },
};
const bankFor = (language: Language) => PHRASING_BANK[language as keyof typeof PHRASING_BANK];
// The events question in the languages the bank doesn't hold.
const EVENTS_GENERIC: Record<Language, string> = {
  en: "Are there any upcoming webinars or events?",
  de: "Gibt es demnächst Webinare oder Veranstaltungen?",
  es: "¿Hay próximos webinars o eventos?",
  fr: "Y a-t-il des webinaires ou des événements à venir ?",
  nl: "Zijn er binnenkort webinars of evenementen?",
  pt: "Há webinars ou eventos em breve?",
  it: "Ci sono webinar o eventi in programma?",
};

// Words in key page titles that are no product's name.
const TITLE_WORDS = new Set(
  (
    "a an and the of for to our your with how get getting started request free trial trials demo demos price prices pricing " +
    "plans plan buy purchase purchasing order quote quotes contact support help faq information licensing license licenses " +
    "editions edition compare software development tools products product cms online store shop page us now today new " +
    "preise preis lizenzierung und kaufen precios precio comprar prueba prix tarifs acheter essai prijzen kopen preços comprar prezzi acquista"
  ).split(" "),
);
const RANGE = /\b(?:products|tools|components|controls|solutions|apps|suites?|produkte|productos|produits|producten|produtos|prodotti)\b/i;
const escapeName = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// The one product or site the price, buy and trial key pages name: the name visitors see (or its
// first word) when a title has it, else a name two titles or more share ("Sitefinity Pricing and
// Licensing Information", "Request a Sitefinity CMS Trial"). Undefined when there's no clear one.
export function productName(pages: readonly IntentPage[], brand?: string): { name: string; many: boolean } | undefined {
  const titles = pages.filter((p) => ["price", "buy", "trial"].includes(p.intent) && p.title?.trim()).map((p) => (p.title ?? "").trim());
  if (!titles.length) return undefined;
  const has = (name: string) => titles.filter((t) => new RegExp(`(?<![\\p{L}\\p{N}])${escapeName(name)}(?![\\p{L}\\p{N}])`, "iu").test(t));
  const many = (name: string) => has(name).some((t) => RANGE.test(t));
  const forms = brand?.trim() ? [brand.trim(), brand.trim().split(/\s+/)[0] ?? ""].filter((x) => x.length >= 3) : [];
  for (const form of forms) if (has(form).length) return { name: form, many: many(form) };
  const counts = new Map<string, number>();
  for (const t of titles) {
    const seen = new Set((t.match(/\p{Lu}[\p{L}\p{N}]+/gu) ?? []).filter((w) => !TITLE_WORDS.has(w.toLowerCase())));
    for (const w of seen) counts.set(w, (counts.get(w) ?? 0) + 1);
  }
  const ranked = [...counts.entries()].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]);
  const [top, next] = ranked;
  if (!top || (next && next[1] === top[1])) return undefined;
  return { name: top[0], many: many(top[0]) };
}

// A key page as track A's keyPages() gives it.
export interface IntentPage {
  intent: string;
  url: string;
  title?: string;
}

// The intent questions for a site, in its main language, worded from its key pages' titles and
// addresses where they say something ("Editions and Pricing - Compare Plans": the plans;
// "Request a Demo": a demo): price, contact and support always, buy and trial or demo only when
// the site has a key page for them.
export interface IntentQuestion {
  question: string;
  intent: QuestionIntent;
  wording: "generic" | "named";
  // Asked in a further language the widget serves.
  language?: Language;
}

// The intent questions for a site in one language (round 5): each intent in a visitor's generic
// wording (the phrasing bank's first, and for price also the wording the key pages' titles pick:
// "How much do your plans cost?"), and with the name visitors see (the product the key pages name,
// else the client's), as a pair. Price, contact and support always; buy and trial or demo only
// when the site has a key page for them; events when a synced page states a date still to come.
export function intentQuestions(
  pages: readonly IntentPage[],
  language: Language = "en",
  // The name visitors see.
  brand?: string,
  opts: { events?: boolean } = {},
): IntentQuestion[] {
  const w = INTENT_WORDING[language] ?? INTENT_WORDING.en;
  const bank = bankFor(language);
  const product = productName(pages, brand);
  const name = product?.name ?? (brand?.trim() || undefined);
  const nw = NAMED_WORDING[language] ?? NAMED_WORDING.en;
  // "a {name}" before a vowel sound is "an" ("Can I book an Acumatica demo?", round 7).
  const withName = (text: string) =>
    text
      .replace(/\ba \{name\}/, name && /^[aeiou]/i.test(name) && !/^(?:uni|use|eu|one)/i.test(name) ? "an {name}" : "a {name}")
      .replace("{name}", name ?? "");
  const of = (intent: string) => pages.filter((p) => p.intent === intent);
  const words = (intent: string) =>
    of(intent)
      .map((p) => `${p.title ?? ""} ${p.url}`)
      .join(" ")
      .toLowerCase();
  const price = words("price");
  const trial = words("trial");
  const sells = of("price").length > 0 || of("buy").length > 0;
  const out: IntentQuestion[] = [];
  const add = (intent: QuestionIntent, wording: "generic" | "named", question: string | undefined) => {
    if (question && !out.some((q) => questionKey(q.question) === questionKey(question))) out.push({ question, intent, wording });
  };
  add("price", "generic", bank?.price[0]);
  add(
    "price",
    "generic",
    /\bplans?\b|tarif|abonnement|plan(?:es|os|i)\b/.test(price)
      ? w.price.plans
      : /quote|angebot|presupuesto|devis|offerte|orçamento|preventivo/.test(price) && !/pric|preis|precio|prix|prij|preço|prezz/.test(price)
        ? w.price.quote
        : w.price.products,
  );
  if (name) add("price", "named", withName(product?.many ? nw.priceMany : nw.price));
  const toSales = sells || /sales|vertrieb|ventas|commercial|verkoop|vendas|vendite/.test(words("contact"));
  add("contact", "generic", toSales ? w.contact.sales : w.contact.you);
  if (name) add("contact", "named", withName(toSales ? nw.sales : nw.you));
  add("support", "generic", w.support);
  if (name) add("support", "named", withName(nw.support));
  if (of("buy").length) {
    add("buy", "generic", w.buy);
    if (name && !product?.many) add("buy", "named", withName(nw.buy));
  }
  if (of("trial").length) {
    const demo = /demo/.test(trial);
    const tried = /trial|try|test|prueba|essai|proef|teste|prova/.test(trial);
    const kind = demo && !tried ? "demo" : tried && !demo ? "trial" : "both";
    add("trial", "generic", w.trial[kind]);
    if (name) add("trial", "named", withName(nw[kind]));
  }
  if (opts.events) {
    add("events", "generic", bank?.events[0] ?? EVENTS_GENERIC[language]);
    add("events", "named", name ? withName(nw.events) : (bank?.events[1] ?? EVENTS_GENERIC[language]));
  }
  return out;
}

// In each further language the widget serves, the generic price and contact questions (round 5:
// Kemp's German, French and Spanish pricing pages, each with its own figures).
export function languageIntentQuestions(pages: readonly IntentPage[], languages: readonly Language[]): IntentQuestion[] {
  return languages.flatMap((language) =>
    intentQuestions(pages, language)
      .filter((q) => q.wording === "generic" && (q.intent === "price" || q.intent === "contact"))
      .filter((q, i, all) => all.findIndex((x) => x.intent === q.intent) === i)
      .map((q) => ({ ...q, language })),
  );
}

// The intent questions a list keeps within MAX_QUESTIONS with the partner's own, the generated ones
// and the starters it adds: named contact, support, trial and buy questions go first, then the
// second generic price wording. Never the generic price question, nor the events ones.
export function withinQuestionLimit(intents: readonly IntentQuestion[], room: number): IntentQuestion[] {
  const drop = [
    (q: IntentQuestion) => q.intent === "contact" && q.wording === "named",
    (q: IntentQuestion) => q.intent === "support" && q.wording === "named",
    (q: IntentQuestion) => q.intent === "trial" && q.wording === "named",
    (q: IntentQuestion) => q.intent === "buy" && q.wording === "named",
    (q: IntentQuestion) => q.intent === "events" && q.wording === "named",
    (q: IntentQuestion) => Boolean(q.language) && q.intent === "contact",
    (q: IntentQuestion) => q.intent === "price" && q.wording === "named",
  ];
  let kept = [...intents];
  for (const rule of drop) {
    for (let at = kept.findLastIndex(rule); kept.length > room && at >= 0; at = kept.findLastIndex(rule)) {
      kept = kept.filter((_, i) => i !== at);
    }
  }
  return kept;
}

// ---- generated questions ----

// Pages no visitor task starts from: legal, privacy, cookies, accessibility statements and
// thank-you pages. Their questions ("What is your privacy policy?") test nothing a visitor needs.
const LEGAL =
  /\b(privacy|cookies?|gdpr|ccpa|terms (?:of|and) (?:use|service|conditions)|terms|legal|disclaimer|imprint|impressum|datenschutz[a-zäöüß]*|privacidad|aviso legal|mentions l[ée]gales|accessibility statement|accessibility|personal data|data protection|thank[ -]?you|thanks for|confirmation|unsubscribe)\b/i;
const LEGAL_PATH =
  /\/(privacy|cookies?|gdpr|terms|legal|disclaimer|imprint|impressum|datenschutz|accessibility|thank-?you|thanks|confirmation|success|unsubscribe)([-/.?]|$)/i;

// The old fallback ("What can you tell me about <title>?") and its relatives: not what visitors ask.
const FALLBACK =
  /^(?:what can you tell me about|can you tell me about|tell me (?:more )?about|what do you know about|what is known about)\b/i;
// Questions about the chatbot's own material rather than the visitor's task.
const META = /\b(?:the|this) (?:context|text|document|documents|page|passage|excerpt)\b|\bprovided\b/i;

// The same question whatever its case, punctuation or spacing.
export const questionKey = (q: string) =>
  q
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();

// What a question opens with that says nothing of what it asks: "how do I", "can I", "what is",
// "how much does"…
const LEADING =
  /^(?:(?:how|what|where|when|which|who|why|can|could|do|does|did|is|are|will|would|should|may|i|we|you|there|much|many)\b[\s,]*)+/i;

// The words that tell one question from another: after its opening words, without common words
// and short ones, plurals as singulars (matchWords, as "Pages on the site that may answer this").
export const questionWords = (q: string): string[] => matchWords(q.trim().replace(LEADING, ""));

// The same question in other words: at least three in four of the two questions' words shared.
// "How do I start a 30-day free trial?" asks what "Can I start a 30-day free trial?" does;
// "Is there a free trial?" and "Can I extend my free trial?" don't.
export function sameQuestion(a: string, b: string): boolean {
  if (questionKey(a) === questionKey(b)) return true;
  const x = new Set(questionWords(a));
  const y = questionWords(b);
  if (!x.size || !y.length) return false;
  const shared = y.filter((w) => x.has(w)).length;
  return shared / (x.size + y.length - shared) >= 0.75;
}

// Why a generated question isn't kept, or undefined when it's a good one.
export function rejectQuestion(q: string): string | undefined {
  if (FALLBACK.test(q)) return "fallback";
  if (LEGAL.test(q)) return "legal";
  if (META.test(q)) return "meta";
  return undefined;
}

// "What can you tell me about …", whoever wrote it: generation drops them, but runs from before
// that kept them, and the editor starts from the last run's list (seen on the demo, 2026-10-30:
// three of them passed validation and were offered as starters).
export const isFallbackQuestion = (q: string): boolean => FALLBACK.test(q.trim());
export const FALLBACK_NOTE =
  "Not counted: visitors don't ask “What can you tell me about …”. Rewrite it as something they'd want to know, or remove it.";

// "1. What are your hours?" / "- Do you take walk-ins?" → the questions, without fallback, legal
// or meta questions, and without one that asks the same as another (sameQuestion) or as one of
// `taken` (the chosen starters, which every run asks anyway).
export function parseGeneratedQuestions(text: string, max = GENERATED_QUESTIONS, maxLength = 150, taken: readonly string[] = []): string[] {
  const out: string[] = [];
  for (const raw of text.split("\n")) {
    const q = raw
      .replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "")
      .replace(/^["“]|["”]$/g, "")
      .replace(/\*\*/g, "")
      .trim();
    if (q.length < 8 || q.length > maxLength || !/[?？]$/.test(q) || rejectQuestion(q)) continue;
    if (out.some((o) => sameQuestion(o, q)) || taken.some((t) => sameQuestion(t, q))) continue;
    out.push(q);
    if (out.length === max) break;
  }
  return out;
}

// How likely a page is to be where a visitor gets something done, from its address and title.
const TASKS: [RegExp, number][] = [
  [/pric|plans?\b|buy|purchase|shop|store|quote|cost|licen[cs]/i, 3],
  [/demo|trial|free|get-?started|sign-?up/i, 3],
  [/contact|support|help|faq|service|locations?|hours|visit|find-?us/i, 2],
  [/product|feature|solution|how-?to|guide|docs|learn|compare|edition/i, 1],
];
export function taskScore(page: { url: string; title: string | null }): number {
  const text = `${page.url} ${page.title ?? ""}`;
  return TASKS.reduce((n, [re, score]) => n + (re.test(text) ? score : 0), 0);
}

// ---- spreading generated questions across the site (round 5) ----
//
// All four generated questions came from one pricing page on chef.io, and from one product line
// on crayola.com. So each generated question comes from its own page, at most one per page and
// per topic, drawn from as many sections as there are (three at least when the site has them),
// pages updated in the last two years first.
export interface GenerationPage {
  id: string;
  url: string;
  title: string | null;
  words?: number;
  // Its last change: the page's own date, else the sitemap's.
  updated?: Date | null;
}

const LANGUAGE_SEGMENT = /^[a-z]{2}(?:-[a-z]{2,4})?$/i;
// The section a page sits in: its first path segment after a language folder ("/" for the root).
export function sectionOf(url: string): string {
  try {
    const segments = new URL(url).pathname.split("/").filter(Boolean);
    const at = segments[0] && LANGUAGE_SEGMENT.test(segments[0]) ? 1 : 0;
    return (segments.length > at + 1 ? segments[at] : "") || "/";
  } catch {
    return "/";
  }
}

const TWO_YEARS_MS = 2 * 365 * 24 * 60 * 60_000;
// The pages to generate from, in the order to use them: one per section first (most sections
// first), never two on the same topic (half their title words shared). Pure.
export function spreadPages(pages: readonly GenerationPage[], max: number, today = new Date()): GenerationPage[] {
  const recent = (p: GenerationPage) => (p.updated && today.getTime() - p.updated.getTime() <= TWO_YEARS_MS ? 1 : 0);
  const ranked = [...pages].sort(
    (a, b) => recent(b) - recent(a) || taskScore(b) - taskScore(a) || (b.words ?? 0) - (a.words ?? 0) || (a.url < b.url ? -1 : 1),
  );
  const chosen: GenerationPage[] = [];
  const topics: string[][] = [];
  // Words in a third of the titles or more are the site's name, not a topic ("Chef").
  const counts = new Map<string, number>();
  for (const p of pages) for (const w of questionWords(p.title ?? "")) counts.set(w, (counts.get(w) ?? 0) + 1);
  const common = (w: string) => (counts.get(w) ?? 0) >= Math.max(3, pages.length / 3);
  const topicWords = (p: GenerationPage) => questionWords(p.title ?? "").filter((w) => !common(w));
  const sameTopic = (p: GenerationPage) => {
    const words = topicWords(p);
    return words.length > 0 && topics.some((t) => t.filter((w) => words.includes(w)).length * 2 >= Math.min(t.length, words.length));
  };
  const take = (p: GenerationPage) => {
    chosen.push(p);
    topics.push(topicWords(p));
  };
  // Rounds: one page per section each round, until enough are chosen; pages updated in the last two
  // years first, older ones only when those run out.
  for (const pool of [ranked.filter((p) => recent(p)), ranked]) {
    for (let round = 0; chosen.length < max && round < 4; round++) {
      const used = new Map<string, number>();
      for (const c of chosen) used.set(sectionOf(c.url), (used.get(sectionOf(c.url)) ?? 0) + 1);
      for (const p of pool) {
        if (chosen.length >= max) break;
        if (chosen.includes(p) || (used.get(sectionOf(p.url)) ?? 0) > round || sameTopic(p)) continue;
        take(p);
        used.set(sectionOf(p.url), (used.get(sectionOf(p.url)) ?? 0) + 1);
      }
    }
  }
  return chosen;
}

export const isLegalPage = (page: { url: string; title: string | null }) => {
  let path = page.url;
  try {
    path = new URL(page.url).pathname;
  } catch {
    // keep what was given
  }
  return LEGAL_PATH.test(path) || LEGAL.test(page.title ?? "");
};

export const generationNote = (n: number) =>
  n === 0
    ? "No questions could be generated from the site yet. Add your own."
    : `Only ${n} question${n === 1 ? "" : "s"} could be generated from the site. Add your own.`;

// ---- the model judge's verdicts (lib/judge.ts asks it) ----

export const JUDGE_VERDICTS = [
  "answers",
  "partly",
  "not-on-site",
  "contradicts",
  "off-topic",
  "substituted",
  "talks-about-sources",
] as const;
export type JudgeVerdict = (typeof JUDGE_VERDICTS)[number];
export const isJudgeVerdict = (v: unknown): v is JudgeVerdict => JUDGE_VERDICTS.includes(v as JudgeVerdict);

// What a judge's verdict does to a result: nothing ("answers"), a Check this a person clears with
// I checked it ("partly"), or a hold that only asking again, rewording or a named decision with a
// reason clears. It never releases a result the rules hold.
export const judgeOutcome = (v: JudgeVerdict | "unavailable" | undefined): "none" | "check" | "hold" =>
  !v || v === "answers" || v === "unavailable" ? "none" : v === "partly" ? "check" : "hold";

// The judge's verdict in the panel's words, before its one-line reason.
export const JUDGE_TEXT: Record<JudgeVerdict, string> = {
  answers: "Answers the question",
  partly: "Answers in part: the site says more",
  "not-on-site": "Doesn't answer: says the site doesn't have it",
  contradicts: "Disagrees with what the site states",
  "off-topic": "Answers something else",
  substituted: "Gives something beside what was asked, and nothing on what was asked",
  "talks-about-sources": "Talks about its sources instead of answering",
};

// ---- judging an answer ----

/// The phrases that give the machinery away, in every language the widget serves (round 6,
// reconciled with the prompt, which tells the model to name the page it read): the context, the
// text the model read, and the provided, available, given or extracted text, pages or documents
// ("The provided pages do not state…" in the demo's German answer). Naming a page is answering:
// "The page also shows annual billing", "Our pricing page lists…", "the Pricing page doesn't list a
// price for 300 devices" are allowed. "In the context of …" is ordinary speech. Also what the
// review's Client's name line looks for in a saved prompt (lib/review.ts).
export const LEAK_PHRASES: readonly RegExp[] = [
  // en
  /\bthe (?:provided |given |supplied |above )?context\b(?!\s+of\b)/i,
  // "Available" and "materials" aren't the machinery on their own: "Available materials include
  // insulated steel" (clopaydoor.com's starter, failed as talking about how it works).
  /\b(?:provided|given|supplied|extracted|retrieved) (?:text|texts|pages?|documents?|excerpts?|passages?|content|details)\b/i,
  /\bavailable (?:text|texts|pages?|documents?|excerpts?|passages?)\b/i,
  /\b(?:text|pages?|documents?|excerpts?|passages?|content) (?:provided|supplied|given|retrieved|available to me|i (?:have|was given|can see|can access))\b/i,
  /\bnot enough data\b/i,
  // "The text says…", "according to the text": the text the model read, as its source.
  /\b(?:the|this|that) text\b(?:,)? (?:also |only |itself |clearly )?(?:does not|doesn't|did not|didn't|do not|don't|says?|said|states?|stated|mentions?|lists?|shows?|indicates?|specifies|provides?|describes?|contains?|notes?|explains?|gives?|includes?|has no)\b/i,
  /\b(?:according to|based on|from what|as stated in|as shown in) (?:the|this|that) (?:text|context)\b/i,
  // "The information we have does not provide…", "the provided information", "information
  // provided", whatever the subject (round 5: crayola.com and chef.io).
  /\b(?:the |our )?information (?:we|i) (?:have|hold|can access|was given|were given)\b/i,
  /\b(?:provided|given|supplied) information\b|\bpage text\b/i,
  /\binformation (?:provided|available to (?:me|us)|i can access|at hand)\b/i,
  // Not "available information" in Spanish, German or French: "la información disponible en
  // nuestra página de precios" points to a page (Kemp's Spanish price answer, a don't-break).
  /\b(?:die|den|der) (?:uns |mir )?(?:vorliegenden|bereitgestellten) (?:Informationen|Angaben|Unterlagen)\b/iu,
  /(?<![\p{L}])(?:la )?información (?:proporcionada|que tenemos|que tengo|con la que cuento|con la que contamos)(?![\p{L}])/iu,
  /(?<![\p{L}])(?:les )?informations (?:fournies|dont (?:je|nous) dispos\p{L}*|à (?:ma|notre) disposition)(?![\p{L}])/iu,
  // es
  /\bel contexto\b(?!\s+de\b)/i,
  /(?<![\p{L}])(?:textos?|documentos?|páginas?|fragmentos?|pasajes?) (?:proporcionad|facilitad|extraíd|suministrad)[oa]s?(?![\p{L}])/iu,
  /(?<![\p{L}])(?:el|del) texto (?:disponible|que tengo)(?![\p{L}])/iu,
  /\bno hay (?:suficientes datos|datos suficientes)\b/i,
  /(?<![\p{L}])(?:según|de acuerdo con) el (?:texto|contexto)(?![\p{L}])/iu,
  // fr
  /\ble contexte\b(?!\s+d)/i,
  /(?<![\p{L}])(?:texte|textes|documents?|pages?|extraits?|passages?) (?:fourni|fournie|fournis|fournies|extrait|extraits|disponibles?|dont je dispose)(?![\p{L}])/iu,
  /\bpas assez de donn/i,
  /(?<![\p{L}])(?:selon|d['’]après) le (?:texte|contexte)(?![\p{L}])/iu,
  // de
  /\b(?:der|dem|den|im) Kontext\b(?!\s+(?:von|des|der)\b)/i,
  /(?<![\p{L}])(?:bereitgestellten?|vorliegenden?|verfügbaren?|angegebenen?|obigen|extrahierten?) (?:Texte?|Textes|Seiten?|Dokumente?|Dokumenten|Auszüge?|Passagen?|Kontext)(?![\p{L}])/iu,
  /\bnicht (?:genügend|genug) Daten\b/i,
  /(?<![\p{L}])(?:laut|gemäß) (?:dem|diesem) (?:Text|Kontext)(?![\p{L}])/iu,
  // nl
  /\bde context\b(?!\s+van\b)/i,
  /\b(?:verstrekte|aangeleverde|gegeven|beschikbare|bovenstaande) (?:tekst|teksten|documenten|pagina's|paginas)\b/i,
  /\bniet genoeg (?:gegevens|data)\b/i,
  // pt
  /\bo contexto\b(?!\s+d)/i,
  /(?<![\p{L}])(?:textos?|documentos?|páginas?|trechos?) (?:fornecid|disponibilizad|extraíd)[oa]s?(?![\p{L}])/iu,
  /\bdados insuficientes\b/i,
  // it
  /\bil contesto\b(?!\s+di\b)/i,
  /(?<![\p{L}])(?:testo|testi|documenti|documento|pagine|pagina|estratti|passaggi) (?:fornit[oaie]|disponibil[ei]|estratt[oaie])(?![\p{L}])/iu,
  /\bdati insufficienti\b/i,
];

export const leaksInternals = (answer: string) => LEAK_PHRASES.some((re) => re.test(answer));

// Month names in the widget's languages, for "15 March", "March 15", "15. März", "15 de marzo".
const MONTHS = [
  "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?",
  "enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre",
  "janvier|février|fevrier|mars|avril|mai|juin|juillet|août|aout|septembre|octobre|novembre|décembre|decembre",
  "januar|februar|märz|maerz|april|mai|juni|juli|august|september|oktober|november|dezember",
  "januari|februari|maart|april|mei|juni|juli|augustus|september|oktober|november|december",
  "janeiro|fevereiro|março|marco|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro",
  "gennaio|febbraio|marzo|aprile|maggio|giugno|luglio|agosto|settembre|ottobre|novembre|dicembre",
].join("|");
const DATES: RegExp[] = [
  new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th|\\.)?\\s+(?:of\\s+|de\\s+)?(?:${MONTHS})\\b`, "i"),
  new RegExp(`\\b(?:${MONTHS})\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?\\b`, "i"),
  new RegExp(`\\b(?:${MONTHS})\\s+(?:de\\s+)?\\d{4}\\b`, "i"),
  /\b\d{4}-\d{2}-\d{2}\b/,
  /\b\d{1,2}[./]\d{1,2}[./]\d{2,4}\b/,
  /\b(?:deadline|due date|closes on|last day to|expires on|fecha l[ií]mite|plazo|frist|anmeldeschluss|date limite|scadenza|uiterlijk|prazo)\b/i,
];
const CURRENCY = "US\\$|[$€£¥₹]";
const CURRENCY_CODE = "USD|EUR|GBP|CHF|CAD|AUD|NZD|SEK|NOK|DKK|JPY|INR";
const PRICES: RegExp[] = [
  new RegExp(`(?:${CURRENCY})\\s?\\d`),
  new RegExp(`\\d[\\d.,]*\\s?(?:${CURRENCY})`),
  new RegExp(`\\b(?:${CURRENCY_CODE})\\s?\\d`),
  new RegExp(`\\d[\\d.,]*\\s?(?:${CURRENCY_CODE}|euros?|dollars?|pounds?)\\b`, "i"),
];

export function answerFlags(answer: string, sources: readonly { url: string; overview: boolean }[]): ValidationFlag[] {
  const flags: ValidationFlag[] = [];
  if (PRICES.some((re) => re.test(answer))) flags.push("price");
  if (DATES.some((re) => re.test(answer))) flags.push("date");
  if (sources.length > 0 && sources.every((s) => s.overview)) flags.push("overview-sources");
  return flags;
}

// The figures a flagged answer states, as digits only ("$1,229" and "1.229 $" are both 1229):
// amounts next to a currency for a price, numbers of two digits or more in a date.
const NUMBER = /\d(?:[\d.,]*\d)?/g;
// An amount: digits with separators, or thousands grouped by spaces ("1 250 €": round 6 read it as 250).
const AMOUNT = "\\d{1,3}(?:[\\s\\u00a0\\u202f]\\d{3})+(?:[.,]\\d{1,2})?(?!\\d)|\\d(?:[\\d.,]*\\d)?";
const PRICE_FIGURES = new RegExp(
  `(?:${CURRENCY}|\\b(?:${CURRENCY_CODE}))\\s?(${AMOUNT})|(${AMOUNT})\\s?(?:${CURRENCY}|(?:${CURRENCY_CODE}|euros?|dollars?|pounds?)\\b)`,
  "gi",
);
const AMOUNTS = new RegExp(AMOUNT, "g");
const figure = (n: string) => n.replace(/[.,]00$/, "").replace(/[.,]/g, "");
// A price's amount, whatever its local format (Track A's figureValue): "1 250 €" and "1.250 €" are
// 1250, "37,50 €" and "37,5 €" are 37.5.
const amount = (n: string) => figureValue(n) ?? "";

export function answerFigures(answer: string, flags: readonly ValidationFlag[]): string[] {
  const out = new Set<string>();
  if (flags.includes("price")) for (const m of answer.matchAll(PRICE_FIGURES)) out.add(amount(m[1] ?? m[2] ?? ""));
  if (flags.includes("date")) {
    for (const re of DATES) {
      for (const m of answer.matchAll(new RegExp(re.source, `${re.flags}g`))) {
        // "December 1, 2024": the year after the day belongs to the date.
        const year = answer.slice(m.index + m[0].length).match(/^,?\s*(\d{4})\b/)?.[1] ?? "";
        for (const n of `${m[0]} ${year}`.match(NUMBER) ?? []) if (n.length >= 2) out.add(figure(n));
      }
    }
  }
  out.delete("");
  return [...out];
}

interface Paragraphs {
  fields?: Record<string, { paragraphs?: Record<string, { text?: unknown }> }>;
}

// Price pages first when a price is to be checked: the figure can also sit on a product page,
// in a different edition or currency (whatsupgold.com's Network Discovery page lists $1,169
// where /pricing says $1,229).
const PRICE_PAGE = /pric|preis|prix|precio|prezz|tarif|cost|kosten|plans?\b|buy|purchase|licen/i;

// The page to compare a flagged answer with: the one, of those the chatbot read, whose text
// holds most of the answer's figures; cited pages, then price pages, first among equals. When no
// page holds any, the first source, marked not found.
export function sourceToCheck(
  answer: string,
  flags: readonly ValidationFlag[],
  result: Pick<AskResult, "citations" | "retrieval_results"> & { augmented_context?: unknown },
  fallback?: { title: string; url: string },
): CheckSource | undefined {
  const figures = answerFigures(answer, flags);
  const resources = (result.retrieval_results?.resources ?? {}) as Record<string, Resource & Paragraphs>;
  const texts = new Map<string, string[]>();
  const add = (rid: string, text: unknown) => {
    if (typeof text === "string") texts.set(rid, [...(texts.get(rid) ?? []), text]);
  };
  for (const [rid, r] of Object.entries(resources)) {
    add(rid, r.title);
    for (const field of Object.values(r.fields ?? {})) for (const p of Object.values(field?.paragraphs ?? {})) add(rid, p?.text);
  }
  const augmented = (result.augmented_context as { paragraphs?: Record<string, { text?: unknown }> } | undefined)?.paragraphs ?? {};
  for (const [id, p] of Object.entries(augmented)) add(id.split("/")[0] ?? id, p?.text);
  const cited = new Set(Object.keys(result.citations ?? {}).map((k) => k.split("/")[0] ?? k));
  const ranked = [...texts.entries()]
    .flatMap(([rid, parts], order) => {
      const url = resources[rid]?.origin?.url;
      if (!url || !/^https?:\/\//.test(url)) return [];
      const held = new Set(parts.join("\n").match(NUMBER)?.map(figure));
      const title = resources[rid]?.title?.trim() || new URL(url).pathname;
      return [
        {
          title,
          url,
          found: figures.filter((f) => held.has(f)).length,
          cited: cited.has(rid) ? 1 : 0,
          pricePage: flags.includes("price") && PRICE_PAGE.test(`${url} ${title}`) ? 1 : 0,
          order,
        },
      ];
    })
    .sort((a, b) => b.found - a.found || b.cited - a.cited || b.pricePage - a.pricePage || a.order - b.order);
  const best = ranked[0];
  if (best && best.found > 0) return { title: best.title, url: best.url, found: true };
  return fallback && { ...fallback, found: false };
}

// ---- each flagged figure beside the text that states it ----

// A synced page's text, as the sync sent it to the Knowledge Box.
export interface SyncedPage {
  url: string;
  title: string | null;
  text: string | null;
  lang?: string | null;
}

interface Stated {
  figure: string;
  kind: "price" | "date";
  // Its numbers: a price's amount, a date's day and year.
  keys: string[];
}

const dateKey = (n: string) => n.replace(/^0+(?=\d)/, "");
// The deadline words (the last DATES rule) state no figure.
const DATED = DATES.filter((re) => /\\d/.test(re.source));

// The figures a flagged answer states, as written: each price once, and each date with the year
// that follows it ("December 1, 2024", where two rules see "December 1" and "December 2024").
function statedFigures(answer: string, flags: readonly ValidationFlag[]): Stated[] {
  const out: Stated[] = [];
  if (flags.includes("price")) {
    for (const m of answer.matchAll(PRICE_FIGURES)) {
      const key = amount(m[1] ?? m[2] ?? "");
      if (key && !out.some((f) => f.keys[0] === key)) out.push({ figure: m[0].trim(), kind: "price", keys: [key] });
    }
  }
  if (flags.includes("date")) {
    const spans: [number, number][] = [];
    for (const re of DATED) {
      for (const m of answer.matchAll(new RegExp(re.source, `${re.flags}g`))) {
        const year = answer.slice(m.index + m[0].length).match(/^,?\s*\d{4}\b/)?.[0] ?? "";
        spans.push([m.index, m.index + m[0].length + year.length]);
      }
    }
    spans.sort((a, b) => a[0] - b[0]);
    const merged: [number, number][] = [];
    for (const s of spans) {
      const last = merged.at(-1);
      if (last && s[0] <= last[1]) last[1] = Math.max(last[1], s[1]);
      else merged.push([...s]);
    }
    for (const [from, to] of merged) {
      const text = answer.slice(from, to).trim();
      out.push({ figure: text, kind: "date", keys: (text.match(NUMBER) ?? []).map((n) => dateKey(figure(n))) });
    }
  }
  return out;
}

// The digits to look for in the synced pages' text: each price's, each date's year.
export const figureKeys = (answer: string, flags: readonly ValidationFlag[]): string[] =>
  [
    ...new Set(
      statedFigures(answer, flags).map((f) =>
        f.kind === "price" ? (f.keys[0] ?? "").replace(/\D/g, "") : (f.keys.find((k) => k.length === 4) ?? ""),
      ),
    ),
  ].filter((k) => k.length >= 2);

const plainLine = (line: string) =>
  line.startsWith("|")
    ? line
        .split("|")
        .map((cell) => cell.trim())
        .filter(Boolean)
        .join(" | ")
    : line
        .replace(/^#+\s*/, "")
        .replace(/\*\*|__/g, "")
        .trim();
const isHeading = (line: string) => /^#{1,6}\s/.test(line);
const AROUND = new RegExp(`(?:${CURRENCY}|\\b(?:${CURRENCY_CODE}))\\s?$`);
const AFTER = new RegExp(`^\\s?(?:${CURRENCY}|(?:${CURRENCY_CODE}|euros?|dollars?|pounds?)\\b)`, "i");
const EXCERPT = 240;

// Where a page's text states the figure: its line, and the figure's place in it (a price with
// its currency sign, a date from its first number to its last).
// A number that isn't a price where it stands: "5-star", "3,600 reviews", "20%" (round 7: $5 was
// shown beside "Over 3,600 5-star reviews").
const NOT_A_PRICE_AFTER = /^(?:-\p{L}|\s?%|\+|\s*(?:stars?|reviews?|customers?|users?|hours?|hrs?|days?|minutes?)\b)/iu;
const hasCurrency = (line: string, at: [number, number]) =>
  /[$€£¥]\s?$|\b(?:USD|EUR|GBP|CHF|CAD|AUD)\s?$/.test(line.slice(Math.max(0, at[0] - 5), at[0])) ||
  /^\s?(?:[$€£¥]|USD|EUR|GBP|CHF|US-Dollar|Euro)/.test(line.slice(at[1], at[1] + 10)) ||
  /[$€£¥]/.test(line.slice(at[0], at[1]));

function findFigure(lines: readonly string[], f: Stated): { line: number; at: [number, number] } | undefined {
  // A price with its currency first; a bare number only where nothing says it's something else.
  if (f.kind === "price") {
    const signed = findFigureIn(lines, f, (line, at) => hasCurrency(line, at));
    if (signed) return signed;
    return findFigureIn(lines, f, (line, at) => !NOT_A_PRICE_AFTER.test(line.slice(at[1])));
  }
  return findDate(lines, f) ?? (dateKeys(f.figure).length ? undefined : findFigureIn(lines, f, () => true));
}

// A date by its month and day, whatever the format ("November 3" is "November 03, 2026", "3. November
// 2026" and "03.11.2026"), never by its digits alone (recheck-R2: "November 3" was placed on "Q3 2026"
// on one run and on no page on the next, with a typed address required). A line with the year first.
function findDate(lines: readonly string[], f: Stated): { line: number; at: [number, number] } | undefined {
  const keys = dateKeys(f.figure);
  if (!keys.length) return undefined;
  const year = f.keys.find((k) => k.length === 4);
  let fallback: { line: number; at: [number, number] } | undefined;
  for (const [i, line] of lines.entries()) {
    const hit = datesIn(line).find((d) => keys.includes(d.key));
    const found = hit?.at ?? numericDateAt(line, keys);
    if (!found) continue;
    const at: [number, number] = [found[0], found[1] + (line.slice(found[1]).match(/^,?\s*\d{4}\b/)?.[0].length ?? 0)];
    if (!year || line.includes(year)) return { line: i, at };
    fallback ??= { line: i, at };
  }
  return fallback;
}
const numericDateAt = (line: string, keys: readonly string[]): [number, number] | undefined => {
  for (const m of line.matchAll(/(?<!\d)(\d{1,2})[./-](\d{1,2})[./-]\d{2,4}(?!\d)/g)) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (keys.includes(`${b}-${a}`) || keys.includes(`${a}-${b}`)) return [m.index, m.index + m[0].length];
  }
  return undefined;
};

function findFigureIn(
  lines: readonly string[],
  f: Stated,
  fits: (line: string, at: [number, number]) => boolean,
): { line: number; at: [number, number] } | undefined {
  for (const [i, line] of lines.entries()) {
    const numbers = [...line.matchAll(f.kind === "price" ? AMOUNTS : NUMBER)].map((m) => ({
      key: f.kind === "date" ? dateKey(figure(m[0])) : amount(m[0]),
      at: [m.index, m.index + m[0].length] as [number, number],
    }));
    const hits = numbers.filter((n) => f.keys.includes(n.key) && fits(line, n.at));
    if (!hits.length || (f.kind === "date" && !f.keys.every((k) => hits.some((h) => h.key === k)))) continue;
    let [from, to] = [Math.min(...hits.map((h) => h.at[0])), Math.max(...hits.map((h) => h.at[1]))];
    if (f.kind === "price") {
      from -= line.slice(0, from).match(AROUND)?.[0].length ?? 0;
      to += line.slice(to).match(AFTER)?.[0].length ?? 0;
    }
    return { line: i, at: [from, to] };
  }
  return undefined;
}

// The figure in its context: the line that states it (a table row as its cells, a long
// paragraph cut to the sentence), with the short line before ("starting from") and after
// ("per developer, per year") a figure that stands on its own line, and the headings it sits
// under ("Buy Telerik UI for ASP.NET Core › DevCraft UI").
function excerptAround(lines: readonly string[], hit: { line: number; at: [number, number] }) {
  const raw = lines[hit.line] ?? "";
  const stated = raw.slice(...hit.at);
  let text = plainLine(raw);
  let start = text.indexOf(stated);
  if (text.length > EXCERPT && start >= 0) {
    const before = text.slice(0, start).search(/[^.!?]*$/);
    const after = text.slice(start + stated.length).search(/[.!?](\s|$)/);
    const sentence = text.slice(before, after < 0 ? undefined : start + stated.length + after + 1).trim();
    start = sentence.indexOf(stated);
    text = sentence;
    if (text.length > EXCERPT) {
      const from = Math.max(0, start - EXCERPT / 2);
      text = `${from > 0 ? "…" : ""}${text.slice(from, from + EXCERPT)}…`;
      start = text.indexOf(stated);
    }
  }
  const near = (step: 1 | -1) => {
    for (let i = hit.line + step; i >= 0 && i < lines.length; i += step) {
      const line = (lines[i] ?? "").trim();
      if (line) return isHeading(line) || line.startsWith("|") || line.startsWith("-") ? undefined : plainLine(line);
    }
    return undefined;
  };
  if (text.length <= 40 && !raw.startsWith("|")) {
    const before = near(-1);
    const after = near(1);
    if (before && before.length <= 40 && !/\d/.test(before)) {
      text = `${before} ${text}`;
      start += before.length + 1;
    }
    if (after && after.length <= 60) text = `${text} ${after}`;
  }
  // The nearest heading above, and the one it sits under, within a dozen lines.
  const headings: { level: number; text: string }[] = [];
  for (let i = hit.line - 1, seen = 0; i >= 0 && seen < 12 && headings.length < 2; i--) {
    const line = (lines[i] ?? "").trim();
    if (!line) continue;
    seen++;
    const level = line.match(/^(#{1,6})\s/)?.[1]?.length;
    if (level && (!headings.length || level < (headings.at(-1)?.level ?? 7))) headings.push({ level, text: plainLine(line) });
  }
  return {
    ...(headings.length && {
      label: headings
        .reverse()
        .map((h) => h.text)
        .join(" › "),
    }),
    excerpt: text,
    ...(start >= 0 && { mark: [start, start + stated.length] as [number, number] }),
  };
}

const sameUrl = (url: string) => url.replace(/#.*$/, "").replace(/\/+$/, "").toLowerCase();

// Each figure a flagged answer states, beside the sentence or table row that states it on a
// synced page, compared by their digits ("$1,299", "$ 1,299" and "1.299 €" are one figure). Of
// the pages that state it: for a price, price pages first (whatsupgold.com's product pages
// repeat "$ 1,229" with no plan name; /pricing names it), then the pages the answer cites, those
// in the answer's language, and those it retrieved. A figure no page states has no page.
export function locateFigures(
  answer: string,
  flags: readonly ValidationFlag[],
  pages: readonly SyncedPage[],
  prefer: { cited?: readonly string[]; retrieved?: readonly string[]; language?: Language } = {},
): FigureCheck[] {
  const cited = new Set(prefer.cited?.map(sameUrl));
  const retrieved = new Set(prefer.retrieved?.map(sameUrl));
  const split = pages.filter((p) => p.text).map((p) => ({ page: p, lines: (p.text ?? "").split("\n") }));
  return statedFigures(answer, flags).map((f): FigureCheck => {
    const found = split.flatMap(({ page, lines }) => {
      const hit = findFigure(lines, f);
      if (!hit) return [];
      const title = page.title?.trim() || page.url;
      const rank = [
        f.kind === "price" && PRICE_PAGE.test(`${page.url} ${title}`) ? 1 : 0,
        cited.has(sameUrl(page.url)) ? 1 : 0,
        prefer.language && languageOf(page.lang) === prefer.language ? 1 : 0,
        retrieved.has(sameUrl(page.url)) ? 1 : 0,
      ];
      return [{ page: { title, url: page.url }, lines, hit, rank }];
    });
    found.sort((a, b) => compareRank(a.rank, b.rank) || a.page.url.length - b.page.url.length);
    const best = found[0];
    if (!best) return { figure: f.figure, kind: f.kind };
    return {
      figure: f.figure,
      kind: f.kind,
      page: best.page,
      ...excerptAround(best.lines, best.hit),
      ...(found.length > 1 && { more: found.length - 1 }),
    };
  });
}

const compareRank = (a: readonly number[], b: readonly number[]) => {
  for (const [i, n] of a.entries()) if (n !== b[i]) return (b[i] ?? 0) - n;
  return 0;
};

// The figures to compare, as a sentence for the check: "$1,149 and $1,299".
export const figureList = (figures: readonly FigureCheck[]) =>
  figures.length > 1
    ? `${figures
        .slice(0, -1)
        .map((f) => f.figure)
        .join(", ")} and ${figures.at(-1)?.figure}`
    : (figures[0]?.figure ?? "");

// The answer isn't in the language it should be: the question's (a deployment that follows each
// visitor), or the deployment's own.
export const languageFailure = (answered: Language, expected: Language, followsVisitor: boolean): string =>
  followsVisitor
    ? `Answered in ${languageName(answered)}, asked in ${languageName(expected)}`
    : `Answered in ${languageName(answered)}: this chat answers in ${languageName(expected)}`;

// §2.2: a language mismatch fails only when the answer's words leave no doubt; when they lean
// that way but not clearly, a person checks it; when there are too few to tell, nothing.
export function languageVerdict(
  answer: string,
  language: { expected: Language; followsVisitor: boolean },
): { failure?: string; check?: string } {
  const read = answerLanguage(answer);
  if (!read || read.language === language.expected) return {};
  // As much of the expected language as of the other: not a mismatch.
  if ((read.scores[language.expected] ?? 0) >= (read.scores[read.language] ?? 0)) return {};
  if (read.confident) return { failure: languageFailure(read.language, language.expected, language.followsVisitor) };
  return {
    check: language.followsVisitor
      ? `It may be in ${languageName(read.language)}, though it was asked in ${languageName(language.expected)}`
      : `It may be in ${languageName(read.language)}, though this chat answers in ${languageName(language.expected)}`,
  };
}

// The language an answer should be in: the question's when the deployment follows each
// visitor (undefined when the question is too short to tell), else the deployment's.
export const expectedLanguage = (question: string, setting: string): Language | undefined =>
  setting === "auto" ? detectLanguage(question) : (setting as Language);

// Home, listing, index, company, tag and category pages: right for "What do you do?", thin
// for anything specific. The content sync flags them too ("overview").
const OVERVIEW_TITLE = /\b(home|homepage|listing|index|archives?|tags?|categor(?:y|ies)|company)\b/i;
const OVERVIEW_PATH = /\/(tags?|categor(?:y|ies)|archives?|company)(\/|$)/i;
export function isOverviewPage(page: { url: string; title?: string | null }, flagged = false): boolean {
  if (flagged) return true;
  try {
    const path = new URL(page.url).pathname;
    if (path === "/" || path === "" || OVERVIEW_PATH.test(path)) return true;
  } catch {
    return false;
  }
  return OVERVIEW_TITLE.test(page.title ?? "");
}

interface Resource {
  title?: string;
  origin?: { url?: string | null } | null;
}

// Sources a visitor would see: cited resources first, else what was retrieved.
export function answerSources(result: Pick<AskResult, "citations" | "retrieval_results">, max = 3): { title: string; url: string }[] {
  const resources = (result.retrieval_results?.resources ?? {}) as Record<string, Resource>;
  const cited = [...new Set(Object.keys(result.citations ?? {}).map((k) => k.split("/")[0] ?? k))];
  const ids = cited.length ? cited : Object.keys(resources);
  const out: { title: string; url: string }[] = [];
  for (const id of ids) {
    const url = resources[id]?.origin?.url;
    if (!url || !/^https?:\/\//.test(url) || out.some((s) => s.url === url)) continue;
    out.push({ title: resources[id]?.title?.trim() || new URL(url).pathname, url });
    if (out.length === max) break;
  }
  return out;
}

// The passage each source was cited for (else everything retrieved from it), for whether the
// sources are about the question (answerChecks).
export function sourcePassages(
  result: Pick<AskResult, "citations" | "retrieval_results">,
  sources: readonly { title: string; url: string }[],
): { title: string; url: string; text?: string }[] {
  const resources = (result.retrieval_results?.resources ?? {}) as Record<string, Resource & Paragraphs>;
  const cited = Object.keys(result.citations ?? {});
  return sources.map((s) => {
    const found = Object.entries(resources).find(([, r]) => r.origin?.url === s.url);
    if (!found) return s;
    const [rid, r] = found;
    const paragraphs = Object.values(r.fields ?? {}).flatMap((f) => Object.entries(f?.paragraphs ?? {}));
    const ids = new Set(cited.filter((k) => (k.split("/")[0] ?? k) === rid));
    const chosen = paragraphs.filter(([id]) => ids.has(id));
    const text = (chosen.length ? chosen : paragraphs)
      .map(([, p]) => p?.text)
      .filter((t): t is string => typeof t === "string")
      .join("\n");
    return text ? { ...s, text } : s;
  });
}

// What a judgement needs beyond the answer: the client's name visitors see (its words don't count
// as a source matching the question) and the language of each synced page.
export interface JudgeContext {
  brand?: string;
  pageLanguage?: (url: string) => string | null | undefined;
  // The chat's name (the widget's nickname): its brand words don't make a source fit, as in the
  // widget's own source picking.
  chatName?: string;
  // The deployment's confirmed price table (confirmedTable in @launchpad/theme): every answer's
  // plan prices are checked against it, before and without the judge (round 6, item 1).
  priceTable?: PriceTable;
  // With no confirmed table: the pricing page's own pairings (provisionalTable), checked the same
  // way but never "matching" (round 7, item 2).
  pricingFacts?: PriceTable;
  // The lines of the pricing pages' text, while no table is confirmed: a figure the rows lack but a
  // line pairs with the plan is the table's gap, not the answer's mistake (round 7: SavvyCal's
  // "Premium is $200" held because the read table had no such row).
  pricingLines?: readonly string[];
}

// Whether a line of the pricing page pairs a figure with a plan: the figure is on the line, and of the
// table's plans the plan is the one named nearest before it (else nearest after). Pure.
export function pairedOnLine(lines: readonly string[], plans: readonly string[], plan: string, value: number): boolean {
  return lines.some((line) => {
    const figure = priceAmounts(line).find((f) => f.value === value);
    if (!figure) return false;
    const at = (name: string) => {
      const m = new RegExp(`(?<![\\p{L}\\p{N}])${escapeName(name)}(?![\\p{L}\\p{N}])`, "giu");
      return [...line.matchAll(m)].map((x) => x.index);
    };
    const places = plans.flatMap((name) => at(name).map((i) => ({ name, i })));
    const before = places.filter((x) => x.i < figure.at).sort((a, b) => b.i - a.i)[0];
    const after = places.filter((x) => x.i > figure.at).sort((a, b) => a.i - b.i)[0];
    return (before ?? after)?.name === plan;
  });
}

// The pages an answer cites, by address.
export function citedPages(result: Pick<AskResult, "citations" | "retrieval_results">): string[] {
  const cited = new Set(Object.keys(result.citations ?? {}).map((k) => k.split("/")[0] ?? k));
  const resources = (result.retrieval_results?.resources ?? {}) as Record<string, { origin?: { url?: string | null } | null }>;
  return [...cited].flatMap((id) => resources[id]?.origin?.url ?? []);
}

// The price table check on an answer visitors see (checkPriceClaims in @launchpad/theme): each
// contradiction a hold naming the pairing ("Standard is $4,500 on /pricing; this answer gives $6,200
// for Standard"), which only asking again, rewording or a named reason clears, never I checked it;
// and whether every price it states is the table's, for the plan it names, from the pricing page
// (no price to check then). A figure the table has, given for a plan it doesn't name, never
// matches (round 7). With no confirmed table, the pricing page's own pairings (provisional): a
// contradiction of what the page says is still a hold, but nothing "matches" an unconfirmed table.
export function priceTableCheck(
  answer: string,
  table: PriceTable | undefined,
  cited: readonly string[],
  language?: string,
  opts: { question?: string; provisional?: boolean; pricingLines?: readonly string[] } = {},
): { holds: Hold[]; matched: boolean; pageAgrees?: boolean; unverified?: { plan: string; said: string }[] } {
  if (!table || !answer) return { holds: [], matched: false };
  const plans = [...new Set(table.rows.map((r) => r.plan.trim()))];
  const lines = opts.pricingLines;
  const claims = checkPriceClaims(answer, table, cited, language, {
    ...(opts.question && { question: opts.question }),
    strangers: strangersIn,
    ...(opts.provisional && lines?.length && { listed: (plan: string, value: number) => pairedOnLine(lines, plans, plan, value) }),
  });
  const holds = claims.contradictions
    // A figure from another page isn't a hold against an unconfirmed table: the check for where
    // figures are (uncitedPriceHold, pricingProvenanceHold) covers it.
    .filter((c) => !opts.provisional || c.reason !== "source")
    .map(
      (c): Hold => ({
        by: "price",
        clear: "decide",
        text: opts.provisional
          ? `${plainQuote(contradictionText(c, cited)).replace(/ on (\/\S*);/, " on the pricing page $1 (table not confirmed yet);")}.`
          : `${plainQuote(contradictionText(c, cited))}.`,
        pages: [{ url: c.table.url, lines: [c.table.line] }],
        ...(!opts.provisional && { table: table.hash }),
      }),
    );
  const stated = answerFigures(answer, ["price"]).length > 0;
  const agrees = stated && !holds.length && !claims.unlisted.length && !claims.unverified?.length;
  return {
    holds,
    matched: !opts.provisional && agrees,
    // No person has confirmed the rows, but every figure is the plan's on the pricing page's own rows
    // (a row the proof found nearer another plan's name proves nothing).
    ...(opts.provisional && agrees && !table.rows.some((r) => r.doubt && /sits nearer/.test(r.doubt)) && { pageAgrees: true }),
    ...(claims.unverified?.length && { unverified: claims.unverified }),
  };
}

// The pricing page's own pairings as a table to check answers against while no person has
// confirmed one (round 7, item 2): the stored table's rows, else the rows read from the price key
// pages' facts, without rows whose name may not be a plan (a badge, the page title, a feature
// line) or whose plan the rows give two amounts in one period. Pure.
export function provisionalTable(
  rows: readonly PriceRow[],
  pages: readonly { url: string; title?: string | null }[] = [],
): PriceTable | undefined {
  const titleOf = (url: string) => pages.find((p) => sameUrl(p.url) === sameUrl(url))?.title;
  const kept = rows.filter((r) => r.addOn || !planNameDoubt(r.plan, titleOf(r.url)));
  const clash = (r: PriceRow) =>
    kept.some(
      (o) =>
        o !== r &&
        o.plan.trim().toLowerCase() === r.plan.trim().toLowerCase() &&
        (o.period ?? "") === (r.period ?? "") &&
        o.value !== r.value &&
        !o.qualifiers?.length &&
        !r.qualifiers?.length,
    );
  const clean = kept.filter((r) => !clash(r));
  if (!clean.length) return undefined;
  return {
    rows: clean,
    pages: [...new Set([...pages.map((p) => p.url), ...clean.map((r) => r.url)])],
    readAt: "",
    hash: "provisional",
  };
}

// Build 8: a question about price, by its intent or its words. The re-ask after a re-read and after
// Confirm are limited to these (and live starters): they're what the table changes.
export const asksPrice = (q: Pick<RunQuestion, "intent" | "question">): boolean =>
  q.intent === "price" || askedKind(q.question) === "price";

// How many price questions Confirm asks again, at most, and which: the price intent's, then the live
// starters', then any other. Pure.
export const PRICE_REASKS = 4;
export function priceQuestionsToAsk(questions: readonly RunQuestion[], liveStarters: readonly string[]): RunQuestion[] {
  const live = new Set(liveStarters);
  const rank = (q: RunQuestion) => (q.intent === "price" ? 0 : live.has(questionKey(q.question)) ? 1 : 2);
  return questions
    .filter(asksPrice)
    .map((q, i) => ({ q, i }))
    .sort((a, b) => rank(a.q) - rank(b.q) || a.i - b.i)
    .slice(0, PRICE_REASKS)
    .map(({ q }) => q);
}

// A question's answer as Confirm's list shows it: what a visitor gets, whether the check replaced it,
// and whether it needs a person. Pure.
export function priceReask(q: RunQuestion): PriceReask {
  const gets = q.visitorGets;
  return {
    question: q.question,
    answer: plainQuote(gets?.answer ?? q.answer ?? q.hiddenAnswer ?? ""),
    ...(gets && { replaced: gets.pointer ? "link" : "rows" }),
    ...(openHold(q) && { held: true }),
  };
}

// The rows the price configuration's prompt lists (prompt.ts pricesParagraph): the confirmed table,
// else the rows read from the pricing page whose names may well be plans. Pure.
export function promptPrices(d: {
  priceTable?: PriceTable | null;
  priceTableConfirmation?: Parameters<typeof confirmedTable>[0]["priceTableConfirmation"];
}): PriceRow[] {
  return confirmedTable(d)?.rows ?? provisionalTable(d.priceTable?.rows ?? [])?.rows ?? [];
}

// A reply's words quoted in a hold's line, without its Markdown (round 7: "**Contact Mews**" showed
// its asterisks in validation and Review).
export const plainQuote = (text: string): string =>
  text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\*\*|__|`/g, "")
    .replace(/(^|\s)[*_](\S[^*_]*?)[*_](?=[\s.,;:!?)]|$)/g, "$1$2");

// What a held answer lacks, by the kind of content its question asks for.
const KIND_NOUN: Record<string, string> = { price: "price", date: "date", contact: "contact details", steps: "steps" };

// One question's answer, judged as the widget judges it, then checked for leaks, its language
// (when `expected` is known) and flags, with the page to compare a flagged figure against, and
// the Check this signals (very short, or sources not about the question). A reply that claims
// something is missing or over, with nothing of the kind asked on the pages it cites, may not
// answer: held, shown as written (round 5). A cited answer the chat would still hide (low
// relevance, nothing grounded) is held with its text. A starter question with no answer fails:
// visitors click it first.
// The question asks for a phone number or an email address, and the answer gives one, with no
// claim that it's missing. Pure.
const ASKS_NUMBER =
  /\b(?:phone|telephone|tel\.?|call|hotline|telefon\w*|rufnummer|tel[ée]fono|t[ée]l[ée]phone|telefoon\w*|numero|número|número de teléfono|whatsapp)\b/i;
const ASKS_EMAIL = /\b(?:e-?mail|mail address|correo|courriel)\b/i;
const A_PHONE = /(?:\+?\d[\d\s().-]{6,}\d)/;
const AN_EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/;
export function directContactAnswer(question: string, answer: string): boolean {
  if (negativeClaim(answer, undefined, question)) return false;
  return (ASKS_NUMBER.test(question) && A_PHONE.test(answer)) || (ASKS_EMAIL.test(question) && AN_EMAIL.test(answer));
}

export function judgeAnswer(
  q: DraftQuestion | string,
  result: AskResult,
  overview: (source: { title: string; url: string }) => boolean = (s) => isOverviewPage(s),
  language?: { expected: Language; followsVisitor: boolean },
  context: JudgeContext = {},
): RunQuestion {
  const { question, own, starter, intent, wording } =
    typeof q === "string" ? { question: q, own: false, starter: false, intent: undefined, wording: undefined } : q;
  const fallback = isFallbackQuestion(question);
  const text = (result.answer ?? "").trim();
  const resourcesAll = result.retrieval_results?.resources ?? {};
  const reading = readReply({
    answer: text,
    status: typeof result.status === "string" ? result.status : undefined,
    best: bestScore(resourcesAll),
    citations: result.citations,
    resources: resourcesAll,
    augmented: result.augmented_context,
    question,
    ...(language && { language: language.expected }),
  });
  // A direct answer to a request for a number or an address isn't a substitute for it (verdict() can't
  // tell: clopaydoor.com's "call us at 1-844-553-8453" to "What is your customer support phone
  // number?" was held as "gives a step for something else"). This changes validation's reading only.
  const v = reading.verdict === "substituted" && directContactAnswer(question, text) ? "answered" : reading.verdict;
  // What the visitor reads: the model's words, or the widget's own no-answer text.
  const answer = showsModelText(v) ? text : "";
  const answered = isAnswered(v);
  const holds: Hold[] = [];
  if (v === "may-not-answer") {
    const claim = reading.claim ?? negativeClaim(text, language?.expected, question);
    const kind = askedKind(question);
    holds.push({
      by: "claim",
      clear: "decide",
      text: `It may not answer: it says “${plainQuote(claim?.sentence ?? text)}” and gives no ${KIND_NOUN[kind ?? ""] ?? "answer"} from the site.`,
    });
  }
  if (v === "deflection")
    holds.push({
      by: "claim",
      clear: "decide",
      text: `It may not answer: it only points elsewhere (“${plainQuote(reading.pointer ?? text)}”), with nothing from the site about the question.`,
    });
  if (v === "substituted")
    holds.push({
      by: "claim",
      clear: "decide",
      text: `It may not answer: it gives a step for ${reading.substitute?.offered ?? "something else"}, but none for ${reading.substitute?.asked ?? "what was asked"}.`,
    });
  const cited = Object.keys(result.citations ?? {}).length > 0;
  const hidden = v === "low-relevance" && text && cited ? text : undefined;
  if (hidden)
    holds.push({
      by: "hidden",
      clear: "decide",
      text: "Visitors won't see this answer (low relevance): the chat shows its no-answer reply.",
    });
  // The pages the answer drew on, with their cited passages, and of those the links visitors see
  // under it: the widget's own picking (pickSources in @launchpad/theme), so validation and the
  // picker show exactly what the chat shows (round 5).
  const resources = (result.retrieval_results?.resources ?? {}) as Record<string, RetrievedResource>;
  const candidates = answered ? citedSources(resources, result.citations ?? {}) : [];
  const sources = answered
    ? pickSources(candidates, { question, answer, language: language?.expected, brand: context.chatName, resources }).map((s) => ({
        title: s.title,
        url: s.href,
      }))
    : [];
  const checks = answered
    ? answerChecks({
        question,
        answer,
        sources: candidates.map((c) => {
          const lang = context.pageLanguage?.(c.href) ?? c.language;
          return { title: c.title, ...(c.passages.length && { text: c.passages.join("\n") }), ...(lang && { language: lang }) };
        }),
        brand: context.brand,
      })
    : [];
  // The price table check, on any answer visitors read: before the judge, and without it.
  // A reply visitors won't see (low relevance) is checked too: its denial of a listed price is
  // still a contradiction to name. Against the confirmed table, else the pricing page's own
  // pairings (round 7).
  const checkedText = answer || (v === "low-relevance" ? text : "");
  const priceTable = context.priceTable ?? context.pricingFacts;
  const priced = checkedText
    ? priceTableCheck(checkedText, priceTable, citedPages(result), language?.expected, {
        question,
        provisional: !context.priceTable,
        ...(context.pricingLines && { pricingLines: context.pricingLines }),
      })
    : undefined;
  if (priced) holds.push(...priced.holds);
  // What the chat shows instead, when it won't show this reply (the widget's own check): the run says
  // so in those words. Only the link, on a plain "how much?", is a failure to fix, not an answer.
  const replaced = answer
    ? priceReplacement(
        question,
        answer,
        context.priceTable,
        candidates.map((c) => ({ title: c.title, href: c.href })),
        widgetStrings(language?.expected ?? "en"),
        language?.expected,
        context.priceTable ? undefined : context.pricingFacts,
      )
    : undefined;
  if (replaced?.pointer && priceTable && (intent === "price" || plainPriceQuestion(question, priceTable)))
    holds.push({
      by: "price",
      clear: "decide",
      text: `Visitors get only "${replaced.answer}" with a link, and no price, on a plain price question. Correct the table's rows, or say why that's right.`,
    });
  const flags = (
    answered
      ? answerFlags(
          answer,
          sources.map((s) => ({ url: s.url, overview: overview(s) })),
        )
      : []
  ).filter((f) => !(f === "price" && priced?.matched));
  const figures = flags.filter((f) => f === "price" || f === "date");
  const check = figures.length
    ? sourceToCheck(
        answer,
        figures,
        result,
        // Else the first page the answer drew on, shown or not.
        sources[0] ?? (candidates[0] && { title: candidates[0].title, url: candidates[0].href }),
      )
    : undefined;
  const said = answer && language ? languageVerdict(answer, language) : {};
  // A held reply visitors read (may not answer, a deflection, a substitution) is a hold, which a named
  // person can keep, not a starter's failure (round 6, item 4).
  const heldReply = v === "may-not-answer" || v === "deflection" || v === "substituted";
  const failures = [
    starter && !answered && !heldReply && STARTER_FAILURE,
    answer && leaksInternals(answer) && LEAK_FAILURE,
    said.failure,
  ].filter((f): f is string => Boolean(f));
  return {
    question,
    answer,
    sources,
    answered,
    // A fallback question is nobody's own.
    ...(own && !fallback && { own }),
    ...(starter && { starter: true as const }),
    ...(intent && !fallback && { intent }),
    ...(intent && !fallback && wording && { wording }),
    ...(fallback && { fallback }),
    ...(failures.length && { failure: failures.join("; ") }),
    ...(flags.length && { flags }),
    ...(said.check && { languageCheck: said.check }),
    ...(check && { check }),
    ...(replaced && { visitorGets: { answer: replaced.answer, ...(replaced.pointer && { pointer: true as const }) } }),
    ...((v === "may-not-answer" || v === "deflection" || v === "substituted") && { declined: true as const }),
    ...(v === "partly" && { partly: true as const }),
    ...(checks.length && { checks }),
    ...(holds.length && { holds }),
    ...(hidden && { hiddenAnswer: hidden }),
    ...(priced?.matched && { tableMatched: true as const }),
    ...(priced?.pageAgrees && { pageAgrees: true as const }),
    verdict: v,
  };
}

// The judge's verdict and the key pages' evidence added to a judged answer: each can only hold it
// (judgeOutcome), never release it. "partly" is a Check this that I checked it clears; the others
// hold it until it's asked again and answered, reworded, or decided with a reason.
export function withJudgement(
  q: RunQuestion,
  judged: { verdict: JudgeVerdict | "unavailable"; reason: string } | undefined,
  evidence: { holds: Hold[]; keyFacts?: EvidencePage[] } = { holds: [] },
  // The answer's content of the kind asked is on the pages it cites, and it claims nothing missing.
  opts: { grounded?: boolean; noUpcomingDates?: boolean } = {},
): RunQuestion {
  const holds = [...(q.holds ?? []), ...evidence.holds];
  const outcome = judgeOutcome(judged?.verdict);
  // The judge reads a few passages, not the site: when every figure the answer states sits on a
  // synced page (locateFigures), its "contradicts" on a figure is a Check this the price check
  // already asks for, never a hold (live, 2026-10-31: it called telerik.com's DevCraft Complete
  // $1,299 a contradiction, reading DevCraft UI's $1,149).
  const located = Boolean(q.figures?.length && q.figures.every((f) => f.page));
  // Round 6: an answer whose content of the kind asked is on the pages it cites, with no claim that
  // something is missing, isn't held by the judge alone: on held-out sites its holds on such
  // answers were mostly wrong (details the passages it read didn't show). Its verdict is kept and
  // shown (off-topic too: content of the kind asked on the cited pages isn't off-topic).
  // Every price it states is the confirmed table's, for its plan, from the pricing page: the judge's
  // "contradicts" is information, the table being the ground truth (round 6, item 1).
  // Round 7: never on a price, though. The judge's "contradicts" on an answer that states a price
  // stays a hold whatever grounding or a table match says (a figure on the page, paired with
  // another plan, is grounded and "matched" a mis-named table). It's a Check this only when the
  // figure-to-plan pairing was checked: every figure placed on a synced page, or the confirmed
  // table matching each plan the answer names.
  const pricedClaim = judged?.verdict === "contradicts" && answerFigures(q.answer || q.hiddenAnswer || "", ["price"]).length > 0;
  // Round 7, 7c: a substitution is what grounding can't see (a date for a related thing is on the page),
  // so it's never advisory. And an answer every figure of which a person's confirmed table pairs with
  // the plan it names isn't held by the judge at all: the table is the ground truth, and annual and
  // monthly prices of one plan aren't a conflict ($17/$20 on SavvyCal, 3 of 3).
  const onTable =
    (q.tableMatched === true || q.pageAgrees === true) &&
    !q.declined &&
    (judged?.verdict === "contradicts" || judged?.verdict === "partly");
  // "None upcoming" where no date is still to come, and the judge's objection names only past dates.
  const pastOnly = opts.noUpcomingDates === true && judged?.verdict === "contradicts" && pastDatesOnly(judged.reason, new Date());
  const advisory = onTable || pastOnly || (!pricedClaim && opts.grounded === true && judged?.verdict !== "substituted");
  if (judged && isJudgeVerdict(judged.verdict) && outcome !== "none" && !advisory) {
    const checked = (located || q.tableMatched === true) && judged.verdict === "contradicts" && !q.declined;
    holds.push({
      by: "judge",
      clear: outcome === "hold" && !checked ? "decide" : "check",
      text: `${JUDGE_TEXT[judged.verdict]}${judged.reason ? `: ${judged.reason.replace(/\.?$/, ".")}` : "."}`,
    });
  }
  return {
    ...q,
    ...(judged && isJudgeVerdict(judged.verdict) && { judge: { verdict: judged.verdict, reason: judged.reason } }),
    ...(holds.length && { holds }),
    ...(evidence.keyFacts?.length && { keyFacts: evidence.keyFacts }),
  };
}

// "No upcoming events" where the site's pages hold no date still to come: true as far as anything here
// can tell, so it's an answer for a person to check once, not a hold needing a typed reason
// (clopaydoor.com's "No upcoming Clopay webinar or event is listed", beside a past tour's date, and
// reopened each run). Only on a question about events, and only with the rules' or the judge's doubt
// no firmer than that: the judge's "contradicts" naming only dates already past is advice. Pure.
export function trueNoEvents(q: RunQuestion, site: SiteFacts, today: Date): RunQuestion {
  if (!q.declined || askedKind(q.question) !== "date" || site.events?.length) return q;
  if (!/\b(?:event|webinar|conference|seminar|veranstaltung\w*|evento|événement|evenement)/i.test(q.question)) return q;
  const { declined: _declined, ...rest } = q;
  const holds = (q.holds ?? []).map((h) =>
    h.by === "claim"
      ? {
          ...h,
          clear: "check" as const,
          text: `It says there are none, and no page read states a date still to come (today is ${today.toISOString().slice(0, 10)}). Check it once.`,
        }
      : h,
  );
  return { ...rest, answered: true, partly: true, holds };
}
export function pastDatesOnly(text: string, today: Date): boolean {
  const day = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const dates = [...bothDays(text).matchAll(FULL_DATE)];
  if (!dates.length) return false;
  return dates.every((m) => {
    const month = TENSE_MONTHS[(m[3] ?? m[5] ?? "").toLowerCase()] ?? 0;
    return Date.UTC(Number(m[4] ?? m[8]), month - 1, Number(m[2] ?? m[7] ?? m[1] ?? m[6])) < day;
  });
}

// ---- the evidence check: claims against the key pages' facts (round 5, item 2) ----

// A key page's facts as lib/content.ts keyFacts gives them, and a date still to come as
// upcomingEvents gives it.
export interface KeyPageFacts {
  url: string;
  title?: string;
  intent: string;
  facts: PageFacts;
}
export interface UpcomingDate {
  date: string;
  line: string;
  readAs: string;
  url: string;
  title?: string;
}
export interface SiteFacts {
  // The price and buy key pages (keyFacts(id, "price")).
  price?: readonly KeyPageFacts[];
  // The contact and support key pages (keyFacts(id, "contact")).
  contact?: readonly KeyPageFacts[];
  // Dates still to come on any synced page, soonest first.
  events?: readonly UpcomingDate[];
}

const pathOf = (url: string) => {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
};
const listOf = (items: readonly string[]) => (items.length > 1 ? `${items.slice(0, -1).join(", ")} and ${items.at(-1)}` : (items[0] ?? ""));
// A price figure's digits, whatever its format: "$2,205", "2.205 US-Dollar" and "2 205 $" are 2205.
// Track A's figureValue (round 6): "1 250 €" and "1.250 €" are 1250, "37,5 €" equals "37,50 €".
export const priceKey = (text: string): string | undefined => figureValue(text);

// A fact that can count as evidence: a price with its digits on its own line, a contact that isn't
// two lines glued together ("2128700sales@teamwork.com", teamwork.com, round 6). A glued or
// unreadable fact never counts against an answer.
const readablePrice = (x: { figure: string; line: string }) => {
  const key = priceKey(x.figure);
  return Boolean(key && key.length >= 1 && x.line.replace(/\D/g, "").includes(key));
};
const readableContact = (c: { kind: string; value: string }) =>
  c.kind === "phone" ? c.value.replace(/\D/g, "").length >= 7 : c.kind === "email" ? !/^\d{4,}/.test(c.value) : false;
// A page that announces events, by its address, title or the line with the date: a subsidy
// deadline on a blog post isn't an event (teamleader.eu, round 6).
const EVENT_PAGE =
  /webinar|event|veranstalt|evento|événement|evenement|conference|konferenz|seminar|workshop|meetup|summit|livestream|session/i;

// A date as its own line proves it: a line stating another day of the same year is read as stated
// (recheck-R2: "4 November 2026, as written" on a line saying "on Thursday, November 5, 2026", which
// held a right answer on all 3 runs), soonest first again. Pure.
export function provedDates<T extends { date: string; readAs: string; line: string }>(events: readonly T[]): T[] {
  const fixed = events.map((e) => {
    const [y, m, d] = e.date.split("-");
    const stated = dateKeys(e.line);
    const key = `${Number(m)}-${Number(d)}`;
    if (!stated.length || stated.includes(key) || !y) return e;
    const [month, day] = (stated[0] as string).split("-");
    const date = `${y}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    const readAs = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(
      new Date(`${date}T12:00:00Z`),
    );
    return { ...e, date, readAs };
  });
  return fixed.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

// A date in an answer given to something the site gives another date: each dated sentence or list item
// names something (beyond the frame and the client's name), and no line stating that date, or the few
// lines around it, says any of it (recheck-R2: SEEBURGER's German list gave the Summit's end date to
// GS1 EXCHANGE, every date on the page, each on the wrong event, and was marked Answered). A Check this:
// lines are short and sites write names differently. Pure.
export function datePairingHold(answer: string, passages: readonly string[], brand?: string): Hold | undefined {
  if (!answer || !passages.length) return undefined;
  const lines = passages
    .flatMap((p) => p.split(/\n+/))
    .map((l) => l.trim())
    .filter(Boolean);
  const named = new Set(matchWords(brand ?? ""));
  const months = /^(?:jan|feb|mar|apr|may|mai|jun|jul|aug|sep|oct|okt|nov|dec|dez)/;
  const wrong: string[] = [];
  for (const item of answer.split(/\n+|(?<=[!?]|(?<!\d)\.)\s+(?=\p{Lu})/u)) {
    const dates = datesIn(item);
    if (!dates.length) continue;
    let rest = item;
    for (const d of dates) rest = rest.replace(d.text, " ");
    const words = matchWords(plainQuote(rest)).filter((w) => !named.has(w) && !months.test(w) && !/^\d/.test(w) && !isFrame(w));
    if (words.length < 2) continue;
    for (const d of dates) {
      const places = lines.flatMap((l, i) => (dateKeys(l).includes(d.key) ? [i] : []));
      if (!places.length) continue;
      // A card names its event on the date's line or the two before; or in a heading right after it.
      const near = places.some((i) => {
        const after = lines.slice(i + 1, i + 3).filter((l) => l.startsWith("#"));
        return relatedWords(words, matchWords([...lines.slice(Math.max(0, i - 2), i + 1), ...after].join(" "))) > 0;
      });
      if (!near) wrong.push(d.text);
    }
  }
  if (!wrong.length) return undefined;
  return {
    by: "evidence",
    clear: "check",
    text: `${listOf([...new Set(wrong)])}: the lines on the page stating ${wrong.length === 1 ? "this date don't" : "these dates don't"} name what this answer gives ${wrong.length === 1 ? "it" : "them"} to. Check each date against its event.`,
  };
}

// A figure on no page of a site with no prices at all, whatever it pairs with (quote-only, or no pricing
// page): invented, judge on or off (round 7: "Procore costs $375 per month" had only a price flag with
// the judge off). Pure.
export function inventedPriceHold(figures: readonly FigureCheck[]): Hold | undefined {
  const stray = figures.filter((f) => f.kind === "price" && !f.page && amount(f.figure) !== "0");
  if (!stray.length) return undefined;
  return {
    by: "evidence",
    clear: "decide",
    text: `${listOf(stray.map((f) => f.figure))} ${stray.length === 1 ? "is" : "are"} on no synced page, and this site lists no prices.`,
  };
}

// Holds from the key pages' facts, for an intent question, a starter, or any answer that partly
// answers or may not answer (round 6: at most about one false hold per site):
// - price: the question is a price intent question or the answer makes a claim; the answer states
//   no price at all, while the right price key page states readable figures. The right page is one
//   the answer cites, else every price key page. An answer that states a figure isn't held here
//   (uncitedPriceHold checks where its figures are).
// - events: it says there's no upcoming event, or that one has passed, while an events page states
//   a date still to come; or, asked what's next, it names a later event first.
// - contact: it says there's no phone or email while the contact page lists a readable one.
// For a No answer, the same facts come back as keyFacts, for the panel to lead with. Pure.
export function evidenceHolds(
  question: string,
  answer: string,
  site: SiteFacts,
  opts: { intent?: string; cited?: readonly string[] } = {},
): { holds: Hold[]; keyFacts?: EvidencePage[] } {
  const kind = askedKind(question);
  const claim = answer ? negativeClaim(answer, undefined, question) : undefined;
  const cited = new Set((opts.cited ?? []).map(sameUrl));
  const holds: Hold[] = [];
  let keyFacts: EvidencePage[] | undefined;
  if (kind === "price" && (!answer || claim || opts.intent === "price" || opts.intent === "buy")) {
    const readable = (site.price ?? []).filter((p) => p.facts.prices?.some(readablePrice));
    const own = readable.filter((p) => cited.has(sameUrl(p.url)));
    // Else the intent's main page only (keyFacts sorts it first: teamwork.com's /pricing/, not the
    // add-on's /desk/pricing/).
    const pages = own.length ? own : readable.slice(0, 1);
    if (pages.length) {
      const stated = pages.flatMap((p) => (p.facts.prices ?? []).filter(readablePrice));
      const evidence = pages.map((p) => ({
        url: p.url,
        ...(p.title && { title: p.title }),
        lines: (p.facts.prices ?? [])
          .filter(readablePrice)
          .map((x) => x.line)
          .slice(0, 6),
      }));
      const figs = [...new Set(stated.map((s) => s.figure))].slice(0, 4);
      const first = pages[0] as KeyPageFacts;
      const label = `${first.intent === "buy" ? "buying" : "pricing"} page ${pathOf(first.url)}`;
      if (!answer) keyFacts = evidence;
      else if (!answerFigures(answer, ["price"]).length) {
        holds.push({
          by: "evidence",
          clear: "decide",
          text: `The ${label} states ${listOf(figs)}; this answer gives ${figs.length === 1 ? "no price" : figs.length === 2 ? "neither" : "none of them"}.`,
          pages: evidence,
        });
      }
    }
  }
  if (kind === "date" || claim?.expiry) {
    const upcoming = provedDates(site.events ?? []).filter((e) => EVENT_PAGE.test(`${e.url} ${e.title ?? ""} ${e.line}`));
    const next = upcoming[0];
    if (next) {
      const evidence = [...new Map(upcoming.map((e) => [e.url, e])).values()].slice(0, 3).map((e) => ({
        url: e.url,
        ...(e.title && { title: e.title }),
        lines: upcoming.filter((u) => u.url === e.url).map((u) => `${u.readAs}: ${u.line}`),
      }));
      const key = (iso: string) => {
        const [, m, d] = iso.split("-");
        return `${Number(m)}-${Number(d)}`;
      };
      const named = dateKeys(answer);
      const upcomingKeys = new Set(upcoming.map((e) => key(e.date)));
      const firstNamed = named.find((k) => upcomingKeys.has(k));
      if (!answer && kind === "date") keyFacts = evidence;
      else if (claim) {
        holds.push({
          by: "evidence",
          clear: "decide",
          text: `${pathOf(next.url)} states ${next.readAs}; this answer ${claim.expiry ? "says it's over or only on demand" : "says there's none"}.`,
          pages: evidence,
        });
      } else if (
        kind === "date" &&
        /\bnext\b|nächste|próxim|prochain|prossim|volgende/i.test(question) &&
        firstNamed &&
        firstNamed !== key(next.date)
      ) {
        holds.push({
          by: "evidence",
          clear: "decide",
          text: `The next event is on ${next.readAs} (${pathOf(next.url)}); this answer names a later one first.`,
          pages: evidence,
        });
      }
    }
  }
  if (kind === "contact") {
    const pages = (site.contact ?? []).filter((p) => p.facts.contacts?.some(readableContact));
    if (pages.length) {
      const evidence = pages.map((p) => ({
        url: p.url,
        ...(p.title && { title: p.title }),
        lines: (p.facts.contacts ?? [])
          .filter(readableContact)
          .map((c) => c.line)
          .slice(0, 6),
      }));
      const values = pages.flatMap((p) => (p.facts.contacts ?? []).filter(readableContact).map((c) => c.value)).slice(0, 3);
      // An answer that gives a phone number or an email itself doesn't say there's none, whatever
      // else it says is missing (round 7: planetmagpie's answers listing 510-344-1180 were held).
      const givesContact =
        /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/.test(answer) ||
        [...answer.matchAll(/\+?\d[\d\s().\-–]{6,}\d/g)].some((m) => m[0].replace(/\D/g, "").length >= 7);
      if (!answer) keyFacts = evidence;
      else if (claim && !givesContact) {
        holds.push({
          by: "evidence",
          clear: "decide",
          text: `The contact page ${pathOf(pages[0]?.url ?? "")} lists ${listOf(values)}; this answer says there's none.`,
          pages: evidence,
        });
      }
    }
  }
  return { holds, ...(keyFacts && { keyFacts }) };
}

// The tighter price check: a price the answer states passes only when a page it cites or a price
// key page states it, not any page on the site (round 5: the exec's ThemeBuilder price, found
// only on another product's page). Pure.
export function uncitedPriceHold(figures: readonly FigureCheck[], cited: readonly string[], keyPages: readonly string[]): Hold | undefined {
  const ok = new Set([...cited, ...keyPages].map(sameUrl));
  // Round 6: an answer that cites a price key page is read from it, wherever else a small figure
  // also appears (teamleader.eu: "€5" placed on a blog post while /nl-be/prijs states it), and a
  // one-digit figure says too little to hold on.
  const keys = new Set(keyPages.map(sameUrl));
  if (cited.some((u) => keys.has(sameUrl(u)))) return undefined;
  const stray = figures.filter(
    (f) => f.kind === "price" && f.page && !ok.has(sameUrl(f.page.url)) && f.figure.replace(/\D/g, "").replace(/0+$/, "").length >= 2,
  );
  if (!stray.length) return undefined;
  const where = [...new Set(stray.map((f) => pathOf(f.page?.url ?? "")))];
  return {
    by: "evidence",
    clear: "decide",
    text: `${listOf(stray.map((f) => f.figure))} ${stray.length === 1 ? "is" : "are"} only on ${listOf(where)}, which the answer doesn't cite and isn't a pricing page.`,
    pages: stray.flatMap((f) => (f.page ? [{ url: f.page.url, title: f.page.title, lines: f.excerpt ? [f.excerpt] : [] }] : [])),
  };
}

// An answer that gives a figure as the pricing page's ("Our Pricing page says paid plans start at
// $12/month") when no price key page states it: a hold naming where the figure is (round 7: a blog
// post's $12 reached visitors as the pricing page's). Pure.
const ATTRIBUTES_PRICING =
  /(?<![\p{L}])(?:pric(?:ing|e list)|plans?(?: (?:&|and) pricing)?|shop|store|buy\p{L}*)(?:\s+\p{L}+)?\s+page(?:\s+\p{L}+){0,3}?\s+(?:says?|states?|lists?|shows?|gives?|notes?|mentions?)|according to (?:our |the )?(?:\p{L}+\s+){0,3}?pric(?:ing|e) page/iu;
export function pricingProvenanceHold(
  answer: string,
  figures: readonly FigureCheck[],
  pricingPages: readonly { url: string; title?: string; facts: PageFacts }[],
): Hold | undefined {
  if (!pricingPages.length || !answer) return undefined;
  const claims = answer.split(/\n+|(?<=[.!?])\s+/).filter((c) => ATTRIBUTES_PRICING.test(c));
  if (!claims.length) return undefined;
  const onPricing = new Set(pricingPages.flatMap((p) => (p.facts.prices ?? []).flatMap((x) => priceKey(x.figure) ?? [])));
  const keys = new Set(pricingPages.map((p) => sameUrl(p.url)));
  const said = claims.flatMap((c) => priceAmounts(c).map((f) => f.text));
  const stray = [...new Set(said)].filter((text) => {
    const key = priceKey(text);
    return key && !onPricing.has(key);
  });
  if (!stray.length) return undefined;
  const where = (text: string) =>
    figures.find((f) => f.kind === "price" && priceKey(f.figure) === priceKey(text) && f.page && !keys.has(sameUrl(f.page.url)));
  const placed = stray.map((t) => ({ t, f: where(t) }));
  const pricing = pathOf(pricingPages[0]?.url ?? "");
  const parts = placed.map(({ t, f }) => (f?.page ? `${t} is on ${pathOf(f.page.url)}` : `${t} isn't on any synced page`));
  return {
    by: "evidence",
    clear: "decide",
    text: `This answer gives ${listOf(stray)} as the pricing page's, but ${pricing} doesn't state ${stray.length === 1 ? "it" : "them"}: ${parts.join("; ")}.`,
    pages: placed.flatMap(({ f }) => (f?.page ? [{ url: f.page.url, title: f.page.title, lines: f.excerpt ? [f.excerpt] : [] }] : [])),
  };
}

// A price table contradiction nobody decided with a reason.
export const openContradiction = (q: RunQuestion): boolean =>
  Boolean(q.holds?.some((h) => h.by === "price") && !q.notCovered && !q.acknowledged?.reason);

// A hold nobody has decided yet: a person's I checked it clears one that asks for a check, and
// for one that asks for a decision only with a reason; "The site doesn't cover this" clears both.
export const openHold = (q: ValidationQuestion): boolean => {
  const r = q as RunQuestion;
  if (!r.holds?.length || r.notCovered) return false;
  if (!r.acknowledged) return true;
  return r.holds.some((h) => h.clear === "decide") && !r.acknowledged.reason;
};

// Waiting for a person: a flag, a language check, a Check this signal or a hold nobody has
// acknowledged yet. A Check this answer someone marked "The site doesn't cover this" is decided
// too (round 5).
export const needsCheck = (q: ValidationQuestion): boolean =>
  openHold(q) ||
  Boolean(
    (q.flags?.length || (q as RunQuestion).languageCheck || (q as RunQuestion).checks?.length) &&
      !q.acknowledged &&
      !(q as RunQuestion).notCovered,
  );

// A Check this answer (very short, or off-source) nobody has checked yet: it doesn't count as
// answered until someone does (round 5: "9 of 10 answered" counted "Contact Support.").
export const uncheckedCheckThis = (q: ValidationQuestion): boolean =>
  Boolean(q.answered && (q as RunQuestion).checks?.length && !q.acknowledged && !(q as RunQuestion).notCovered);

// Answered, or held as "may not answer" (or hidden) and kept by a person with a reason: the reply
// visitors see answers after all.
const answeredOrKept = (q: ValidationQuestion): boolean => {
  const r = q as RunQuestion;
  return q.answered || Boolean((r.declined || r.hiddenAnswer) && r.holds?.length && r.acknowledged?.reason);
};
// Counts toward the answered share: answered (and checked, when it's a Check this or held), or a
// question a person said the site doesn't cover (the chat gives the no-answer reply and the handoff).
const passing = (q: ValidationQuestion): boolean =>
  (answeredOrKept(q) && !uncheckedCheckThis(q) && !openHold(q)) || Boolean((q as RunQuestion).notCovered);
// No answer at all, and nobody's decision.
const noAnswerOpen = (q: ValidationQuestion): boolean => !answeredOrKept(q) && !(q as RunQuestion).notCovered;

// An intent question or the partner's own with No answer and nobody's decision yet: the run says
// "Not yet" until someone fixes it (adds the pages that answer it) or says the site doesn't cover
// it. Starters fail outright instead; generated questions keep the pass threshold.
export const needsDecision = (q: ValidationQuestion): boolean => {
  const r = q as RunQuestion;
  return Boolean((r.intent || r.own) && !r.starter && !q.failure && noAnswerOpen(q) && !isFallbackQuestion(q.question));
};

// A generated question with No answer that nobody decided about: the run can pass without it, and
// says so ("Passed: 1 question with No answer and no decision"), and Review lists it.
export const undecidedNoAnswer = (q: ValidationQuestion): boolean => {
  const r = q as RunQuestion;
  return !r.intent && !r.own && !r.starter && !q.failure && noAnswerOpen(q) && !isFallbackQuestion(q.question);
};

// The run in numbers. Fallback questions are shown and asked, but count as neither generated nor
// the partner's own, and not in the answered share; their failures and flags still count.
export function runCounts(questions: readonly ValidationQuestion[]) {
  const counted = questions.filter((q) => !isFallbackQuestion(q.question));
  const answered = counted.filter(passing).length;
  return {
    counted: counted.length,
    own: counted.filter((q) => q.own).length,
    answered,
    // Of those, decided "the site doesn't cover this": they pass, but weren't answered.
    notCovered: counted.filter((q) => Boolean((q as RunQuestion).notCovered)).length,
    needed: Math.ceil(counted.length * PASS_SHARE),
    fallback: questions.length - counted.length,
    unanswered: counted.filter((q) => !passing(q)),
    failed: questions.filter((q) => q.failure),
    unchecked: questions.filter(needsCheck).length,
    // Intent and own questions with No answer and no decision: each holds the pass.
    undecided: questions.filter(needsDecision),
    // Generated questions with No answer and no decision: the pass doesn't wait for them.
    noDecision: questions.filter(undecidedNoAnswer),
  };
}

// Everything the gate needs from validation: enough questions with two of the partner's own,
// enough of them answered, nothing failing (a starter with no answer included), every flagged or
// Check this answer checked by a person, and a decision on every intent or own question with No
// answer. Given the widget's starters, also every one of them asked.
export function validationPassed(questions: readonly ValidationQuestion[], starters?: readonly string[]): boolean {
  const c = runCounts(questions);
  const asked = !starters || startersNotAsked({ at: "", passed: false, questions: [...questions] }, starters).length === 0;
  return (
    asked &&
    c.counted >= MIN_QUESTIONS &&
    c.own >= OWN_QUESTIONS &&
    c.answered >= c.needed &&
    !c.failed.length &&
    !c.unchecked &&
    !c.undecided.length
  );
}

// "Passed: 1 question with No answer and no decision", for the result and Review.
export function passedNote(validation: ValidationResult | null | undefined): string | undefined {
  const n = validation ? runCounts(validation.questions).noDecision.length : 0;
  return n ? `Passed: ${n} question${n === 1 ? "" : "s"} with No answer and no decision` : undefined;
}

// Whether answers actually failed, apart from flags still waiting for a person: for alerts.
export function answersFailed(questions: readonly ValidationQuestion[]): boolean {
  const c = runCounts(questions);
  return c.failed.length > 0 || c.answered < c.needed;
}

// For the review screen: flagged answers (and language checks) nobody has checked yet.
export const unacknowledgedFlags = (validation: ValidationResult | null | undefined): number =>
  validation?.questions.filter(needsCheck).length ?? 0;

// What stands between a run and a pass, all at once (failures and checks together), in the
// words of the panel's "To pass:" line, for the review too.
export function passReasons(validation: ValidationResult | null | undefined): string[] {
  if (!validation) return [];
  const c = runCounts(validation.questions);
  const short = MIN_QUESTIONS - c.counted;
  const n = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;
  const held = validation.questions.filter(openHold).length;
  const prices = validation.questions.filter((q) => needsCheck(q) && !openHold(q) && q.flags?.includes("price")).length;
  return [
    held > 0 && `${n(held, "held answer")} to ask again, reword or decide`,
    short > 0 &&
      (c.fallback ? `rewrite the ${n(c.fallback, "“tell me about” question")}, or add ${short} more` : `ask ${n(short, "more question")}`),
    c.own < OWN_QUESTIONS && `add ${n(OWN_QUESTIONS - c.own, "of your own question", "of your own questions")}`,
    c.answered < c.needed && `${c.needed - c.answered} more answered`,
    c.undecided.length > 0 &&
      `${n(c.undecided.length, "No answer")} to fix or mark “The site doesn't cover this” (${c.undecided.map((q) => `“${q.question}”`).join(", ")})`,
    c.failed.length > 0 && `${n(c.failed.length, "answer")} failing`,
    prices > 0 && `${n(prices, "price")} to check`,
    c.unchecked > prices + held && `${n(c.unchecked - prices - held, "other answer")} to check`,
  ].filter((r): r is string => Boolean(r));
}

// The run asked while the first sync was still loading pages, recently enough to run again by
// itself once the sync has finished (rerunDue).
export function rerunsItself(validation: ValidationResult | null | undefined, now = new Date()): boolean {
  const run = asRun(validation);
  return Boolean(run?.content?.partial) && !(now.getTime() - Date.parse(run?.at ?? "") > RERUN_WITHIN_MS);
}

// For the result and the review screen: the run asked while the first sync was still loading
// pages, so it runs again by itself once the sync has finished (or, from before that rule, needs
// running again).
export function partialContentNote(validation: ValidationResult | null | undefined, now = new Date()): string | undefined {
  const c = asRun(validation)?.content;
  if (!c?.partial) return undefined;
  return `Ran on partial content: ${c.answerable} of ${c.total} pages were answerable, early in the first sync. ${
    rerunsItself(validation, now) ? "It runs again by itself when the sync finishes." : "Run it again now that the sync has finished."
  }`;
}

// ---- every way past a problem, for the review ----

// What a question's last answer still owes, which removing it would leave unresolved: removing
// it asks for a reason (§2.2). Starters are left to the picker, where removing one is the fix.
export function outstanding(q: RunQuestion): string | undefined {
  if (q.starter) return undefined;
  if (q.failure) return `Failed: ${q.failure}`;
  if (openHold(q)) return "A held answer to decide";
  if (needsCheck(q)) return q.flags?.includes("price") ? "A price to check" : "An answer to check";
  if (!passing(q) && !isFallbackQuestion(q.question)) return "No answer";
  return undefined;
}

// Bring up to date's run: the last run's list again, with the intent questions it lacks put first
// (prepareQuestions' intents, as a new list has them). A question already in the list that asks
// what an intent asks (sameQuestion) stays where it is, as that intent. The new ones take the place
// of generated questions that left nothing outstanding, the last first and one each at most, down
// to what a new list keeps (generatedAfterIntents), so the run still asks about 10; a generated
// question with something outstanding stays, since removing it would need a reason.
export function withIntentQuestions(
  last: readonly RunQuestion[],
  intents: readonly { question: string; intent: QuestionIntent; wording?: "generic" | "named" }[],
): DraftQuestion[] {
  const listed = last.filter((q) => !q.starterOnly);
  // Each wording of an intent is its own question (round 5: generic and named, as a pair).
  const missing = intents.filter(
    (i) => !listed.some((q) => sameQuestion(q.question, i.question) || (i.wording && q.intent === i.intent && q.wording === i.wording)),
  );
  const marked = listed.map((q) => {
    const match = q.own ? undefined : intents.find((i) => sameQuestion(q.question, i.question));
    const intent = q.intent ?? match?.intent;
    const wording = q.wording ?? match?.wording;
    return {
      q,
      draft: {
        question: q.question,
        own: Boolean(q.own),
        ...(intent && { intent }),
        ...(intent && wording && { wording }),
      } satisfies DraftQuestion,
    };
  });
  const asIntents = new Set([...marked.flatMap((m) => (m.draft.intent ? [m.draft.intent] : [])), ...missing.map((i) => i.intent)]);
  const generated = (m: (typeof marked)[number]) =>
    !m.draft.own && !m.draft.intent && !m.q.starter && !isFallbackQuestion(m.q.question) && !outstanding(m.q);
  // Each new intent question takes the place of one generated question at most.
  let over = Math.min(
    missing.length,
    marked.filter((m) => !m.draft.own && !m.draft.intent && !isFallbackQuestion(m.q.question)).length -
      generatedAfterIntents(asIntents.size),
  );
  const kept = [...marked]
    .reverse()
    .filter((m) => {
      if (over > 0 && generated(m)) {
        over -= 1;
        return false;
      }
      return true;
    })
    .reverse();
  return [
    ...missing.map((i) => ({ question: i.question, own: false, intent: i.intent, ...(i.wording && { wording: i.wording }) })),
    ...kept.map((m) => m.draft),
  ];
}

// The last run's questions with something outstanding that the new list no longer asks, however
// they left it: removed, or reworded into another question.
export function removedProblems(
  last: ValidationResult | null | undefined,
  draft: readonly DraftQuestion[],
): { question: string; was: string }[] {
  const asked = new Set(draft.map((q) => questionKey(q.question)));
  return (asRun(last)?.questions ?? []).flatMap((q) => {
    const was = outstanding(q);
    return was && !asked.has(questionKey(q.question)) ? [{ question: q.question, was }] : [];
  });
}

export interface ReviewNote {
  question: string;
  reason: string;
  name: string;
  at: string;
}

// Everything Review shows about how validation got past its problems, from the latest run:
// questions removed after a problem and "The site doesn't cover this", each with who and why;
// prices checked and still to check; and the starters asked and answered ("Starter questions: 3
// chosen, 3 answered, 1 price checked by Quinton").
export function reviewNotes(validation: ValidationResult | null | undefined) {
  const run = asRun(validation);
  const questions = run?.questions ?? [];
  const note = (question: string, d: Decision): ReviewNote => ({ question, reason: d.reason, name: d.name, at: d.at });
  const priced = questions.filter((q) => q.flags?.includes("price"));
  const starters = questions.filter((q) => q.starter);
  const starterPrices = starters.filter((q) => q.flags?.includes("price"));
  const names = (qs: readonly RunQuestion[]) => [...new Set(qs.flatMap((q) => (q.acknowledged ? [q.acknowledged.name] : [])))];
  return {
    removed: (run?.removed ?? []).map((r) => ({ ...note(r.question, r), was: r.was })),
    notCovered: questions.flatMap((q) => (q.notCovered ? [note(q.question, q.notCovered)] : [])),
    // Held answers a person kept as answered, with a reason: what held each, who kept it and why.
    kept: questions.flatMap((q) =>
      q.holds?.length && q.acknowledged?.reason && !q.notCovered
        ? [
            {
              question: q.question,
              held: q.holds[0]?.text ?? "",
              reason: q.acknowledged.reason,
              name: q.acknowledged.name,
              at: q.acknowledged.at,
            },
          ]
        : [],
    ),
    pricesChecked: priced.filter((q) => q.acknowledged).length,
    pricesToCheck: priced.filter((q) => !q.acknowledged).length,
    startersAsked: starters.length,
    startersAnswered: starters.filter((q) => q.answered && !q.failure).length,
    // Beyond those: who checked the prices, the starters' own prices, and every check still
    // waiting (dates, overview pages and language included).
    pricesCheckedBy: names(priced),
    starterPrices: {
      checked: starterPrices.filter((q) => q.acknowledged).length,
      toCheck: starterPrices.filter((q) => !q.acknowledged).length,
      checkedBy: names(starterPrices),
    },
    toCheck: questions.filter(needsCheck).length,
    // Generated questions the run passed without: No answer, and nobody decided.
    noDecision: questions.filter(undecidedNoAnswer).map((q) => q.question),
    // The price question marked "The site doesn't cover this" (Review asks for a quote button then).
    priceNotCovered: questions.some((q) => q.intent === "price" && !q.answered && q.notCovered),
    // Starters the worker took off the live chat.
    startersRemoved: run?.startersRemoved ?? [],
  };
}

// The starters the widget shows, in every language it serves: the main ones and each
// translation's.
export function chosenStarters(settings: Pick<WidgetSettings, "starters" | "translations">): string[] {
  const all = [...(settings.starters ?? []), ...Object.values(settings.translations ?? {}).flatMap((t) => t?.starters ?? [])];
  const seen = new Set<string>();
  return all
    .map((q) => q.trim().replace(/\s+/g, " "))
    .filter((q) => {
      const key = questionKey(q);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

// Starters the latest run didn't ask (saved some other way than the picker, or after the run).
export function startersNotAsked(validation: ValidationResult | null | undefined, starters: readonly string[]): string[] {
  const asked = new Set((validation?.questions ?? []).map((q) => questionKey(q.question)));
  return starters.filter((q) => !asked.has(questionKey(q)));
}

// ---- running again by itself ----

// The latest run asked while the first sync was still loading pages, and the sync has since
// finished, with every page it sent processed (or 10 minutes ago): it runs again, once. A try
// that failed waits half an hour for the next. Only a run from the last day: one older than
// that (from before this rule) waits for a person, so an upgrade never re-runs a whole fleet.
export const RERUN_WITHIN_MS = 24 * 60 * 60_000;
export function rerunDue(
  validation: ValidationResult | null | undefined,
  sync: { partial: boolean; processing: number; finishedAt: Date | null },
  now: Date,
): boolean {
  const run = asRun(validation);
  if (!run?.content?.partial || sync.partial || !sync.finishedAt) return false;
  if (now.getTime() - Date.parse(run.at) > RERUN_WITHIN_MS) return false;
  const settled = sync.processing === 0 || now.getTime() - sync.finishedAt.getTime() > 10 * 60_000;
  const tried = run.autoTried && now.getTime() - Date.parse(run.autoTried.at) < 30 * 60_000;
  return settled && !tried;
}

// ---- half the pages answerable ----

// A run early in the first sync, with under half the pages answerable, tested too little: it
// runs again by itself once half are (halfwayDue), and Review and Validate say when.
export const HALF = 0.5;
export function thinRun(validation: ValidationResult | null | undefined): boolean {
  const c = asRun(validation)?.content;
  return Boolean(c?.partial && c.total && c.answerable / c.total < HALF);
}
export const halfOf = (total: number) => Math.ceil(total * HALF);

// The thin run's turn to run again: half the pages the sync takes are answerable now, the run is
// from the last day, and no try failed in the last half hour.
export function halfwayDue(
  validation: ValidationResult | null | undefined,
  now: Pick<ContentAtRun, "answerable" | "total">,
  at: Date,
): boolean {
  const run = asRun(validation);
  if (!run || !thinRun(run) || !now.total || now.answerable < halfOf(now.total)) return false;
  if (at.getTime() - Date.parse(run.at) > RERUN_WITHIN_MS) return false;
  return !(run.autoTried && at.getTime() - Date.parse(run.autoTried.at) < 30 * 60_000);
}

// "Runs again by itself at 98 of 195 pages answerable (now 83, about 3 min)": the minutes from how
// fast pages became answerable since the run, left out until that's known.
export function halfwayNote(
  validation: ValidationResult | null | undefined,
  now: Pick<ContentAtRun, "answerable" | "total"> | null | undefined,
  at = new Date(),
): string | undefined {
  const run = asRun(validation);
  const then = run?.content;
  if (!run || !then || !thinRun(run)) return undefined;
  const total = now?.total || then.total;
  const target = halfOf(total);
  const current = now?.answerable ?? then.answerable;
  const ran = `Ran with ${then.answerable} of ${then.total} pages answerable.`;
  if (current >= target) return `${ran} Half are answerable now (${current} of ${total}): it runs again by itself within a minute or two.`;
  const minutes = (at.getTime() - Date.parse(run.at)) / 60_000;
  const rate = minutes > 0.5 ? (current - then.answerable) / minutes : 0;
  const left = rate > 0 ? Math.max(1, Math.ceil((target - current) / rate)) : undefined;
  return `${ran} Runs again by itself at ${target} of ${total} pages answerable (now ${current}${left ? `, about ${left} min` : ""}).`;
}

// ---- carrying a person's checks over to a new run ----

const figureId = (f: FigureCheck) => `${f.kind}:${f.kind === "price" ? amount(f.figure) : f.figure.replace(/\D/g, "")}`;

// The same answer in substance: the same text, or the same pages under it and the same figures
// (prices and dates, by their digits). Answered or not alike.
export function sameSubstance(a: RunQuestion, b: RunQuestion): boolean {
  if (a.answer.trim() === b.answer.trim()) return true;
  if (a.answered !== b.answered) return false;
  const urls = (q: RunQuestion) => JSON.stringify([...new Set(q.sources.map((s) => sameUrl(s.url)))].sort());
  const figs = (q: RunQuestion) => JSON.stringify([...new Set(answerFigures(q.answer || q.hiddenAnswer || "", ["price", "date"]))].sort());
  if (figs(a) !== figs(b)) return false;
  // The same figures, and at least one to go by: the same answer, whichever pages the model cited.
  if (figs(a) !== "[]") return true;
  // No figures: the same pages, or a page in common and most of the same words (recheck-R2: every
  // re-run rewords, and a person repeated 2 to 6 decisions each time).
  if (urls(a) === urls(b)) return true;
  const shared = a.sources.some((s) => b.sources.some((o) => sameUrl(o.url) === sameUrl(s.url)));
  const [x, y] = [matchWords(a.answer || a.hiddenAnswer || ""), matchWords(b.answer || b.hiddenAnswer || "")];
  return shared && x.length > 0 && y.length > 0 && relatedWords(x, y) / Math.max(x.length, y.length) >= 0.5;
}

// Whether "I checked it" still holds for a new answer to the same question. The same answer and
// checks: yes. A reworded price or date answer: when every figure it states was checked against
// the same line of the same page, whether that's all the figures checked before or only some, and
// it has nothing new to check (round 4: a re-run after the first sync rewords answers).
export function checkCarries(before: RunQuestion, now: RunQuestion): boolean {
  if (!before.acknowledged || !needsCheck({ ...now, acknowledged: undefined })) return false;
  // A decision on a price table contradiction holds while the table is the same table, and only
  // for one the person saw: a new contradiction is a new answer to judge.
  // By what it says of the table, not the sentence it quotes, which every run rewords.
  const tables = (q: RunQuestion) =>
    (q.holds ?? []).filter((h) => h.by === "price").map((h) => `${h.table}|${h.text.replace(/[“(][^”)]*[”)]/g, "")}`);
  if (tables(now).some((t) => !tables(before).includes(t))) return false;
  // Round 6: the same answer, or the same answer reworded (the same pages under it and the same
  // figures), keeps a person's decision, whatever the judge or the rules now say about its
  // wording: every run rewords, and decisions were lost on every run (teamwork.com, teamleader.eu).
  const flags = now.flags ?? [];
  const within = <T>(a: readonly T[] | undefined, b: readonly T[] | undefined) => (a ?? []).every((x) => (b ?? []).includes(x));
  // Nothing new to check (no new flag or Check this signal): holds come and go with the wording.
  if (sameSubstance(before, now) && within(flags, before.flags) && within(now.checks, before.checks)) return true;
  // A held answer that says something else is a new answer to judge.
  if (now.holds?.length) return false;
  if (!within(flags, before.flags) || !within(now.checks, before.checks)) return false;
  if (now.languageCheck && now.languageCheck !== before.languageCheck) return false;
  if (before.answer === now.answer) return true;
  // A Check this alone, reworded: the same pages under it.
  if (!flags.length && !now.languageCheck && now.checks?.length) {
    const urls = (q: RunQuestion) => JSON.stringify(q.sources.map((x) => x.url).sort());
    return now.sources.length > 0 && urls(before) === urls(now);
  }
  if (!flags.some((f) => f === "price" || f === "date")) return false;
  const figures = now.figures ?? [];
  if (!figures.length) {
    const keys = (q: RunQuestion) => new Set(figureKeys(q.answer, q.flags ?? []));
    const had = keys(before);
    const has = [...keys(now)];
    return has.length > 0 && has.every((k) => had.has(k));
  }
  const prior = new Map((before.figures ?? []).map((f) => [figureId(f), f]));
  return figures.every((f) => {
    const p = prior.get(figureId(f));
    // A price of nothing ("Free: $0") one wording adds and another leaves out isn't new to check.
    if (!p) return f.kind === "price" && amount(f.figure) === "0";
    // A figure no synced page states was found where the person said.
    if (!f.page) return !p.page && Boolean(before.acknowledged?.foundAt);
    // The same amount (by figureValue: "37,50 €" is "37,5 €", round 6) on the same line of the same
    // page. Another line can be another product ("Renewal $1,299").
    return sameUrl(p.page?.url ?? "") === sameUrl(f.page.url) && p.excerpt === f.excerpt;
  });
}

// What a person decided about the same question in the run before, kept while it still applies:
// "The site doesn't cover this" while it still gets no answer, "I checked it" while checkCarries,
// and pages still to be answered from.
export function carriedOver(before: RunQuestion | undefined, now: RunQuestion): RunQuestion {
  if (!before) return now;
  return {
    ...now,
    ...(before.notCovered &&
      (!now.answered || (now.checks?.length && !now.flags?.length) || now.holds?.length) && { notCovered: before.notCovered }),
    ...(before.acknowledged && checkCarries(before, now) && { acknowledged: before.acknowledged }),
    ...(before.added && { added: before.added }),
  };
}

// The same, across a run: a question's own decision, else one a person made on another wording of
// the same intent in the same language, while the answer is the same in substance (round 7: each
// re-run's new wordings were decided again, on the same pages and figures). A decision on a price
// contradiction carries only as checkCarries allows. Pure.
export function carriedFromRun(prior: readonly RunQuestion[], now: RunQuestion): RunQuestion {
  const same = prior.find((q) => questionKey(q.question) === questionKey(now.question));
  const kept = carriedOver(same, now);
  if (kept.acknowledged || kept.notCovered || !now.intent) return kept;
  const lang = detectLanguage(now.question);
  const others = prior.filter((q) => q !== same && q.intent === now.intent && detectLanguage(q.question) === lang && sameSubstance(q, now));
  const covered = !now.answered ? others.find((q) => q.notCovered && !q.answered) : undefined;
  if (covered?.notCovered) return { ...kept, notCovered: covered.notCovered };
  const decided = now.sources.length ? others.find((q) => q.acknowledged && q.sources.length && checkCarries(q, now)) : undefined;
  return decided?.acknowledged ? { ...kept, acknowledged: decided.acknowledged } : kept;
}

// What a run opened that the run before didn't have open, for the audit entry an automatic run
// writes (track C's alerts post one per automatic run that opens something on a signed-off
// deployment): each question with what it now owes, and checks that were done and reopened.
export function openedSince(
  before: ValidationResult | null | undefined,
  now: readonly RunQuestion[],
): { question: string; was: string; reopened?: true }[] {
  const prior = new Map((asRun(before)?.questions ?? []).map((q) => [questionKey(q.question), q]));
  return now.flatMap((q) => {
    const owes = q.failure ? `Failed: ${q.failure}` : needsDecision(q) ? "No answer" : needsCheck(q) ? "A check" : undefined;
    if (!owes) return [];
    const p = prior.get(questionKey(q.question));
    const pOwes = p && (p.failure ? `Failed: ${p.failure}` : needsDecision(p) ? "No answer" : needsCheck(p) ? "A check" : undefined);
    if (p && pOwes === owes) return [];
    return [{ question: q.question, was: owes, ...(p?.acknowledged && needsCheck(q) && { reopened: true as const }) }];
  });
}

// Nothing open: the sign-off holds (SignOff.heldAt) once a run after the first sync passes with
// nothing to check, fail or decide.
export function nothingOpen(validation: ValidationResult | null | undefined): boolean {
  const run = asRun(validation);
  if (!run || run.content?.partial) return false;
  const c = runCounts(run.questions);
  return validationPassed(run.questions) && !c.failed.length && !c.unchecked && !c.undecided.length;
}

// ---- a starter that stopped answering ----

// The widget's settings without a starter, in every language it's in.
export function withoutStarter<S extends Pick<WidgetSettings, "starters" | "translations">>(settings: S, question: string): S {
  const key = questionKey(question);
  const keep = (list: string[] | undefined) => list?.filter((q) => questionKey(q) !== key);
  const translations = settings.translations
    ? Object.fromEntries(
        Object.entries(settings.translations).map(([lang, t]) => [lang, t?.starters ? { ...t, starters: keep(t.starters) } : t]),
      )
    : undefined;
  return { ...settings, ...(settings.starters && { starters: keep(settings.starters) }), ...(translations && { translations }) };
}

// The starters an automatic run found with no answer: the worker asks each once more, and takes
// it off the live chat if it fails again.
export const failingStarters = (questions: readonly RunQuestion[]): RunQuestion[] =>
  questions.filter((q) => q.starter && !answeredOrKept(q) && !q.notCovered);

// What the answer to a starter asked once more does to it. "remove" needs a reply from Agentic RAG
// that says it has no answer (its no-context status or sentence, or a reply so far from the question
// that visitors get the no-answer sentence): never an empty or failed reply, or the absence of one (a
// refused ask never gets here: lib/ask-refusal.ts), and not a reply that's only held, which stays open
// for a person, or one that answers and failed on something else. Pure.
export function starterRemoval(judged: RunQuestion, result: { answer?: string | null; status?: unknown }): "answered" | "remove" | "keep" {
  if (judged.answered && !judged.failure) return "answered";
  if (judged.answered || result.status === "error") return "keep";
  const says = result.status === "no_context" || result.status === "no_retrieval_data" || Boolean((result.answer ?? "").trim());
  return says && (judged.verdict === "no-context" || judged.verdict === "low-relevance") ? "remove" : "keep";
}

// Questions waiting on pages added by hand ("Add these pages"), with the pages.
export function waitingOnPages(
  validation: ValidationResult | null | undefined,
): { index: number; question: string; urls: string[]; at: string }[] {
  return (asRun(validation)?.questions ?? []).flatMap((q, index) =>
    q.added && !q.added.askedAgain ? [{ index, question: q.question, urls: q.added.urls, at: q.added.at }] : [],
  );
}

// A waiting question is asked again once each of its pages is answerable, left out or failed,
// or after this long whatever their state.
export const ADDED_WAIT_MS = 15 * 60_000;
export const pageSettled = (status: string | undefined): boolean => status === "indexed" || status === "skipped" || status === "failed";

// Why the list can't run yet, in the words of the Run button, or undefined when it can.
export function draftProblem(questions: readonly DraftQuestion[]): string | undefined {
  const filled = questions.filter((q) => q.question.trim());
  if (!filled.length) return "Generate questions first";
  const counted = filled.filter((q) => !isFallbackQuestion(q.question));
  const own = counted.filter((q) => q.own).length;
  const missing = Math.max(OWN_QUESTIONS - own, MIN_QUESTIONS - counted.length);
  if (missing > 0) {
    const n = filled.length - counted.length;
    return n
      ? `Rewrite the ${n} “tell me about” question${n === 1 ? "" : "s"}, or add ${missing} more`
      : `Add ${missing} of your own question${missing === 1 ? "" : "s"}`;
  }
  if (filled.some((q) => isUnfinishedStub(q.question))) return "Finish the questions marked …";
  // The cap is on the generated questions and the partner's own: the intent questions every site
  // gets never crowd them out (round 6: teamleader.eu's list was full before the partner added any).
  const besides = filled.filter((q) => !q.intent).length;
  if (besides > MAX_OWN_AND_GENERATED) return `Ask at most ${MAX_OWN_AND_GENERATED} questions besides the ones every site gets`;
  return undefined;
}

// ---- how long a run takes ----

// Questions asked at once. Single answers took 1.6–3.7 s on 2026-10-30, five at once 2.4–4.5 s
// in all; but a 7-question run on the demo took 245 s with all seven at once, while three first
// syncs were loading, so a run asks a few at a time and each ask stops after a minute. Four since
// round 6: 20-question runs with the judge reached 29–32 s at three.
export const ASK_CONCURRENCY = 4;
// Seconds per round of asks before any run was measured.
const ROUND_SECONDS = 8;

// The run's length, from the last run's own pace when there is one: a round per three
// questions, plus the domain-lock check.
export function estimateSeconds(questions: number, last?: Pick<ValidationRun, "seconds" | "questions"> | null): number {
  const rounds = (n: number) => Math.max(1, Math.ceil(n / ASK_CONCURRENCY));
  const perRound =
    last?.seconds && last.questions.length ? Math.min(60, Math.max(3, last.seconds / rounds(last.questions.length))) : ROUND_SECONDS;
  return Math.round(rounds(questions) * perRound + 2);
}

export const aboutSeconds = (s: number): string =>
  s < 90 ? `about ${Math.max(5, Math.round(s / 5) * 5)} s` : `about ${Math.round(s / 60)} min`;

// ---- starter questions ----

// Whether a question may be offered or saved as a starter: never a fallback question, whatever
// it came from (the widget's current starters, suggestions or validation).
export const starterProblem = (q: string): string | undefined =>
  isFallbackQuestion(q) ? "Visitors don't ask “What can you tell me about …”: reword it as a question they'd ask." : undefined;

// A person's confirmation: the signed-in person, or in setup mode a name they type.
export function confirmationBy(
  user: { id: string | null; name: string; setupMode: boolean },
  typedName?: string,
): Confirmation | { error: string } {
  const at = new Date().toISOString();
  if (!user.setupMode) return { by: user.id, name: user.name, at, verified: true };
  const name = typedName?.trim().slice(0, 80);
  if (!name) return { error: "Type your name: in setup mode the console doesn't know who you are." };
  return { by: null, name, at, verified: false };
}

// Starters saved before the picker existed ("Use the answered ones as starter questions") were
// never chosen by a person: the review shows them as "Check this".
export function starterStatus(d: {
  widgetSettings: { starters?: string[] };
  confirmations: { starters?: Confirmation };
}): "confirmed" | "check" | "none" {
  if (d.confirmations.starters) return "confirmed";
  return d.widgetSettings.starters?.length ? "check" : "none";
}

// ---- the picker's decisions (round 6, item 4) ----
//
// The picker and "Use these" judge a starter by validation's own rules, never a copy: what a row
// still needs before it can be a starter, and the person's decision applied as validation records
// it, so it carries into the run.

// A person's decision on one row in the picker: I checked it (with where a figure no synced page
// states was found), or a held answer kept with a reason.
export interface StarterPick {
  checked?: boolean;
  reason?: string;
  foundAt?: string;
}
export type StarterNeed = "ok" | "failure" | "no-answer" | "reason" | "check" | "address";

// What visitors would read is a held reply (may not answer, a deflection, a substitution): a named
// person can keep it. A reply visitors never see (the no-answer reply) can't be a starter.
const keepable = (q: RunQuestion) => q.answered || Boolean(q.declined && q.holds?.length);
const kept = (q: RunQuestion, pick: StarterPick) => Boolean(q.holds?.length && (pick.reason?.trim().length ?? 0) >= 3);

// What a row still needs before it can be a starter, in the screen's words.
export function starterNeed(q: RunQuestion, pick: StarterPick = {}): { need: StarterNeed; why: string } {
  if (!keepable(q)) return { need: "no-answer", why: "visitors who click it would get the no-answer reply" };
  if (q.failure) return { need: "failure", why: q.failure };
  if (openHold(q) && !kept(q, pick))
    return {
      need: "reason",
      why: `it's held (${q.holds?.map((h) => h.text.replace(/\.$/, "")).join("; ")}): keep it with a reason, or untick it`,
    };
  if (needsCheck(q) && !kept(q, pick) && !pick.checked) {
    const what = [
      ...(q.flags ?? []).map((f) =>
        f === "price"
          ? "a price to check against the site"
          : f === "date"
            ? "a date"
            : f === "overview-sources"
              ? "only overview pages as sources"
              : "an out-of-date source",
      ),
      ...(q.languageCheck ? ["its language"] : []),
      ...(q.checks ?? []).map((c) => CHECK_TEXT[c]),
    ];
    return { need: "check", why: `it needs I checked it (${what.join(", and ")})` };
  }
  const unstated = (q.figures ?? []).filter((f) => !f.page);
  if (unstated.length && !kept(q, pick) && !/^https?:\/\/\S+\.\S+/.test(pick.foundAt?.trim() ?? ""))
    return { need: "address", why: `paste the address of the page where you found ${unstated.map((f) => f.figure).join(" and ")}` };
  return { need: "ok", why: "" };
}

// The person's decision recorded on the answer as validation records it (acknowledgeFlag): a
// reason on a held answer, I checked it on anything to check. Nothing when it isn't needed.
export function applyStarterPick(q: RunQuestion, pick: StarterPick, who: Confirmation | undefined): RunQuestion {
  if (!who || starterNeed(q, pick).need !== "ok") return q;
  const foundAt = pick.foundAt?.trim();
  const at = (q.figures ?? []).some((f) => !f.page) && foundAt ? { foundAt } : {};
  if (kept(q, pick)) return { ...q, acknowledged: { ...who, ...at, reason: pick.reason?.trim().slice(0, 300) } };
  if (needsCheck({ ...q, acknowledged: undefined }) && pick.checked) return { ...q, acknowledged: { ...who, ...at } };
  return q;
}

// ---- the answering rules re-check (round 6) ----

// What a rules re-check found: each question asked now under the current rules and under the
// latest, compared like with like, the person's decisions on the last run carried over to both.
// Worse means answered (or decided) under the current rules and not under the latest, or a new
// failure. A new check or hold is information, never worse. Pure.
export function recheckDiff(
  decided: readonly RunQuestion[],
  current: readonly RunQuestion[],
  latest: readonly RunQuestion[],
): { total: number; unchanged: number; better: number; worse: { question: string; before: string; after: string; was: string }[] } {
  const before = new Map(decided.map((q) => [questionKey(q.question), q]));
  const now = new Map(current.map((q) => [questionKey(q.question), q]));
  let unchanged = 0;
  let better = 0;
  const worse: { question: string; before: string; after: string; was: string }[] = [];
  // The judge's hold counts as the rules' do (round 7, 7c): what a text rule can't tell, like an answer
  // about a neighbouring thing, is worse too when the current rules' answer had no such hold.
  const answers = (q: RunQuestion) =>
    (q.answered && !q.holds?.some((h) => h.by === "judge" && h.clear === "decide")) ||
    Boolean(q.notCovered) ||
    Boolean(q.acknowledged?.reason);
  for (const judged of latest) {
    // A price table contradiction nobody decided is worse, whatever the current rules give (round 6:
    // the overnight re-run passed a mislabel the judge had held): it never counts as unchanged.
    const d0 = before.get(questionKey(judged.question));
    const latestKept = d0 ? carriedOver(d0, judged) : judged;
    if (openContradiction(latestKept)) {
      worse.push({
        question: judged.question,
        before: now.get(questionKey(judged.question))?.answer ?? "",
        after: judged.answer,
        was: `Contradicts the price table: ${latestKept.holds?.find((h) => h.by === "price")?.text ?? ""}`.trim(),
      });
      continue;
    }
    const key = questionKey(judged.question);
    const old = now.get(key);
    if (!old) continue;
    const d = before.get(key);
    const a = d ? carriedOver(d, old) : old;
    const b = d ? carriedOver(d, judged) : judged;
    if ((answers(a) && !answers(b)) || (b.failure && !a.failure)) {
      worse.push({ question: judged.question, before: a.answer, after: b.answer, was: b.failure ? "Failed: " + b.failure : "No answer" });
    } else if ((!answers(a) && answers(b)) || (a.failure && !b.failure)) better++;
    else unchanged++;
  }
  return { total: latest.length, unchanged, better, worse };
}

// The questions a first comparison called worse, to ask once more under the latest rules before
// believing it (round 6: whatsupgold.com was held on one empty answer under v3 that came back
// fine 3 of 3 when asked again). Pure.
export const worseToAskAgain = (diff: { worse: readonly { question: string }[] }): Set<string> =>
  new Set(diff.worse.map((w) => questionKey(w.question)));

// The latest rules' answers with each question asked again in place of its first answer: an
// answer is worse only when the second ask is worse too. Then compared as recheckDiff compares.
// Pure.
export function recheckDiffAfterSecondAsk(
  decided: readonly RunQuestion[],
  current: readonly RunQuestion[],
  latest: readonly RunQuestion[],
  again: readonly RunQuestion[],
): ReturnType<typeof recheckDiff> {
  const second = new Map(again.map((q) => [questionKey(q.question), q]));
  return recheckDiff(
    decided,
    current,
    latest.map((q) => second.get(questionKey(q.question)) ?? q),
  );
}

// ---- dates told in the wrong tense (round 7) ----
//
// Sealed-S2: "took place on 2–4 December 2026" a month ahead, "has now taken place" for the next
// day's event, "We will be at … on October 27, 2026" a week after it. A sentence with a full date
// (with the year) told in the other tense than the date gives is a hold naming both. Pure.
const TENSE_MONTHS: Record<string, number> = Object.fromEntries(
  [
    ["january", "jan", "januar", "jänner"],
    ["february", "feb", "februar"],
    ["march", "mar", "märz", "maerz"],
    ["april", "apr"],
    ["may", "mai"],
    ["june", "jun", "juni"],
    ["july", "jul", "juli"],
    ["august", "aug"],
    ["september", "sep", "sept"],
    ["october", "oct", "oktober"],
    ["november", "nov"],
    ["december", "dec", "dezember"],
  ].flatMap((names, i) => names.map((n) => [n, i + 1])),
);
const MONTH_RE = Object.keys(TENSE_MONTHS)
  .sort((a, b) => b.length - a.length)
  .join("|");
// "2–4 December 2026", "3. November 2026", "October 27, 2026", "September 29–30, 2026".
const FULL_DATE = new RegExp(
  String.raw`(?<![\p{L}\p{N}])(?:(\d{1,2})\.?(?:\s*(?:-|–|—|to|bis)\s*(\d{1,2})\.?)?\s+(${MONTH_RE})\.?,?\s+(\d{4})|(${MONTH_RE})\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:\s*(?:-|–|—|to)\s*(\d{1,2})(?:st|nd|rd|th)?)?,?\s+(\d{4}))(?![\p{N}])`,
  "giu",
);
const TOLD_PAST =
  /(?<![\p{L}])(?:took place|was held|were held|has (?:now |already )?taken place|have (?:now |already )?taken place|happened|already (?:passed|ended|over)|has (?:now )?passed|is (?:now )?over|was over|stattgefunden|fand\s+[^.]{0,40}statt|liegt (?:bereits )?in der vergangenheit|ist (?:bereits )?vorbei)(?![\p{L}])/iu;
const TOLD_COMING =
  /(?<![\p{L}])(?:will be|we'll be|will take place|will hold|is coming up|upcoming|coming|next|join us|see you|wird\s+[^.]{0,40}stattfinden|findet\s+[^.]{0,40}statt|werden\s+[^.]{0,40}sein|kommende[nrs]?|nächste[nrs]?|anstehende[nrs]?)(?![\p{L}])/iu;

// "October 24 and 25, 2026" as the range it is, for FULL_DATE.
const bothDays = (text: string) => text.replace(/(\d{1,2}) (?:and|&|und|y|et|en|e) (\d{1,2})(?=,? \d{4})/g, "$1–$2");

export function dateTenseHold(answer: string, today: Date): Hold | undefined {
  if (!answer) return undefined;
  const day = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const wrong: string[] = [];
  // A lead-in tells the list under it as coming ("Upcoming events include:"), so the same answer gets
  // the same treatment however its lines are worded (round 7: run 1 got a check on "AIA Austin Homes
  // Tour — October 24–25, 2026" under that lead-in, and run 2 a hold, its line saying "Join us").
  let ledComing = false;
  for (const sentence of answer.split(/\n+|(?<=[!?]|(?<!\d)\.)\s+(?=\p{Lu})/u)) {
    if (/:\s*$/.test(sentence)) {
      ledComing = TOLD_COMING.test(sentence) && !TOLD_PAST.test(sentence);
      continue;
    }
    if (!sentence.trim()) continue;
    const dates = [...bothDays(sentence).matchAll(FULL_DATE)].map((m) => {
      const month = TENSE_MONTHS[(m[3] ?? m[5] ?? "").toLowerCase()] ?? 0;
      const year = Number(m[4] ?? m[8]);
      const first = Number(m[1] ?? m[6]);
      const last = Number(m[2] ?? m[7] ?? first);
      return { text: m[0].trim(), start: Date.UTC(year, month - 1, first), end: Date.UTC(year, month - 1, last) };
    });
    if (dates.length !== 1) continue;
    const d = dates[0] as { text: string; start: number; end: number };
    const past = TOLD_PAST.test(sentence);
    const coming = TOLD_COMING.test(sentence) || ledComing;
    if (past && !coming && d.start > day) wrong.push(`${d.text} is still to come, but this answer says it took place`);
    else if (coming && !past && d.end < day) wrong.push(`${d.text} is past, but this answer tells it as upcoming`);
  }
  if (!wrong.length) return undefined;
  const on = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(today);
  return { by: "evidence", clear: "decide", text: `Today is ${on}: ${wrong.join("; ")}.` };
}
