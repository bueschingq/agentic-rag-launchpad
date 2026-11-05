// One definition of "answered", shared by the widget (what the visitor saw, and what GA gets),
// validation and the worker's question-log roll-up. A reply is no answer when Agentic RAG
// reports no_context or no_retrieval_data, or when its best reranked paragraph scores under 0.02
// and nothing concrete it says is on the pages it cites. A reply that claims something is missing
// or over ("Our website does not list prices", "The webinar has passed") is judged by that claim
// (round 5): with content of the kind asked for, found on the pages it cites, it partly answers
// (Answered); without, it may not answer: shown as written with the handoff, a content gap in the
// report, Check this in validation and the picker.
// Validation and the picker add the Check this signals (answerChecks: very short, or sources
// that don't match the question), and the widget whether a reply sends the visitor to the team
// (tellsToContact). Also the language a question or answer is written in, which validation
// judges answers by and the widget can ask in (see the end of this file).
// Browser-safe and dependency-free: the widget bundles it.

import { type Language, languageOf } from "./i18n.ts";
import { INTENT_WORDS, matchWords, questionIntents, relatedWords, sameWord } from "./relevance.ts";

// Reranker scores (0–1) measured on a real KB on 2026-10-30: questions it could answer had a
// best paragraph at 0.13–0.49; off-topic ones at 0.000–0.004, including one the model
// answered anyway from an unrelated page. Other score types (BM25, vector, fused) aren't on
// a comparable scale, so they're not judged.
//
// Round 5: a threshold set on one KB hid correct, cited answers. Kemp's "What are your prices?"
// scored 0.0112 with every tier's price on the cited /pricing paragraph; chef.io's answers routed
// to its pricing pages scored 0.005–0.05. So the score only decides a reply whose concrete
// content (a figure, a date, a contact, steps) isn't on the pages it cites (grounded, below):
// that still keeps off-topic replies out.
//
// Citations are no substitute: on the same day Agentic RAG returned none for two of three
// well-answered questions (answers that list or sum up many pages). So an uncited reply only
// counts as no answer when there's no reranker score to go by.
export const MIN_RERANKER_SCORE = 0.02;

// Agentic RAG's own sentence when the model finds nothing in the context. It comes with the
// no_context status, which is what the verdict goes by; the widget only uses the sentence to
// hold it back while streaming.
export const NO_CONTEXT_ANSWER = "Not enough data to answer this.";

// The same sentence as models write it when told to answer in the visitor's language: a reply that
// says only this is no answer, whatever status came with it (it arrives as success).
const NO_CONTEXT_SAID = [
  /^not enough (data|information) to answer( this| that| the question)?\.?$/i,
  /^nicht (genügend|genug) (daten|informationen),? um (das|dies|diese frage) zu beantworten\.?$/i,
  /^no hay (suficientes datos|suficiente información|datos suficientes) para responder( a)?( esto| eso| esta pregunta)?\.?$/i,
  /^pas assez (de données|d'informations|d’informations) pour répondre( à cela| à cette question)?\.?$/i,
  /^non ci sono (abbastanza dati|dati sufficienti|informazioni sufficienti) per rispondere( a questo| a questa domanda)?\.?$/i,
  /^niet genoeg (gegevens|informatie) om (dit|dat|deze vraag) te beantwoorden\.?$/i,
  /^(não há|sem) (dados|informações) suficientes para responder( a isso| a esta pergunta)?\.?$/i,
];
// Reworded, in any language: one short sentence, nothing concrete, about too little information to
// answer (recheck-R3: the fixed sentence in Spanish passed as an answer when worded another way).
const ENOUGH_TO_ANSWER = /(?:answer|respond|antwort|beantwort|r[eé]pond|rispond|antwoord|respost)/iu;
const TOO_LITTLE =
  /(?:\bdata\b|\binformation\b|\binfo\b|daten|informationen|angaben|datos|informaci[oó]n|donn[eé]es|informations?|gegevens|informatie|dados|informa[cç][õo]es|informazioni)/iu;
export const saysNoContext = (answer: string): boolean => {
  const text = answer.trim();
  if (NO_CONTEXT_SAID.some((re) => re.test(text))) return true;
  return (
    text.length < 110 &&
    !/[.!?]\s+\S/.test(text) &&
    ENOUGH_TO_ANSWER.test(text) &&
    TOO_LITTLE.test(text) &&
    /(?<![\p{L}])(?:not|no|nicht|kein\p{L}*|pas|non|niet|geen|não|sem|insufficient|sorry)(?![\p{L}])|n't/iu.test(text) &&
    !/\p{N}/u.test(text)
  );
};

export type Verdict =
  // Answered from the content, with sources.
  | "answered"
  // Says something the question asks about is missing or over, and gives content of the kind
  // asked for, found on the pages it cites ("We don't list a price for 300 devices; plans start at
  // $1,229…"). Answered: visitors see it as an answer, and validation checks the claim.
  | "partly"
  // Says something the question asks about is missing or over ("The information we have does not
  // provide cleaning steps", "No future webinar date is listed", "Our website does not list
  // prices"), with no content of the kind asked for. Shown as written, with the handoff; a content
  // gap in the report; Check this in validation and the picker, until a person decides.
  | "may-not-answer"
  // Nothing retrieved, or the model said the context doesn't cover it.
  | "no-context"
  // No answer text, or the question failed.
  | "empty"
  // The best match was too weak to trust whatever the model wrote, and nothing concrete it says
  // is on the pages it cites.
  | "low-relevance"
  // Citations were asked for, the model cited nothing, and there's no relevance score to go by.
  | "uncited"
  // Round 6: the reply's only content is a pointer ("Please contact us through the Contact page",
  // "Visit our Partners page"), with nothing from the site about what was asked. Shown as written,
  // with the handoff card; a gap in the report; held in validation and the picker.
  | "deflection"
  // Round 6: the reply gives a step for another thing than the one asked (a demo, asked for a
  // trial) and none for the thing asked. Shown as written, with the handoff card; held.
  | "substituted";

// Every outcome by name, and those the widget shows the handoff card under (track C).
export const VERDICTS = [
  "answered",
  "partly",
  "may-not-answer",
  "deflection",
  "substituted",
  "no-context",
  "empty",
  "low-relevance",
  "uncited",
] as const satisfies readonly Verdict[];
export const HANDOFF_VERDICTS = ["may-not-answer", "deflection", "substituted"] as const satisfies readonly Verdict[];

export interface ReplyFacts {
  answer: string;
  // The stream's status: success, no_context, no_retrieval_data or error.
  status?: string;
  best?: { score: number; type: string };
  // undefined when no citations item arrived at all (citations turned off, or the question log).
  citations?: Record<string, unknown>;
  // What Agentic RAG retrieved (the stream's retrieval item, or retrieval_results.resources): the
  // paragraphs the reply cites are what its concrete content is checked against (grounded).
  resources?: Record<string, unknown>;
  // The paragraphs Agentic RAG added around the retrieved ones (the synchronous answer's
  // augmented_context), when the caller has them: the model cites those too.
  augmented?: unknown;
  // Or the cited passages themselves, when the caller has them. Neither: nothing is grounded, and
  // a negative claim is judged by the reply's own content.
  passages?: readonly string[];
  // The visitor's question: what kind of content answers it (a figure for a price, a date for
  // "when", steps for "how do I", a contact or link for contact), and whether a negative claim is
  // about it. Without it, any concrete content counts.
  question?: string;
  // The language the reply should be in, when known: its negative-claim wordings come first.
  language?: string;
}

// What the verdict read in a reply, for the line validation shows: the claim that something is
// missing, the pointer a deflection is made of, or what a substitution offers instead.
export interface ReplyReading {
  verdict: Verdict;
  claim?: NegativeClaim;
  // A deflection's pointer sentence.
  pointer?: string;
  // A substitution: the thing asked, and the thing the reply gives a step for instead.
  substitute?: { asked: string; offered: string };
}

export const verdict = (facts: ReplyFacts): Verdict => readReply(facts).verdict;

export function readReply(facts: ReplyFacts): ReplyReading {
  const { answer, status, best, citations } = facts;
  if (status === "no_retrieval_data" || status === "no_context") return { verdict: "no-context" };
  // Without a status (an older stream, or one cut short), Agentic RAG's own sentence still says it.
  if (status === undefined && answer.trim() === NO_CONTEXT_ANSWER) return { verdict: "no-context" };
  // The sentence in another language, or reworded: no answer, even with a success status.
  if (saysNoContext(answer)) return { verdict: "no-context" };
  if (status === "error" || !answer.trim()) return { verdict: "empty" };
  const evidence =
    facts.passages ?? (facts.resources && citations ? citedPassages(facts.resources, citations, facts.augmented) : undefined);
  const urls = facts.resources && citations ? citedUrls(facts.resources, citations) : [];
  const retrieved = facts.resources ? retrievedPassages(facts.resources, facts.augmented) : undefined;
  const content = groundedContent(answer, evidence, { question: facts.question, urls, ...(retrieved && { retrieved }) });
  // The score decides only a reply whose concrete content isn't on the pages it cites.
  if (best?.type === "RERANKER" && best.score < MIN_RERANKER_SCORE && !(evidence && content.grounded)) return { verdict: "low-relevance" };
  const { question } = facts;
  // A plain yes or no, with content found on the pages it cites, at least partly answers.
  const yesNo = LEAD_YES_NO.test(plain(answer)) && content.grounded;
  const claim = negativeClaim(answer, facts.language, question);
  if (claim && claimAboutQuestion(claim, answer, question)) {
    const substitute = substitutes(answer, question, claim);
    if (substitute && !yesNo) return { verdict: "substituted", claim, substitute };
    // The claim denies what was asked, and the rest is about something beside it (recheck-R3: a
    // neighbouring feature, plus "the page doesn't state" the one asked).
    if (
      !yesNo &&
      !askedKind(question) &&
      !KIND_WORDS.price.test(claim.sentence) &&
      !answersOther(claim, answer, question) &&
      besideTheDenied(claim, answer, question)
    )
      return { verdict: "may-not-answer", claim };
    // To a question that asks no particular kind of content ("Can I try it for free?"), a reply that
    // says "Yes" and then that the site doesn't state the thing asked rests on its claim, unless what it
    // says is on the pages it cites.
    const unbacked = !askedKind(question) && LEAD_YES_NO.test(plain(answer)) && !content.grounded;
    return {
      verdict:
        yesNo || (!unbacked && answersKind(content, question, claim, answer)) || answersOther(claim, answer, question)
          ? "partly"
          : "may-not-answer",
      claim,
    };
  }
  if (!yesNo) {
    const substitute = substitutes(answer, question) ?? otherSubject(answer, content, question);
    if (substitute) return { verdict: "substituted", substitute };
    const pointer = deflects(answer, question, evidence);
    if (pointer) return { verdict: "deflection", pointer };
    const unstated = pricesUnstated(answer, content, question);
    if (unstated) return { verdict: "may-not-answer", claim: { sentence: unstated, expiry: false } };
  }
  if (best?.type === "RERANKER") return { verdict: "answered" };
  if (citations && Object.keys(citations).length === 0) return { verdict: "uncited" };
  return { verdict: "answered" };
}

export const isAnswered = (v: Verdict): boolean => v === "answered" || v === "partly";

// Whether the model's own words are worth showing: an uncited reply is usually "I don't know,
// contact us", which reads fine, and so does one that may not answer; the others get the widget's
// no-answer text instead.
export const showsModelText = (v: Verdict): boolean =>
  v === "answered" || v === "partly" || v === "uncited" || v === "may-not-answer" || v === "deflection" || v === "substituted";

// ---- soft no-answers, thin answers and sources that don't fit (round 4) ----
//
// Measured on the reviewers' round-4 answers (packages/theme/test/verdict-regression.test.ts):
// the default template told the model to say it doesn't know "in its own words", and those
// words passed as answers: "We don't have specific stain-removal steps for crayon on painted
// walls… please contact us" (crayola.com), "Contact Support." to "How do I contact support?"
// (telerik.com). Correct short answers state a figure, a day or a zero price ("Teeth whitening
// costs $350 per session.", "Closed on Sundays and public holidays.", "No. There is no setup
// fee."), and quote answers say how to get a price ("nennen wir keinen konkreten Preis… ab
// 1.229 $… fordern Sie ein Angebot an").

// Apostrophes as typed, so one pattern reads "don't" and "don’t".
const plain = (text: string) => text.normalize("NFC").replace(/[’‘`´]/g, "'");

// Whole words in any script: \b only knows ASCII, and "lunedì" or "sábado" end in a letter it doesn't.
const anyWord = (words: string) => new RegExp(`(?<![\\p{L}\\p{N}])(?:${words})(?![\\p{L}\\p{N}])`, "iu");

// Days of the week and months (never "may", "mar" or "jan": "you may contact us"), and the
// words for weekdays and weekends.
const DAYS = anyWord(
  [
    "mondays?|tuesdays?|wednesdays?|thursdays?|fridays?|saturdays?|sundays?|weekdays?|weekends?",
    "january|february|march|april|june|july|august|september|october|november|december",
    "montags?|dienstags?|mittwochs?|donnerstags?|freitags?|samstags?|sonntags?|werktags?|wochenende[n]?|feiertags?",
    "januar|februar|märz|juni|juli|oktober|dezember",
    "lunes|martes|miércoles|jueves|viernes|sábados?|domingos?|festivos?",
    "enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre",
    "lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche|janvier|février|avril|juin|juillet|août|septembre|octobre|novembre|décembre",
    "maandag|dinsdag|woensdag|donderdag|vrijdag|zaterdag|zondag|januari|februari|maart|augustus",
    "segunda-feira|terça-feira|quarta-feira|quinta-feira|sexta-feira|janeiro|fevereiro|março|maio|junho|julho|setembro|outubro|dezembro",
    "lunedì|martedì|mercoledì|giovedì|venerdì|sabato|domenica|gennaio|febbraio|aprile|maggio|giugno|luglio|settembre|ottobre|dicembre",
  ].join("|"),
);

// A price of nothing is a price: "There is no setup fee.", "The trial is free.", "kostenlos".
const ZERO_PRICE = anyWord(
  [
    "(?:is|are|it's|always|completely|entirely) free|for free|free of charge|at no (?:extra |additional )?(?:cost|charge)",
    "no (?:\\p{L}+ )?(?:fees?|charges?)(?! (?:information|details|listed|published|stated))",
    "kostenlos|kostenfrei|gebührenfrei|keine (?:\\p{L}+ )?gebühren?",
    "gratis|gratuit[oa]s?|sin (?:coste|costo|cargo)s?(?: adicional(?:es)?)?",
    "gratuite?s?|sans frais",
    "kosteloos|geen (?:\\p{L}+ )?kosten",
    "grátis|sem (?:custo|custos|taxas?)",
    "gratuit[ie]|senza (?:costi|costo|spese)",
  ].join("|"),
);

// How to get a price that isn't published: a quote, or a price on request.
const BY_QUOTE = anyWord(
  [
    "quotes?|quotation|on request|prices? vary|pricing varies|upon request|(?:custom|tailored|personali[sz]ed|bespoke|customi[sz]ed) (?:pricing(?: review)?|prices?|estimates?|proposals?)|pricing review|pricing is tailored",
    "angebot|preisanfrage|auf anfrage",
    "presupuesto|cotización|cotizacion|bajo (?:petición|solicitud|demanda)",
    "devis|sur demande",
    "offerte|op aanvraag",
    "orçamento|cotação|sob consulta|mediante solicitação",
    "preventivo|su richiesta",
  ].join("|"),
);

// A site's own address ("at Crayola.com"), a link, or an email address.
const LINK =
  /https?:\/\/|\bwww\.|\]\(|[\w.+-]+@[\w-]+\.[a-z]{2,}|\b[\w-]+\.(?:com|org|net|io|co|edu|gov|de|es|fr|nl|it|pt|be|ch|at|uk|eu|us|ca|au|mx|br)\b/i;

// Steps or a list: two lines or more that start like list items, or one sentence naming three
// things or more ("application, device, server, cloud, and on-premises monitoring").
function listsThings(text: string): boolean {
  const items = text.match(/(?:^|\n|\s)(?:[-*•]|\d+[.)])\s+\S/g) ?? [];
  if (items.length >= 2) return true;
  return text.split(/[.!?;:\n]+/).some((sentence) => (sentence.match(/,/g) ?? []).length >= 3);
}

// Something a visitor can act on: a figure (a price, a date, hours, a phone number, a version),
// a day or month, a price of nothing, a quote to ask for, a link, a site address or an email,
// or steps. Street addresses carry a number.
export function hasConcreteDetail(answer: string): boolean {
  const text = plain(answer);
  return /\p{N}/u.test(text) || DAYS.test(text) || ZERO_PRICE.test(text) || BY_QUOTE.test(text) || LINK.test(text) || listsThings(text);
}

// The model saying the site lacks it, in the widget's seven languages: about information,
// steps or prices ("we don't have specific steps", "isn't listed", "couldn't find"). Not a plain
// no ("We don't sell bicycles.", "There is no setup fee.", "Taxes are not included."), which is an answer.
const phrase = (source: string) => new RegExp(`(?<![\\p{L}\\p{N}])${source}(?![\\p{L}\\p{N}])`, "iu");
// Up to four words between ("specific stain-removal steps", "a carpet-specific removal method").
const BETWEEN = "(?:\\p{L}+[ -]){0,4}?";
const LACKS: RegExp[] = [
  // en
  phrase(
    `(?:we|i) (?:do not|don't|dont) have (?:any )?${BETWEEN}(?:information|info|details?|specifics|steps|instructions|guidance|guides?|methods?|answers?|prices?|pricing)`,
  ),
  phrase("(?:is|are|was|were)(?: not|n't) (?:\\p{L}+ )?(?:listed|mentioned|specified|stated|published|documented|described|detailed)"),
  phrase(
    "(?:i|we) (?:could not|couldn't|cannot|can not|can't|was unable to|were unable to|am unable to|are unable to) (?:find|locate|confirm|see|say|tell|determine)",
  ),
  // de
  phrase("keine (?:\\p{L}+ )?(?:informationen|angaben|anleitung|hinweise)"),
  phrase("weiß ich nicht|ich weiß (?:es )?nicht|(?:keine|keinen|nichts) [^.!?\\n]{0,60}?gefunden"),
  // es
  phrase(
    `no (?:tenemos|disponemos de|contamos con|hay|existe|encontramos|encontré) ${BETWEEN}(?:información|datos|detalles|instrucciones|pasos|indicaciones|métodos?|precios?|respuesta)`,
  ),
  phrase("no (?:he|hemos|pude|pudimos|puedo|podemos) (?:podido )?(?:encontrar|confirmar|encontrado)"),
  // fr
  phrase(
    `(?:nous n'avons|je n'ai) pas (?:d'|de )${BETWEEN}(?:informations?|détails|précisions|instructions|étapes|prix|réponse|indications?)`,
  ),
  phrase("aucune (?:information|indication|précision|mention)|je ne sais pas"),
  // nl
  phrase("weet ik niet|geen informatie|(?:geen|niets) [^.!?\\n]{0,60}?gevonden"),
  // pt
  phrase(
    `não (?:temos|há|possuímos|dispomos de|encontramos|encontrei) ${BETWEEN}(?:informações|informação|dados|detalhes|instruções|passos|preços?|resposta)`,
  ),
  // it
  phrase(`non (?:abbiamo|disponiamo di|ci sono) ${BETWEEN}(?:informazion[ei]|dati|dettagli|istruzioni|passaggi|prezz[oi]|risposta)`),
];

// Whether a reply says the site lacks what was asked: "we don't have", "isn't listed",
// "couldn't find", "no information about", in the widget's seven languages.
export const saysSiteLacks = (answer: string): boolean => {
  const text = plain(answer);
  return LACKS.some((re) => re.test(text));
};

// A reworded no-answer: says the site lacks it, and gives nothing concrete.
export const declines = (answer: string): boolean => saysSiteLacks(answer) && !hasConcreteDetail(answer);

// ---- negative claims (round 5) ----
//
// Three of round 5's four blockers were replies claiming something is missing or over, which
// carry no figure or date for the older checks to catch: "The information we have does not
// provide specific cleaning steps…" (crayola.com), "Our website does not list specific
// subscription prices" (chef.io, whose /how-to-buy lists $59 and $189), "No future WhatsUp Gold
// webinar date is listed" (whatsupgold.com, a webinar five days away). A negative claim is a
// sentence that negates telling or having, whatever its subject ("the information we have", "our
// stain tips", "the page", "our website"): provide, include, list, cover, have, give, say, mention,
// state, show, specify, publish; "no … is listed"; "there are no …"; and a sentence that declares
// expiry ("has passed", "is over", "no longer"). Telling verbs count whatever their object; having
// verbs only about information, prices, dates or events ("DevCraft UI does not include Kendo UI
// for Vue" is an answer). A price of nothing ("There is no setup fee.") is never one.

// What information is called, after a having verb or as the subject that lacks it.
const INFO_EN =
  "information|info|details?|specifics|steps|instructions|guidance|guides?|tips|methods?|answers?|prices?|pricing|costs?|figures?|rates|dates?|times?|schedules?|data|documentation|mention|events?|webinars?|sessions?|contact details|phone numbers?|email address(?:es)?";
const SOURCE_EN =
  "website|site|web site|page|pages|information|info|content|text|materials?|resources?|documentation|docs|guides?|tips|faqs?|articles?|knowledge base|catalog(?:ue)?|records|sources?|listings?";
const NOT_EN = "(?:does not|doesn't|do not|don't|did not|didn't|cannot|can't|could not|couldn't|(?:is|are)(?: not|n't) able to)";
const W = "(?:[\\p{L}'-]+\\s+)";

const NEGATIVE: Record<"en" | "de" | "es" | "fr" | "other", RegExp[]> = {
  en: [
    // Telling verbs, whatever the subject: "Our website does not list…", "The page doesn't say…".
    phrase(
      `${NOT_EN}\\s+(?:currently\\s+|yet\\s+|actually\\s+|explicitly\\s+|specifically\\s+|publicly\\s+)?(?:list|say|mention|state|specify|publish|detail|describe|indicate|disclose)(?![\\p{L}])`,
    ),
    // Having and giving verbs, about information or with a source as the subject ("Our stain tips
    // don't include steps for…"). "We don't provide on-site support" is an answer.
    phrase(
      `${NOT_EN}\\s+(?:currently\\s+)?(?:have|include|cover|contain|offer|provide|give|show|share|feature)\\s+${W}{0,4}?(?:${INFO_EN})(?![\\p{L}])`,
    ),
    phrase(
      `(?:${SOURCE_EN})\\s+${W}{0,4}?${NOT_EN}\\s+(?:currently\\s+)?(?:have|include|cover|contain|offer|provide|give|show|address|go into)(?![\\p{L}])`,
    ),
    // "Prices are not listed", "No future webinar date is listed".
    phrase(
      "(?:is|are|was|were|has been|have been)(?: not|n't)\\s+(?:currently\\s+|yet\\s+|publicly\\s+|explicitly\\s+)?(?:listed|mentioned|specified|stated|published|provided|given|shown|documented|detailed|described|indicated|disclosed|announced|scheduled|posted|planned|made public)",
    ),
    phrase(
      `no\\s+${W}{0,8}?(?:is|are|was|were|has been|have been)\\s+(?:currently\\s+|yet\\s+)?(?:listed|mentioned|specified|stated|published|provided|given|shown|available|scheduled|announced|posted|planned|dated|confirmed|upcoming|coming up)`,
    ),
    phrase(
      `there (?:is|are|was|were) (?:currently |presently )?(?:no|not any)\\s+${W}{0,3}?(?:${INFO_EN}|upcoming|future|scheduled|planned|published|listed)`,
    ),
    phrase(
      `there (?:isn't|aren't|wasn't|weren't) (?:currently )?any\\s+${W}{0,3}?(?:${INFO_EN}|upcoming|future|scheduled|planned|published|listed)`,
    ),
    phrase(`(?:we|i|it|they) (?:have|has) no\\s+${W}{0,3}?(?:${INFO_EN})`),
    phrase("(?:is|are)(?: not|n't) (?:publicly |currently )?available (?:online|on (?:our|the|this) (?:web)?site|publicly|here)"),
    // Expiry: "has passed", "is over", "no longer available".
    phrase("(?:has|have) (?:already )?(?:passed|ended|expired|concluded|taken place|finished)"),
    phrase("(?:is|are|was|were) (?:already |now )?(?:over|expired|in the past)(?![\\p{L}\\p{N}]|\\s+(?:\\p{N}|\\$|a |an |the ))"),
    phrase(
      "already (?:took place|happened|passed|ended)|no longer (?:available|offered|open|running|active|valid|scheduled|on sale|taking place)",
    ),
    // "Our guides cover many stains, but red wine on carpet isn't one of them."
    phrase(
      "(?:isn't|is not|aren't|are not) (?:one of them|among them)|(?:cover|covers|include|includes|address|addresses)[^.!?]{0,80}?,? but not(?![\\p{L}])",
    ),
    phrase("(?:does not|doesn't|do not|don't) (?:allow|let) (?:us|me) (?:to )?(?:say|tell|confirm|determine)"),
    // The general shape (round 6's wordings): "isn't something these articles touch on", "don't go
    // into", "nothing in … that explains", "isn't covered in what I've got".
    phrase(
      `(?:isn't|is not|aren't|are not) something (?:that )?${W}{0,3}?(?:touch(?:es)? on|cover|covers|go(?:es)? into|address(?:es)?|mention|explain|discuss|share)`,
    ),
    phrase(`${NOT_EN}\\s+(?:really\\s+)?(?:go into|touch on|get into|spell out|discuss|explain)(?![\\p{L}])`),
    phrase(
      `nothing (?:in|on|from) ${W}{1,5}?(?:that|which) (?:explains|covers|says|mentions|describes|shows|lists|goes into|spells out|answers)`,
    ),
    phrase(`(?:isn't|is not|aren't|are not) (?:covered|included|mentioned|addressed) in what`),
  ],
  de: [
    // Telling verbs: "Unsere Website nennt keine Preise", "Für 300 Geräte nennen wir keinen konkreten Preis".
    // Telling verbs, whatever the object: "Unsere Website nennt keine Preise", "Für 300 Geräte nennen
    // wir keinen konkreten Preis", "Preise veröffentlichen wir auf unserer Website nicht".
    // Having and giving verbs, about information: "Wir haben keine Informationen", "Es gibt keine
    // Angaben", "enthalten leider nichts zum Entkalken".
    // A source as the subject, whatever it lacks: "Unsere Pflegetipps enthalten nichts…", "Die
    // Unterlagen, die uns vorliegen, erwähnen keine Versandkosten", "Unsere Kontaktseite nennt keine…".
    phrase(
      `\\p{L}*(?:website|seite|seiten|informationen|unterlagen|materialien|ratgeber|tipps|faq|dokumentation|inhalte|angaben|texte?|übersicht|katalog|anleitungen?|hinweise|artikel)(?:,[^,.!?]{0,60},)?\\s+${W}{0,1}?(?:enthalten|enthält|nennen|nennt|zeigen|zeigt|erwähnen|erwähnt|bieten|bietet|liefern|liefert|geben|gibt|behandeln|behandelt|decken|deckt|listen|listet|führen|führt|beschreiben|beschreibt|sagen|sagt)\\s+${W}{0,3}?(?:keine|keinen|kein|keines|nicht|nichts)(?![\\p{L}])`,
    ),
    phrase(
      `(?:keine|keinen|kein)\\s+(?:[\\p{L}\\p{N}.'-]+\\s+){0,12}?(?:angegeben|aufgeführt|genannt|erwähnt|veröffentlicht|gelistet|angekündigt|geplant|hinterlegt)`,
    ),
    phrase(`geht\\s+${W}{0,6}?nicht hervor|(?:gehört|gehören|zählt|zählen)\\s+${W}{0,2}?nicht dazu|nicht darunter|ist nicht dabei`),
    // Expiry: "hat bereits stattgefunden", "ist vorbei", "nicht mehr verfügbar".
    phrase("(?:hat|haben) (?:bereits |schon )?stattgefunden"),
    phrase("(?:ist|sind|war|waren) (?:bereits |schon |leider )?(?:vorbei|vorüber|abgelaufen|beendet|vergangen)"),
  ],
  es: [
    // Telling verbs: "No se indica el precio", "Nuestro sitio no menciona…".
    phrase(
      "no\\s+(?:se\\s+|lo\\s+|los\\s+|la\\s+|las\\s+)?(?:indica|indican|indicamos|menciona|mencionan|mencionamos|especifica|especifican|especificamos|publica|publican|publicamos|detalla|detallan|detallamos|lista|listan|dice|dicen|decimos|aparece|aparecen|figura|figuran|encontr[ée]|encontramos)(?![\\p{L}])",
    ),
    // Having and giving verbs, about information: "No tenemos un precio publicado", "No hay webinars próximos".
    // A source as the subject, whatever it lacks: "Nuestros materiales actuales no muestran las tallas",
    // "Nuestra página de contacto no facilita ninguna dirección".
    phrase(
      `(?:sitio|web|página|páginas|información|guías?|consejos|materiales|documentación|preguntas frecuentes|faq|contenidos?|recursos|fichas?|artículos?|catálogo)\\s+${W}{0,3}?no\\s+(?:se\\s+)?(?:muestra|muestran|incluye|incluyen|facilita|facilitan|ofrece|ofrecen|recoge|recogen|trata|tratan|cubre|cubren|contiene|contienen|da|dan|proporciona|proporcionan|tiene|tienen|explica|explican|aborda|abordan|presenta|presentan|permite|permiten)(?![\\p{L}])`,
    ),
    phrase("no se (?:ha|han) (?:publicado|indicado|anunciado|programado|especificado|confirmado|detallado|mencionado)"),
    phrase("no (?:está|están|se encuentra|se encuentran|figura|figuran) entre (?:ellas|ellos)"),
    // Expiry: "ya ha pasado", "ya se celebró", "ya no está disponible".
    phrase(
      "ya (?:ha|han) (?:pasado|terminado|finalizado|concluido|tenido lugar)|ya (?:pasó|terminó|finalizó|se celebró|se realizó|tuvo lugar)",
    ),
  ],
  fr: [
    // Telling verbs: "Notre site n'indique pas…", "La page ne précise pas…".
    // Having and giving verbs, about information: "Nous n'avons pas d'informations", "Il n'y a pas de webinaire à venir".
    phrase(
      "n['’](?:est|sont)\\s+pas\\s+(?:encore\\s+|actuellement\\s+)?(?:indiqu|mentionn|précis|list|détaill|publi|annonc|prévu|programm|communiqu|affich)\\p{L}*",
    ),
    phrase(`aucun(?:e)?s?\\s+(?:[\\p{L}'’-]+\\s+){0,6}?(?:n['’]\\p{L}+|indiqu|mentionn|publi|prévu|programm|annonc|list)\\p{L}*`),
    // "n'incluent rien sur…", "ne contient rien".
    // A source as the subject, whatever it lacks: "Notre FAQ ne fournit pas la marche à suivre",
    // "Nos supports actuels ne présentent pas les tailles".
    phrase(
      `(?:site|page|pages|informations?|faq|guides?|conseils|documentation|supports|documents|fiches?|articles?|catalogue|contenus?|ressources)\\s+(?:[\\p{L}'’-]+\\s+){0,3}?(?:ne|n['’])\\s*\\p{L}+\\s+(?:pas|rien|aucun\\p{L}*|jamais)(?![\\p{L}])`,
    ),
    // Expiry: "est déjà passé", "a déjà eu lieu", "n'est plus disponible".
    phrase("(?:est|sont|était|étaient) (?:déjà )?(?:passée?s?|terminée?s?|expirée?s?|finie?s?|révolue?s?)"),
  ],
  // Dutch, Portuguese and Italian: the "we don't have it" list (LACKS) and expiry.
  other: [],
};

// A price of nothing, said as a negation: "There is no setup fee", "Es gibt keine Einrichtungsgebühr",
// "We don't charge for updates". An answer, never a negative claim.
const NO_FEE =
  /(?<![\p{L}])(?:no|keine?n?|kein|sin|sans|aucuns?e?s?|nessun[ao]?|geen|sem)\s+(?:[\p{L}-]+\s+)?(?:\p{L}*gebühr\p{L}*|fees?|charges?|setup costs?|cargos?|cuotas?|comisi[oó]n(?:es)?|frais|kosten|spese|taxas?|costi)(?![\p{L}])|(?:don't|do not|doesn't|does not|never) charge|berechnen (?:wir )?keine|no cobramos|ne (?:facturons|facture) pas/iu;

// "On-demand only" to a question about what's coming up: the marketer's "Our webinars shown are on-demand".
const ON_DEMAND = /(?<![\p{L}])(?:on[- ]demand|bajo demanda|à la demande|en différé|als aufzeichnung|aufzeichnungen)(?![\p{L}])/iu;
const ASKS_UPCOMING =
  /(?<![\p{L}])(?:next|upcoming|coming up|future|nächste[nrs]?|kommende[nrs]?|anstehende[nrs]?|stehen an|steht an|bevorstehende[nrs]?|próxim[oa]s?|futur[oa]s?|prochain(?:e|s)?|à venir|volgende|prossim[oa])(?![\p{L}])/iu;

// The chatbot talking about its own information, with a negation in the same sentence: "aren't
// available in the information I can access", "in den mir vorliegenden Informationen nicht
// verfügbar", "les informations dont je dispose ne…", "la información con la que cuento no…".
const OWN_INFORMATION =
  /(?<![\p{L}])(?:(?:something|anything) (?:that )?(?:i|we)(?:'m| am| are|'re)? (?:have|hold|know|able to|can)|(?:information|material|materials|sources|articles|tips|guides|details|content|resources|documents|pages|text)(?: (?:that )?(?:i|we) (?:can access|can see|have(?: access to)?|(?:was|were|'ve been|have been) given|hold|'ve got)| (?:available|accessible) to (?:me|us))|my sources|what (?:i|we)(?:'ve| have)? got|what i can see|(?:anything|nothing) (?:i|we) (?:was|were) given|(?:the |our )?information (?:i|we) (?:can access|have(?: access to)?|was given|hold)|(?:the )?(?:provided|available) information|information (?:provided|available)|(?:mir|uns) vorliegenden (?:informationen|unterlagen|daten|angaben)|(?:informationen|unterlagen|daten),? (?:die|welche) (?:mir|uns) vorliegen|(?:bereitgestellten|verfügbaren|vorhandenen) (?:informationen|unterlagen|angaben)|informations? (?:dont (?:je|nous) dispos\p{L}*|à (?:ma|notre) disposition|fournies|disponibles)|información (?:con la que cuent\p{L}*|que tengo|que tenemos|disponible|proporcionada|de la que dispong\p{L}*))(?![\p{L}])/iu;
const NEGATION =
  /(?<![\p{L}])(?:not|n't|no|none|nothing|silent|stops? short|only covers?|nicht|kein\p{L}*|nichts|pas|aucun\p{L}*|rien|ningun\p{L}*|ningún|nada)(?![\p{L}])|n't(?![\p{L}])/iu;

// The general shape of a claim that the information isn't there (round 6: the rule had learned
// sentences, not the shape): one sentence with a reference to the site or the chatbot's own
// material ("the page", "my reference material", "what I can look at", "the documents in front of
// me"), an absence ("not", "nothing", "quiet on", "beyond") and a word about telling or finding
// ("mention", "cover", "come up", "figures"). A leading "No," answering a yes/no question doesn't
// count as the absence.
const LEAD_NO = /^(?:no|nein|non|nee|não)[,.!:]\s+/iu;
const SHAPE: Record<"en" | "de" | "fr" | "es" | "nl", [RegExp, RegExp, RegExp]> = {
  en: [
    /(?<![\p{L}])(?:website|site|pages?|materials?|documents?|documentation|information|info|details|sources?|references?|content|texts?|articles?|guides?|tips|notes|records|catalog(?:ue)?|faqs?|knowledge base|what (?:i|we)(?:'ve| have)? (?:got|have|can (?:see|look at|access|find)|have to work with|was given)|in front of (?:me|us)|at hand|available to (?:me|us)|(?:i|we) (?:have|was given|were given|can see|can look at|can access))(?![\p{L}])/iu,
    /(?<![\p{L}])(?:not|no|nothing|none|never|nowhere|quiet|silent|beyond (?:what|the scope)|short of|lacks?|lacking|missing|absent|empty|blank|unable|cannot)(?![\p{L}])|n't(?![\p{L}])/iu,
    /(?<![\p{L}])(?:mention\p{L}*|cover\p{L}*|says?|said|stat\p{L}*|list\p{L}*|show\p{L}*|includ\p{L}*|provid\p{L}*|give\p{L}*|gives|contain\p{L}*|detail\p{L}*|specif\p{L}*|explain\p{L}*|describ\p{L}*|address\p{L}*|come up|comes up|turn up|turns up|appear\p{L}*|find|found|spell\p{L}* out|go(?:es)? into|touch(?:es)? on|speak to|tell\p{L}*|quiet|silent|blank|empty)(?![\p{L}])/iu,
  ],
  de: [
    /(?<![\p{L}])(?:website|webseite|seiten?|informationen|unterlagen|materialien|material|quellen|dokumenten?|inhalte|angaben|texte?|ratgeber|(?:mir|uns) vorlieg\p{L}*|vorliegenden|zur verfügung)(?![\p{L}])/iu,
    /(?<![\p{L}])(?:nicht|kein\p{L}*|nichts|keinerlei|nirgends|schweig\p{L}*|fehl\p{L}*)(?![\p{L}])/iu,
    /(?<![\p{L}])(?:nenn\p{L}*|erwähn\p{L}*|enth\p{L}*|zeig\p{L}*|geb\p{L}*|gibt|sag\p{L}*|find\p{L}*|steht|stehen|hervor|beschreib\p{L}*|aufgeführt)(?![\p{L}])/iu,
  ],
  fr: [
    /(?<![\p{L}])(?:site|pages?|informations?|documents?|documentation|sources?|contenus?|textes?|guides?|conseils|ce dont (?:je|nous) dispos\p{L}*|à (?:ma|notre) disposition|dont (?:je|nous) dispos\p{L}*)(?![\p{L}])/iu,
    /(?:\bne\b|\bn['’])[^.!?]{0,40}?(?:pas|aucun\p{L}*|rien|jamais|guère)(?![\p{L}])|(?<![\p{L}])(?:aucun\p{L}*|rien|muet\p{L}*|sans)(?![\p{L}])/iu,
    /(?<![\p{L}])(?:indiqu\p{L}*|mentionn\p{L}*|précis\p{L}*|donn\p{L}*|fourni\p{L}*|contien\p{L}*|figur\p{L}*|trouv\p{L}*|parl\p{L}*|abord\p{L}*|dit|disent)(?![\p{L}])/iu,
  ],
  es: [
    /(?<![\p{L}])(?:sitio|web|páginas?|información|documentos?|documentación|fuentes?|materiales?|contenidos?|textos?|guías?|lo que (?:tengo|tenemos|puedo ver)|a mi disposición|de (?:que|lo que) dispongo)(?![\p{L}])/iu,
    /(?<![\p{L}])(?:no|ningún|ninguna|ninguno|nada|sin|nunca|silencio)(?![\p{L}])/iu,
    /(?<![\p{L}])(?:indic\p{L}*|mencion\p{L}*|especific\p{L}*|dan?|proporcion\p{L}*|contien\p{L}*|figur\p{L}*|encuentr\p{L}*|habl\p{L}*|aparec\p{L}*|dice|dicen|detall\p{L}*)(?![\p{L}])/iu,
  ],
  nl: [
    /(?<![\p{L}])(?:website|site|pagina'?s?|informatie|gegevens|bronn?en|bron|documenten|documentatie|teksten|tekst|inhoud|materiaal|wat ik (?:heb|zie|kan zien))(?![\p{L}])/iu,
    /(?<![\p{L}])(?:geen|niet|niets|nergens|ontbreek\p{L}*)(?![\p{L}])/iu,
    /(?<![\p{L}])(?:vermeld\p{L}*|staat|staan|gevonden|vond|vind\p{L}*|antwoord|noem\p{L}*|beschrijf\p{L}*|beschreven|geeft|geven|bevat\p{L}*|toon\p{L}*)(?![\p{L}])/iu,
  ],
};

// A strong absence needs no telling verb: "nothing", "nowhere", "silent", "a gap", "falls outside",
// "nichts", "nirgends", "schweigen", "rien", "nulle part", "muet", "nada", "silencio", "en blanco".
const STRONG_ABSENCE =
  /(?<![\p{L}])(?:nothing|nowhere|silent|quiet|a gap|hanging|outside (?:of )?what|stop(?:s|ped)? short of|empty[- ]handed|draws? a blank|comes? up empty|nichts|nirgends|nirgendwo|schweig\p{L}*|ins leere|keinerlei|überfragt|rien|nulle part|muett?e?s?|sous silence|chou blanc|l['’]impasse|nada|ninguna parte|silencio|en blanco|manos vacías|fuera de lo que|por alto)(?![\p{L}])/iu;
// The absence has to bear on the telling ("doesn't mention", "nothing … goes into", "geen antwoord
// gevonden"): telling first is a fact the site states ("the page says no card is needed"), unless the
// absence negates the information itself ("the page lists no prices").
const INFO_AFTER = new RegExp(
  `^\\s*(?:[\\p{L}'-]+\\s+){0,2}?(?:${INFO_EN}|preise?|precios?|prix|prijz?en|preços?|prezz[io]|dat(?:es|en|os)|termine?)(?![\\p{L}])`,
  "iu",
);
const absenceBearsOnTelling = (text: string, absence: RegExp, telling: RegExp): boolean => {
  const globally = (re: RegExp) => new RegExp(re.source, `${re.flags.replace("g", "")}g`);
  const absences = [...text.matchAll(globally(absence))];
  const tellings = [...text.matchAll(globally(telling))];
  // The negation last, as a verb-second sentence puts it ("Den genauen Tag nennt unsere Seite nicht").
  const last = (a: RegExpMatchArray) => /^\s*[.!]?\s*$/.test(text.slice((a.index ?? 0) + a[0].length));
  return absences.some(
    (a) =>
      tellings.some((t) => t.index > a.index) || INFO_AFTER.test(text.slice(a.index + a[0].length)) || (last(a) && tellings.length > 0),
  );
};
const SHAPE_ALWAYS = ["nl"];
// An obligation isn't an absence: "you must not use information included in…" states a rule the site
// sets (recheck-R2: Janes's terms, a direct "No", held as saying the site lacks it).
const OBLIGATION =
  /(?<![\p{L}])(?:must|may|shall|should|cannot be|darf|dürfen|sollen|debe\p{L}*|doit|doivent|moet\p{L}*|mag|deve\p{L}*)\s+not?(?![\p{L}])|(?<![\p{L}])(?:no|ne)\s+(?:debe\p{L}*|doit|doivent|deve\p{L}*)(?![\p{L}])|(?:mustn't|shouldn't)/giu;
const hasShape = (sentence: string, groups: readonly string[]): boolean => {
  const text = sentence.replace(LEAD_NO, "").replace(OBLIGATION, " ");
  return [...new Set([...groups, ...SHAPE_ALWAYS])].some((g) => {
    const shape = SHAPE[g as keyof typeof SHAPE];
    if (!shape?.[0].test(text)) return false;
    return STRONG_ABSENCE.test(text) || (shape[1].test(text) && shape[2].test(text) && absenceBearsOnTelling(text, shape[1], shape[2]));
  });
};

// A reply's sentences: list items and lines count as sentences of their own.
// Not after a day's ordinal ("am 2. November 2026", round 7).
const sentencesOf = (text: string): string[] =>
  plain(text)
    .split(/\n+|(?<=[!?…]|(?<!(?:^|\s)\d{1,2})\.)\s+(?=\S)/)
    .map((s) => s.trim())
    .filter(Boolean);

export interface NegativeClaim {
  // The sentence that makes it, as written.
  sentence: string;
  // It says something is over ("has passed", "no longer available"), rather than missing.
  expiry: boolean;
}

const EXPIRY =
  /(?:passed|ended|expired|concluded|taken place|finished|already|no longer|is over|are over|was over|were over|in the past|stattgefunden|vorbei|vorüber|abgelaufen|beendet|vergangen|nicht mehr|ya |ya no|expirado|caducado|passée?s?|terminée?s?|eu lieu|n['’](?:est|sont) plus|geweest|voorbij|já |più disponibile|già)/iu;

const LANGUAGE_GROUP = (language?: string): (keyof typeof NEGATIVE)[] => {
  const l = languageOf(language);
  if (l === "en" || l === "de" || l === "es" || l === "fr") return l === "en" ? ["en", "de", "es", "fr", "other"] : [l, "en", "other"];
  return ["en", "de", "es", "fr", "other"];
};

// The first sentence of a reply that claims something is missing or over, in the widget's
// languages (the reply's own first when known), or undefined. "Our website does not list
// specific subscription prices." is one; "There is no setup fee." and "We don't sell bicycles."
// aren't. With the question, "on-demand only" to a question about what's coming up is one too.
// Whether a phrase only repeats words of the question.
const echoes = (phrase: string, question?: string): boolean => {
  if (!question) return false;
  const asked = matchWords(question);
  const words = matchWords(phrase);
  return words.length > 0 && words.every((w) => asked.some((a) => sameWord(a, w)));
};

export function negativeClaim(answer: string, language?: string, question?: string): NegativeClaim | undefined {
  const groups = LANGUAGE_GROUP(language);
  for (const sentence of sentencesOf(answer)) {
    const zero = sentence.match(ZERO_PRICE)?.[0] ?? sentence.match(NO_FEE)?.[0];
    if (zero && !echoes(zero, question)) continue;
    const lacks =
      groups.some((g) => NEGATIVE[g].some((re) => re.test(sentence))) ||
      LACKS.some((re) => re.test(sentence)) ||
      (OWN_INFORMATION.test(sentence) && NEGATION.test(sentence)) ||
      hasShape(sentence, groups);
    const onDemand = !lacks && question !== undefined && ASKS_UPCOMING.test(question) && ON_DEMAND.test(sentence);
    if (lacks || onDemand) return { sentence, expiry: onDemand || EXPIRY.test(sentence) };
  }
  return undefined;
}

// Whether a negative claim is about the thing asked (round 6: scope-aware). Its object, the negated
// clause without the words that frame it, names something the question asks about (a word of the
// question, a word for the kind of content asked, or the same intent); or it names nothing in
// particular ("Our website doesn't specify", "I couldn't find that"); or the reply says nothing else
// but how to reach the team. "…with nothing in Progress Cloud" to "Can I run it on my own servers?"
// isn't about it. Without the question, it is.
function claimAboutQuestion(claim: NegativeClaim, answer: string, question?: string): boolean {
  if (!question) return true;
  const object = claimObject(claim);
  if (!object.length) return true;
  const asked = matchWords(question);
  if (relatedWords(object, asked) > 0) return true;
  // About the kind of thing asked: dates for "when" ("Es wurden noch keine Termine veröffentlicht" to
  // "Wann beginnt der nächste Schulungskurs?"), a contact for contact, steps for "how do I".
  const clause = negatedClause(claim.sentence);
  const kind = askedKind(question);
  if (kind && KIND_WORDS[kind].test(clause)) return true;
  const intents = questionIntents(question);
  if (questionIntents(clause).some((i) => intents.includes(i))) return true;
  // Nothing else in the reply but the claim and "contact us": not when it opens with a plain yes or
  // no, nor when the claim's sentence says something else beside it ("Yes. … stores everything in your
  // own NucliaDB instance, with nothing in Progress Cloud.", agentic-rag, round 6).
  const besides = claim.sentence
    .split(CLAUSES)
    .some((c) => !clause.includes(c) && matchWords(c).some((w) => !isFrame(w) && !CONTACT_WORDS.has(w) && !/^confirm/.test(w)));
  if (LEAD_YES_NO.test(plain(answer)) || besides) return false;
  return sentencesOf(answer).every((s) => s === claim.sentence || tellsToContact(s) || !matchWords(s).length);
}

// ---- what the reply does with what was asked (round 6, item 6) ----
//
// Round 6's reviewers found the verdict deciding by phrases: a negative anywhere held a correct
// answer ("…no card is needed" to "Can I get a free trial?", "…with nothing in Progress Cloud" to
// "Can I run it on my own servers?"), while replies that only point elsewhere ("Contact us through
// our Contact page") or give a demo to a question about a trial passed. These read what the reply
// does with the thing asked: a claim counts only when its object is what was asked; a reply whose
// only way forward is one pointer is a deflection; a reply that gives a step for another thing of
// the same kind, and none for the thing asked, is a substitution.

// The words that frame a claim rather than name its object: the source, the telling, the absence.
const FRAME_EXTRA = new Set(
  matchWords(
    "specific specifics exact currently explicitly actually really sorry unfortunately leider lamentablemente malheureusement helaas available able access hand name naming question answer antwort respuesta reponse antwoord vraag pregunta informacion pagina paginas indica deze vond geen",
  ),
);
export const isFrame = (w: string): boolean =>
  FRAME_EXTRA.has(w) || STRONG_ABSENCE.test(w) || Object.values(SHAPE).some((g) => g.some((re) => re.test(w)));

// The clause of a sentence that holds its negation, with the clause it governs: "…your own servers,
// with nothing in Progress Cloud" → "with nothing in Progress Cloud"; "Unsere Materialien zeigen
// nicht, in welchen Größen …" → both clauses.
const CLAUSES = /[,;:–—]\s+|\s+(?:but|whereas|while|pero|mais|maar|mas)\s+/iu;
const COMPLEMENT =
  /^(?:(?:in|for|on|about|an|für|en|para|pour|voor)\s+)?(?:whether|if|how|what|when|where|which|ob|wie|was|wann|wo|welche\p{L}*|si|cómo|qué|cuándo|dónde|comment|quand|où|quel\p{L}*|hoe|of|wat|wanneer|waar|welke)(?![\p{L}])/iu;
function negatedClause(sentence: string): string {
  const parts = sentence.split(CLAUSES).filter(Boolean);
  const negated = (c: string) => negativeClaim(c) !== undefined || NEGATION.test(c) || STRONG_ABSENCE.test(c);
  const kept = parts.flatMap((c, i) => {
    if (negated(c)) return [c];
    // A clause the negation governs: "…zeigen nicht, in welchen Größen …".
    const before = parts[i - 1];
    return before && negated(before) && COMPLEMENT.test(c) ? [c] : [];
  });
  return kept.length ? kept.join(", ") : sentence;
}

// The words of the thing a claim says is missing: its negated clause, without the words that frame it.
const claimObject = (claim: NegativeClaim): string[] => matchWords(negatedClause(claim.sentence)).filter((w) => !isFrame(w));

// A reply that opens with a plain yes or no.
const LEAD_YES_NO = /^[\s*_"“]*(?:yes|no|ja|nein|s[ií]|non?|oui|nee|sim|não)[\s*_"”]*[,.!:;—–-]/iu;

// A place to go: a page, a form, a link or a section, including compounds ("Kontaktseite",
// "contactpagina", "contactformulier"), in the widget's languages.
const PLACE =
  /(?:page|pages|form|formular|formulario|formulaire|formulier|formulário|modulo|link|section|seite|seiten|página|páginas|pagina|pagine|site|website|portal|centre|center|centro)(?![\p{L}])|\]\(/iu;
// A way to talk to someone, beside the pages and forms: a call, a callback, a chat.
const TALK =
  /(?<![\p{L}])(?:call\p{L}*|phone\p{L}*|ring|chat\p{L}*|rappel\p{L}*|appel\p{L}*|téléphon\p{L}*|bel|belt|bellen|terugbel\p{L}*|anruf\p{L}*|rückruf\p{L}*|telefon\p{L}*|llam[ae]\p{L}*|teléfono|ligue|ligar|ligamos|telefone|chiam\p{L}*|telefono)(?![\p{L}])/iu;
// A question about where something is: a pointer answers it ("Where can I find free coloring pages?").
const WHERE = /(?<![\p{L}])(?:where|wo|wohin|dónde|donde|où|waar|onde|dove)(?![\p{L}])/iu;

// A sentence that only sends the visitor somewhere: to a page or form, or to the team, with nothing
// concrete of its own (no figure, date, address, link or list).
const pointsOnly = (s: string): boolean => (PLACE.test(s) || tellsToContact(s)) && !hasConcreteDetail(s);

// A contact detail visitors can use as it stands: an email address, a phone number, a link.
const CONTACT_DETAIL = (s: string): boolean => {
  const text = plain(s);
  return (
    EMAIL_IN.test(text) ||
    [...text.matchAll(PHONE_IN)].some((m) => m[0].replace(/\D/g, "").length >= 7) ||
    /https?:\/\/|\bwww\./i.test(text)
  );
};
const ALTERNATIVES = /(?<![\p{L}])(?:or|oder|ou|oppure)\s+(?:\p{L}+\s+){0,3}\p{L}/iu;
const EMAIL_IN = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/;
const PHONE_IN = /\+?\d[\d\s().\-– ]{6,}\d/g;

// A deflection: the reply's only way forward is a pointer, with nothing from the site about what was
// asked. For a contact question, a reply with no contact detail that offers one way (the contact
// page, the form) and nothing else; for any other question (not "where is…"), a reply made only of
// pointers. Returns the pointer sentence.
function deflects(answer: string, question?: string, evidence?: readonly string[]): string | undefined {
  if (!question || WHERE.test(question)) return undefined;
  // A rhetorical question ("Nog geen klant?") is neither content nor a pointer.
  const sentences = sentencesOf(answer).filter((s) => !/\?$/.test(s) || pointsOnly(s));
  const pointers = sentences.filter(pointsOnly);
  if (!pointers.length) return undefined;
  if (askedKind(question) === "contact") {
    // A contact detail, a list of ways, or a way to talk to someone (a call, a callback, a chat)
    // answers it; a page or a form to fill in, however worded, only points (round 6: "Contact us
    // through our Contact page. A representative will respond within one business day.").
    if (CONTACT_DETAIL(answer) || listsThings(answer) || TALK.test(plain(answer))) return undefined;
    // Two ways named, each its own ("the contact form on …; for a local sales contact, … Worldwide
    // Presence", "**Contact Sales** or **Speak to Sales**"), in any language's quotes or in bold, or
    // offered as alternatives ("your Customer Success Manager or our Knowledge Base"): ways to reach
    // the team, the answer to a contact question (recheck-R2; round 7's replay).
    if (new Set(answer.match(/[“"«„][^”"»“]{3,80}[”"»“]|\*\*[^*]{3,80}\*\*/g) ?? []).size >= 2) return undefined;
    if (pointers.some((p) => ALTERNATIVES.test(plain(p)))) return undefined;
    // The contact page or form is the answer when it's what the site offers: the reply names it, cites
    // a contact page, and the cited text holds no phone or email it leaves out (whatsupgold.com's
    // "complete the contact form on our Contact Us page").
    if (evidence?.some((e) => KIND_WORDS.contact.test(e)) && pointers.some((p) => PLACE.test(p)) && !evidence.some(CONTACT_DETAIL))
      return undefined;
    return pointers[0];
  }
  // Any other question: every sentence a pointer, or about the place it points to.
  // A price or a date asked, and only a place to look ("You'll find everything about our events on
  // the Events page"). Not for steps or anything else: "Go to the Billing page" can be the step.
  const kind = askedKind(question);
  if (kind !== "price" && kind !== "date") return undefined;
  return sentences.every(pointsOnly) ? pointers[0] : undefined;
}

// Things of one kind that don't stand in for each other: a demo isn't a trial, an email address isn't
// a phone number. Each with how the reply gives it, when it's a detail.
const KINDS_APART: { name: string; words: RegExp; given?: (text: string) => boolean }[][] = [
  [
    {
      name: "a trial",
      words:
        /(?<![\p{L}])(?:trials?|try|testversion\p{L}*|probeversion\p{L}*|testen|prueba\p{L}*|probar|essai\p{L}*|essayer|proefversie\p{L}*|proberen|uitproberen|teste|testar|experimentar|prova|provare)(?![\p{L}])/iu,
    },
    {
      name: "a demo",
      words: /(?<![\p{L}])(?:demos?|demonstrations?|démos?|demostraci\p{L}*|demonstra\p{L}*|vorführung\p{L}*)(?![\p{L}])/iu,
    },
  ],
  [
    {
      name: "a phone number",
      words:
        /(?<![\p{L}])(?:phone\p{L}*|telephon\p{L}*|call|calls|calling|t[eé]l[eé]phon\p{L}*|telef[oó]n\p{L}*|telefoon\p{L}*|numéro|number|nummer|número|numero)(?![\p{L}])/iu,
      given: (t) => [...plain(t).matchAll(PHONE_IN)].some((m) => m[0].replace(/\D/g, "").length >= 7),
    },
    {
      name: "an email address",
      words: /(?<![\p{L}])(?:e-?mails?|correo|courriel|e-?mailadres)(?![\p{L}])/iu,
      given: (t) => EMAIL_IN.test(plain(t)),
    },
  ],
];

// A substitution: the question asks for one thing of a kind, and the reply (its claims left out)
// gives a step or detail for another of that kind and nothing for the thing asked: a demo to a
// question about a free trial, an email address to "What is your phone number?".
function substitutes(answer: string, question?: string, claim?: NegativeClaim): { asked: string; offered: string } | undefined {
  if (!question) return undefined;
  const rest = sentencesOf(answer)
    .filter((s) => s !== claim?.sentence && !negativeClaim(s))
    .join(" ");
  if (!rest) return undefined;
  for (const kinds of KINDS_APART) {
    const asked = kinds.filter((k) => k.words.test(question));
    if (asked.length !== 1) continue;
    const [want] = asked;
    if (!want) continue;
    const other = kinds.find((k) => k !== want && (k.given?.(rest) || k.words.test(rest)));
    const answered = want.words.test(rest) || want.given?.(rest);
    if (other && !answered) return { asked: want.name, offered: other.name };
  }
  return undefined;
}

// ---- the thing asked, against what the reply is about (recheck-R3) ----
//
// Half of the sealed misses were substitutions no list of things could name: a date for a related
// thing, a contact for another region, features instead of the price asked. So these read the question's
// asked thing and the reply's subject, in any words. What a text rule can't tell (a paraphrase, a
// neighbouring feature in the question's own words) is the judge's, in validation, the picker and the
// re-run; the chat has no judge, and catches only what these do.

// A question's words for the thing asked: beyond its frame and the words for the kind of content it
// asks for ("the next webinar" asks about a webinar; "the phone number for Germany", about Germany).
const KIND_FRAME: Partial<Record<AskedKind, RegExp>> = {
  date: /^(?:coming|come|date|time|schedul\p{L}*|upcoming|future|next|event|termin\p{L}*|datum|daten|kommend\p{L}*|nachst\p{L}*|veranstaltung\p{L}*|fecha|proxim\p{L}*|evento|horario|prochain\p{L}*|evenement|venir|start|begin\p{L}*|happen\p{L}*|take|place|held|take)$/u,
  contact:
    /^(?:contact\p{L}*|phone|telephone|number|e?-?mail\p{L}*|address\p{L}*|kontakt\p{L}*|telefon\p{L}*|nummer|adresse|telefono|correo|direccion|courriel|numero|reach|call|talk|speak|touch|sale|support|help|hilfe|vertrieb|soporte|venta|ayuda|assistance|aide|erreiche\p{L}*|team|someone|person|get)$/u,
};
let commonWords: Set<string> | undefined;
const askedThing = (question: string, kind: AskedKind): string[] => {
  const frame = KIND_FRAME[kind];
  // The commonest words of each language (WORDS, below) ask, they don't name: "Quel est votre numéro".
  commonWords ??= new Set(Object.values(WORDS).flatMap(matchWords));
  const common = commonWords;
  return matchWords(question).filter((w) => !isFrame(w) && !frame?.test(w) && !common.has(w) && !/^\d/.test(w));
};

// How many different emails and phone numbers a reply gives.
const contactDetails = (answer: string): number => {
  const text = plain(answer);
  const phones = [...text.matchAll(PHONE_IN)].map((m) => m[0].replace(/\D/g, "")).filter((d) => d.length >= 7);
  return new Set([...phones, ...(text.match(new RegExp(EMAIL_IN.source, "g")) ?? [])]).size;
};
// A word the question capitalises past its first word: a name, or a German noun.
const namedInQuestion = (word: string, question: string): boolean =>
  question
    .split(/[^\p{L}\p{N}]+/u)
    .slice(1)
    .some((w) => /^\p{Lu}/u.test(w) && matchWords(w).includes(word));

// A sentence's scope when it opens with one ("For California privacy requests, call…"): its words.
const SCOPE = /^(?:for|für|fuer|para|pour|voor|per)\s+([^,:]{3,80})[,:]/iu;

// Whether two texts are in one language, as far as can be told: words can only be compared then.
const sameTongue = (a: string, b: string) => {
  const [x, y] = [detectLanguage(a), detectLanguage(b)];
  return !x || !y || x === y;
};

// "Opening hours and prices?" answered with the hours: a part answered, not another subject.
const answersAnotherPart = (answer: string, question: string, kind: AskedKind) => {
  const parts = question.split(/\s(?:and|y|und|et|en|e)\s/i);
  return parts.length > 1 && parts.some((p) => askedKind(p) !== kind && relatedWords(matchWords(p), matchWords(answer)) > 0);
};

// The reply gives content of the kind asked for, but about something else: a date with nothing of the
// thing asked in the reply, a contact scoped to another subject. Or it gives no content of the kind
// asked at all, and doesn't say so: features to a price question, on-demand recordings to "when".
function otherSubject(answer: string, content: GroundedContent, question?: string): { asked: string; offered: string } | undefined {
  const kind = askedKind(question);
  if (!question || !kind || LEAD_YES_NO.test(plain(answer))) return undefined;
  // A reply that says what it can't give is honest about it: the claim rules judge it, not these.
  if (NEGATION.test(plain(answer))) return undefined;
  const sentences = sentencesOf(answer);
  if (kind === "price" || kind === "date") {
    const said = plain(answer);
    const has =
      kind === "price"
        ? // How the site prices, without a figure, is still about the price (a comparison answered
          // with its own pricing model): what's missing is for the judge, not a change of subject.
          content.items.some((i) => i.kind === "price") || BY_QUOTE.test(said) || ZERO_PRICE.test(said) || KIND_WORDS.price.test(said)
        : DAYS.test(said) || /\d/.test(said);
    if (!has) {
      if (tellsToContact(answer) || sentences.every(pointsOnly) || wordCount(answer) < 6 || answersAnotherPart(answer, question, kind))
        return undefined;
      return { asked: kind === "price" ? "a price" : "a date", offered: "other details" };
    }
  }
  if (kind !== "date" && kind !== "contact") return undefined;
  if (!sameTongue(question, answer)) return undefined;
  const gives = (s: string) => (kind === "date" ? datesIn(s).length > 0 : CONTACT_DETAIL(s));
  const giving = sentences.filter(gives);
  if (!giving.length) return undefined;
  // Several numbers or addresses, each for its own place or team, answer "what is your number?": a
  // directory isn't another subject.
  if (kind === "contact" && contactDetails(answer) >= 2) return undefined;
  // A contact asked for someone ("for support"), and every one given is for another subject.
  const target = /(?<![\p{L}])(?:for|für|fuer|para|pour|voor|per|to|an|al|au|aan)\s/iu.test(question);
  const asked = matchWords(question);
  const scopedAway =
    target &&
    giving.every((s) => {
      const scope = plain(s).match(SCOPE)?.[1];
      return scope && relatedWords(matchWords(scope), asked) === 0;
    });
  if (scopedAway) return { asked: "what was asked", offered: "something else" };
  // "Any events coming up?" asks for any event: a workshop's date answers it.
  if (kind === "date" && matchWords(question).some((w) => /^(?:event|veranstaltung|evenement|evento|termin)/.test(w))) return undefined;
  // A contact asked for, and one given: only a name the question gives (Germany, the Boston office)
  // shows it's someone else's. Its other words may be the language's own for a phone number or a
  // help desk ("telefoonnummer", "klantenservice"), which a reply needn't repeat.
  const thing = kind === "contact" ? askedThing(question, kind).filter((w) => namedInQuestion(w, question)) : askedThing(question, kind);
  if (thing.length && relatedWords(thing, matchWords(answer)) === 0) return { asked: thing.join(" "), offered: "something else" };
  return undefined;
}

// A claim denying what was asked (its object is words of the question), and no other sentence of the
// reply saying anything of that object: what it gives is beside what it denies.
function besideTheDenied(claim: NegativeClaim, answer: string, question?: string): boolean {
  if (!question || !sameTongue(question, answer)) return false;
  const asked = matchWords(question).filter((w) => !isFrame(w));
  const denied = claimObject(claim).filter((w) => asked.some((a) => sameWord(a, w)));
  if (!denied.length) return false;
  const rest = matchWords(
    sentencesOf(answer)
      .filter((s) => s !== claim.sentence && !tellsToContact(s))
      .join(" "),
  );
  return rest.length > 0 && relatedWords(denied, rest) === 0;
}

// To a price question, a reply that says prices are listed or shown, and gives none ("Pricing is
// listed starting at 50 devices, not specifically for 300 devices. Contact Sales for a quote."). The
// sentence that says so.
const TELLS =
  /(?<![\p{L}])(?:listed|shown|stated|published|displayed|aufgeführt|angegeben|aparecen|indicados?|affichés?|indiqués?|vermeld)(?![\p{L}])/iu;
function pricesUnstated(answer: string, content: GroundedContent, question?: string): string | undefined {
  if (askedKind(question) !== "price") return undefined;
  if (content.items.some((i) => i.kind === "price" && /\p{N}/u.test(i.text))) return undefined;
  return sentencesOf(answer).find((s) => {
    const first = s.split(CLAUSES)[0] ?? s;
    return KIND_WORDS.price.test(first) && TELLS.test(first) && !NEGATION.test(first);
  });
}

// ---- grounding (round 5) ----
//
// A reply's concrete content, each item checked against the passages it cites: price figures
// (in local formats: "$2,205", "2.205 US-Dollar" and "2 205 $" are one figure), a price of
// nothing, dates (day and month in the widget's languages), phone numbers and email addresses,
// links, steps (list items or sentences, by their words), and any other figure of two digits or
// more. A figure the question itself states ("300 devices") needs no grounding.

export type ContentKind = "price" | "date" | "contact" | "link" | "steps" | "figure";

export interface ContentItem {
  kind: ContentKind;
  text: string;
  // On a cited passage (always true when there were no passages to check against).
  found: boolean;
}

export interface GroundedContent {
  items: ContentItem[];
  // Kinds with at least one item found.
  kinds: Set<ContentKind>;
  // Something concrete, and every figure, date, contact and step is on a cited passage.
  grounded: boolean;
  // Whether there were passages to check against at all.
  verified: boolean;
}

const CURRENCY_SIGN = "US\\$|[$€£¥₹]";
const CURRENCY_WORD = "USD|EUR|GBP|CHF|CAD|AUD|NZD|SEK|NOK|DKK|JPY|INR|US-Dollar|euros?|dollars?|dólares|pounds?";
const AMOUNT = "\\d(?:[\\d.,]*\\d|(?:[\\s\\u00a0\\u202f]\\d{3})+)?";
const PRICE_AMOUNTS = new RegExp(
  `(?:${CURRENCY_SIGN}|\\b(?:USD|EUR|GBP|CHF|CAD|AUD|NZD|SEK|NOK|DKK|JPY|INR))\\s?(${AMOUNT})|(${AMOUNT})\\s?(?:${CURRENCY_SIGN}|(?:${CURRENCY_WORD})(?![\\p{L}]))`,
  "giu",
);
const NUMBERS = new RegExp(AMOUNT, "g");
// A figure's amount whatever its local format (Track A's content-plan.ts figureValue, copied here
// for the widget): "1 250 €" and "1.250 €" are 1250, "37,5 €" and "37,50 €" are 37.5, "$9.99" is
// 9.99. A separator before exactly 3 digits groups thousands; before 1 or 2 at the end, decimals.
const figureKey = (n: string): string => {
  const compact =
    n
      .replace(/[^\d.,\s\u00a0\u202f]/g, "")
      .trim()
      .replace(/(\d)[\s\u00a0\u202f]+(?=\d{3}(?!\d))/g, "$1")
      .split(/\s/)[0] ?? "";
  const m = /^(.*?)[.,](\d{1,2})$/.exec(compact);
  const whole = String(Number((m ? (m[1] ?? "") : compact).replace(/[.,]/g, "") || "0"));
  const cents = m?.[2]?.padEnd(2, "0");
  return cents && cents !== "00" ? `${whole}.${cents.replace(/0$/, "")}` : whole;
};

// Each price a text states, with its amount as a number whatever the local format ("1 250 €" is
// 1250, "37,50 €" is 37.5) and where it stands: for the price table check (price-claims.ts).
export const priceAmounts = (text: string): { text: string; value: number; at: number; end: number }[] =>
  [...plain(text).matchAll(PRICE_AMOUNTS)].map((m) => ({
    text: m[0].trim(),
    value: Number(figureKey(m[1] ?? m[2] ?? "")),
    at: m.index,
    end: m.index + m[0].length,
  }));

const MONTH_NAMES: string[][] = [
  ["january", "jan", "januar", "enero", "janvier", "januari", "janeiro", "gennaio"],
  ["february", "feb", "februar", "febrero", "février", "fevrier", "februari", "fevereiro", "febbraio"],
  ["march", "mar", "märz", "maerz", "marzo", "mars", "maart", "março", "marco"],
  ["april", "apr", "abril", "avril", "aprile"],
  ["may", "mai", "mayo", "mei", "maio", "maggio"],
  ["june", "jun", "juni", "junio", "juin", "junho", "giugno"],
  ["july", "jul", "juli", "julio", "juillet", "julho", "luglio"],
  ["august", "aug", "agosto", "août", "aout", "augustus"],
  ["september", "sep", "sept", "septiembre", "setiembre", "septembre", "setembro", "settembre"],
  ["october", "oct", "oktober", "octubre", "octobre", "outubro", "ottobre"],
  ["november", "nov", "noviembre", "novembre", "novembro"],
  ["december", "dec", "dezember", "diciembre", "décembre", "decembre", "dezembro", "dicembre"],
];
const MONTH_INDEX = new Map(MONTH_NAMES.flatMap((names, i) => names.map((n) => [n, i + 1] as [string, number])));
const MONTH_WORD = [...MONTH_INDEX.keys()].sort((a, b) => b.length - a.length).join("|");
const DAY_MONTH = new RegExp(
  `(?<![\\p{L}\\p{N}])(\\d{1,2})(?:st|nd|rd|th|\\.|er)?\\s+(?:of\\s+|de\\s+)?(${MONTH_WORD})(?![\\p{L}])`,
  "giu",
);
const MONTH_DAY = new RegExp(`(?<![\\p{L}])(${MONTH_WORD})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?![\\p{N}])`, "giu");
const ISO_DATE = /\b(\d{4})-(\d{2})-(\d{2})\b/g;
const PHONE = /\+?\d[\d\s().\-– ]{6,}\d/g;
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const URL_IN_TEXT = /\]\((https?:\/\/[^)\s]+)\)|https?:\/\/[^\s)\]>"']+/g;

// Each date's month and day ("11-5"), in the order written.
// Each date's month and day as "11-4", in the order written (validation checks which event an answer names first).
export const dateKeys = (text: string): string[] => datesIn(text).map((d) => d.key);

export function datesIn(text: string): { key: string; text: string; at: [number, number] }[] {
  const out: { key: string; text: string; at: [number, number] }[] = [];
  for (const m of text.matchAll(DAY_MONTH)) {
    const month = MONTH_INDEX.get((m[2] ?? "").toLowerCase());
    if (month) out.push({ key: `${month}-${Number(m[1])}`, text: m[0], at: [m.index, m.index + m[0].length] });
  }
  for (const m of text.matchAll(MONTH_DAY)) {
    const month = MONTH_INDEX.get((m[1] ?? "").toLowerCase());
    // "may" only as a month with a day after it, which this is.
    if (month) out.push({ key: `${month}-${Number(m[2])}`, text: m[0], at: [m.index, m.index + m[0].length] });
  }
  for (const m of text.matchAll(ISO_DATE))
    out.push({ key: `${Number(m[2])}-${Number(m[3])}`, text: m[0], at: [m.index, m.index + m[0].length] });
  return out;
}

const sameHref = (a: string) =>
  a
    .replace(/[#?].*$/, "")
    .replace(/\/+$/, "")
    .toLowerCase();

// What a set of passages states, for checking a reply's content against it.
interface Evidence {
  text: string;
  lower: string;
  figures: Set<string>;
  digits: string[];
  dates: Set<string>;
  words: () => string[];
}
function evidenceOf(passages: readonly string[]): Evidence {
  const text = plain(passages.join("\n"));
  const figures = new Set((text.match(NUMBERS) ?? []).map(figureKey));
  for (const m of text.matchAll(PRICE_AMOUNTS)) figures.add(figureKey(m[1] ?? m[2] ?? ""));
  let words: string[] | undefined;
  return {
    text,
    lower: text.toLowerCase(),
    figures,
    digits: passages.map((p) => p.replace(/\D/g, "")),
    dates: new Set(datesIn(text).map((d) => d.key)),
    words: () => {
      words ??= matchWords(text);
      return words;
    },
  };
}

// The reply's concrete content, each item checked against the passages of the pages it cites,
// then against the rest of what was retrieved (`retrieved`): a figure on a retrieved page the model
// didn't cite is still on the site (Kemp's $0.41 per hour, round 5). Grounded needs something on a
// cited page. Without passages (undefined), every item counts as found: the reply's own content,
// unverified.
export function groundedContent(
  answer: string,
  passages: readonly string[] | undefined,
  opts: { question?: string; urls?: readonly string[]; retrieved?: readonly string[] } = {},
): GroundedContent {
  const text = plain(answer);
  const items: ContentItem[] = [];
  const verified = passages !== undefined;
  const cited = evidenceOf(passages ?? []);
  const others = opts.retrieved?.length ? evidenceOf(opts.retrieved) : undefined;
  const asked = new Set((opts.question?.match(NUMBERS) ?? []).map(figureKey));
  const used: [number, number][] = [];
  let onCited = 0;
  const free = (at: [number, number]) => !used.some(([a, b]) => at[0] < b && at[1] > a);
  const add = (kind: ContentKind, itemText: string, on: (e: Evidence) => boolean, at?: [number, number]) => {
    const here = on(cited);
    if (here) onCited++;
    items.push({ kind, text: itemText.trim(), found: !verified || here || Boolean(others && on(others)) });
    if (at) used.push(at);
  };

  for (const m of text.matchAll(URL_IN_TEXT)) {
    const url = m[1] ?? m[0];
    const listed = (opts.urls ?? []).some((u) => sameHref(u) === sameHref(url));
    add("link", url, (e) => listed || e.lower.includes(sameHref(url)), [m.index, m.index + m[0].length]);
  }
  for (const m of text.matchAll(EMAIL)) {
    const at: [number, number] = [m.index, m.index + m[0].length];
    if (free(at)) add("contact", m[0], (e) => e.lower.includes(m[0].toLowerCase()), at);
  }
  for (const m of text.matchAll(PRICE_AMOUNTS)) {
    const key = figureKey(m[1] ?? m[2] ?? "");
    const at: [number, number] = [m.index, m.index + m[0].length];
    if (key && free(at)) add("price", m[0], (e) => e.figures.has(key) || asked.has(key), at);
  }
  // A price of nothing that only repeats the question ("free trial" to "Is there a free trial?") is
  // the thing asked, not content.
  if (ZERO_PRICE.test(text) && !echoes(text.match(ZERO_PRICE)?.[0] ?? "", opts.question)) {
    add("price", text.match(ZERO_PRICE)?.[0] ?? "", (e) => ZERO_PRICE.test(e.text) || /\$\s?0\b|\b0\s?(?:€|\$)|\bfree\b/i.test(e.text));
  }
  // Prices by quote, with where to ask for one (a page, a form, a link): the demo's price answer
  // ("pricing is tailored to your scope… visit our Request a Quote page"). "Contact our sales team
  // for a quote" alone isn't (chef.io's denial); the key pages' figures are checked in validation.
  if (BY_QUOTE.test(text) && QUOTE_PLACE.test(text)) add("price", text.match(BY_QUOTE)?.[0] ?? "", (e) => BY_QUOTE.test(e.text));
  for (const d of datesIn(text)) if (free(d.at)) add("date", d.text, (e) => e.dates.has(d.key), d.at);
  for (const m of text.matchAll(PHONE)) {
    const digits = m[0].replace(/\D/g, "");
    const at: [number, number] = [m.index, m.index + m[0].length];
    if (digits.length >= 7 && free(at)) add("contact", m[0], (e) => e.digits.some((h) => h.includes(digits)), at);
  }
  for (const m of text.matchAll(NUMBERS)) {
    const key = figureKey(m[0]);
    const at: [number, number] = [m.index, m.index + m[0].length];
    if (key.length >= 2 && free(at) && !asked.has(key)) add("figure", m[0], (e) => e.figures.has(key), at);
  }
  // Steps: list items, else the sentences that aren't a claim or "contact us" (with what follows a
  // claim's "but": "Our guide doesn't cover painted walls, but for washable surfaces we recommend…"),
  // a sentence naming three things or more counting as that many, by their words.
  const lines = text.split("\n").filter((l) => /^\s*(?:[-*•]|\d+[.)])\s+\S/.test(l));
  const prose = sentencesOf(text).flatMap((s) => {
    if (tellsToContact(s)) return [];
    if (!negativeClaim(s)) return [s];
    const rest = s
      .split(/,?\s+(?:but|however|aber|jedoch|doch|pero|sin embargo|mais|cependant)\s+/i)
      .slice(1)
      .join(" ");
    return rest && !negativeClaim(rest) ? [rest] : [];
  });
  const units = (
    lines.length >= 2
      ? lines
      : prose.flatMap((s) => ((s.match(/,/g) ?? []).length >= 2 ? s.split(/,\s*(?:and\s+|und\s+|y\s+|et\s+)?/) : [s]))
  ).map((u) => matchWords(u));
  const steps = units.filter((u) => u.length >= 2);
  if (steps.length >= 2) {
    const on = (e: Evidence) => {
      const n = steps.filter((u) => relatedWords(u, e.words()) >= Math.min(2, u.length)).length;
      return n >= 2 && n * 2 >= steps.length;
    };
    add("steps", `${steps.length} steps`, on);
  }
  const kinds = new Set(items.filter((i) => i.found).map((i) => i.kind));
  // Figures, dates and contacts must be on the pages; prose read as steps or a link needn't be
  // ("Gold costs $59 per node, per year. For a custom quote, visit our pricing page." is grounded).
  const missing = items.some((i) => !i.found && i.kind !== "link" && i.kind !== "steps");
  return { items, kinds, grounded: verified && onCited > 0 && !missing, verified };
}

// Whether a reply's concrete content (figures, dates, contacts, links, steps) is on the passages
// it cites: something concrete, and nothing concrete that isn't there.
export const grounded = (answer: string, citedPassages: readonly string[]): boolean => groundedContent(answer, citedPassages).grounded;

// The kind of content that answers a question: a figure for a price, a date for "when" or an
// event, a contact or link for contact and support, steps for "how do I". Undefined: any
// concrete content does.
export type AskedKind = "price" | "date" | "contact" | "steps";
// The intent words for a price (relevance.ts), never "licensing" or "subscription" alone.
const PRICE_ASKED = new Set(
  Object.values(INTENT_WORDS.price)
    .flatMap(matchWords)
    .filter((w) => !/^(?:licen|subscri)/.test(w)),
);
const WHEN_WORD = /(?<![\p{L}])(?:when|what time|what date|wann|cuándo|quand|wanneer|quando|date|datum|fecha)(?![\p{L}])/iu;
const WHEN = /(?<![\p{L}])(?:next|upcoming|nächste[nrs]?|próxim[oa]s?|prochain(?:e|s)?|prossim[oa])\s/iu;
// "Wann ist MVTec auf der embedded world?" names no events word: on a site with events it's asked of
// them first, unless it names another intent (round 7).
export const asksWhen = (question: string): boolean => WHEN_WORD.test(question) && !questionIntents(question).length;
const HOW_TO =
  /^[\s¿¡]*(?:how (?:do|can|should|would|could) (?:i|we|you)|how to|what (?:are|is) the (?:steps|best way)|wie (?:kann|könnte|muss|mache|entferne|bekomme|lösche|richte)|cómo|como (?:puedo|posso)|comment|hoe (?:kan|moet)|come (?:posso|faccio))\b/iu;
export function askedKind(question?: string): AskedKind | undefined {
  if (!question) return undefined;
  const intents = questionIntents(question);
  // A price is asked for in price words, never "licensing" or "subscription" alone ("What is the
  // difference between online and offline licensing?" asks for steps).
  if (/how much|cu[aá]nto|combien|quanto|wie viel/i.test(question) || matchWords(question).some((w) => PRICE_ASKED.has(w))) return "price";
  if (intents.includes("contact") || intents.includes("support")) return "contact";
  if (intents.includes("events") || WHEN_WORD.test(question) || WHEN.test(question)) return "date";
  if (HOW_TO.test(question)) return "steps";
  return undefined;
}

// Words for each kind of content, in the widget's languages, for whether a claim is about it.
const KIND_WORDS: Record<AskedKind, RegExp> = {
  price:
    /(?<![\p{L}])(?:pric\p{L}*|cost\p{L}*|fees?|rates?|quote\p{L}*|preis\p{L}*|kosten|angebot|precio\p{L}*|tarifa\p{L}*|coste?s?|prix|tarifs?|devis|prijs\p{L}*|preço\p{L}*|prezz\p{L}*)(?![\p{L}])/iu,
  date: /(?<![\p{L}])(?:dates?|times?|schedul\p{L}*|upcoming|future|next|events?|webinars?|sessions?|termin\p{L}*|datum|daten|kommende\p{L}*|nächste\p{L}*|veranstaltung\p{L}*|fechas?|próxim\p{L}*|eventos?|horarios?|prochain\p{L}*|événements?|à venir|webinaires?|data|datas)(?![\p{L}])/iu,
  contact:
    /(?<![\p{L}])(?:contact\p{L}*|phone\p{L}*|telephone|e-?mail\p{L}*|address\p{L}*|kontakt\p{L}*|telefon\p{L}*|adresse|teléfono|correo|dirección|coordonnées|téléphone|courriel)(?![\p{L}])/iu,
  steps:
    /(?<![\p{L}])(?:steps?|instructions?|guidance|how to|tips|method\p{L}*|schritt\p{L}*|anleitung\p{L}*|hinweise|pasos|instrucciones|indicaciones|étapes|consignes|marche à suivre)(?![\p{L}])/iu,
};

// A sentence telling a date as past.
const PAST_TOLD =
  /(?<![\p{L}])(?:passed|was scheduled|were scheduled|took place|was held|were held|ended|already|last|stattgefunden|vorbei|pasado|celebró|passé|eu lieu)(?![\p{L}])/iu;

// Where to ask for a quote: a page, a form or a link.
const QUOTE_PLACE = /(?<![\p{L}])(?:page|form|button|link|seite|formular|página|formulario|formulaire)(?![\p{L}])|\]\(|https?:\/\//iu;

// Whether a reply's grounded content is of the kind the question asks for. To a question about
// what's coming up, a reply saying there's nothing upcoming never answers with the dates it calls
// past ("No upcoming live webinars are listed… scheduled for November 5, which has passed").
function answersKind(content: GroundedContent, question?: string, claim?: NegativeClaim, answer?: string): boolean {
  // A question with no price word ("a ballpark figure?") whose reply's claim is about the price.
  const kind = askedKind(question) ?? (claim && KIND_WORDS.price.test(claim.sentence) ? "price" : undefined);
  if (!kind) return content.kinds.size > 0;
  // A date only counts when it's told as coming: not in a claim, nor in a sentence calling it past
  // (round 6: "Our next listed event is … on 1 December 2026. The page doesn't state a date for the
  // next webinar." partly answers).
  if (kind === "date" && question && ASKS_UPCOMING.test(question) && claim && (claim.expiry || ASKS_UPCOMING.test(claim.sentence)))
    return sentencesOf(answer ?? "").some((s) => datesIn(s).length > 0 && !negativeClaim(s) && !PAST_TOLD.test(s));
  const rest = sentencesOf(answer ?? "")
    .filter((s) => s !== claim?.sentence)
    .join(" ");
  // Partial hours, honest about the rest: days and times are what "when" asks (recheck-R3), and what
  // "what are your support hours?" asks too.
  if ((kind === "date" || kind === "contact") && DAYS.test(rest) && /\d/.test(rest)) return true;
  if (kind === "contact") return content.kinds.has("contact") || content.kinds.has("link");
  // How the site prices, beside what it doesn't publish: a quote, or what the price depends on
  // ("no fixed prices… individual quotes are available", "We don't publish a ballpark price: it's a
  // fixed annual fee based on your volume"). "Contact us", or "our sales team can help with a quote",
  // only says who to ask.
  const says = (s: string) => !tellsToContact(s) && !pointsOnly(s) && !matchWords(s).some((w) => CONTACT_WORDS.has(w));
  if (kind === "price" && sentencesOf(rest).some((s) => says(s) && (BY_QUOTE.test(s) || KIND_WORDS.price.test(s)))) return true;
  return content.kinds.has(kind);
}

type CitedParagraphs = Record<string, { fields?: Record<string, { paragraphs?: Record<string, { text?: unknown }> }> }>;

// The passages of the pages a reply cites: every paragraph retrieved from a cited page, and those
// Agentic RAG added around them (augmented_context, when the caller has it). Not only the cited
// paragraphs: with neighbouring paragraphs in the context, the model cites a paragraph next to the
// one it read (Kemp's "What are your prices?", round 5: $4,500 and $5,300 sat on the uncited
// paragraph between two cited ones, and two cited paragraphs were only in the augmented context).
export function citedPassages(resources: Record<string, unknown>, citations: Record<string, unknown>, augmented?: unknown): string[] {
  const pages = new Set(Object.keys(citations).map((k) => k.split("/")[0] ?? k));
  if (!pages.size) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (id: string, text: unknown) => {
    if (typeof text === "string" && pages.has(id.split("/")[0] ?? id) && !seen.has(id)) {
      seen.add(id);
      out.push(text);
    }
  };
  for (const r of Object.values(resources as CitedParagraphs)) {
    for (const f of Object.values(r?.fields ?? {})) for (const [id, p] of Object.entries(f?.paragraphs ?? {})) add(id, p?.text);
  }
  const extra = (augmented as { paragraphs?: Record<string, { text?: unknown }> } | undefined)?.paragraphs ?? {};
  for (const [id, p] of Object.entries(extra)) add(id, p?.text);
  return out;
}

// Every passage retrieved, cited or not.
export function retrievedPassages(resources: Record<string, unknown>, augmented?: unknown): string[] {
  const texts = new Map<string, string>();
  for (const r of Object.values(resources as CitedParagraphs)) {
    for (const f of Object.values(r?.fields ?? {})) {
      for (const [id, p] of Object.entries(f?.paragraphs ?? {})) if (typeof p?.text === "string") texts.set(id, p.text);
    }
  }
  const extra = (augmented as { paragraphs?: Record<string, { text?: unknown }> } | undefined)?.paragraphs ?? {};
  for (const [id, p] of Object.entries(extra)) if (typeof p?.text === "string" && !texts.has(id)) texts.set(id, p.text);
  return [...texts.values()];
}

// The addresses of the pages a reply cites.
function citedUrls(resources: Record<string, unknown>, citations: Record<string, unknown>): string[] {
  const ids = new Set(Object.keys(citations).map((k) => k.split("/")[0] ?? k));
  return Object.entries(resources as Record<string, { origin?: { url?: unknown } | null }>).flatMap(([id, r]) =>
    ids.has(id) && typeof r?.origin?.url === "string" ? [r.origin.url] : [],
  );
}

// Whether a reply sends the visitor to the team: "please contact us", "Contact Support.",
// "get in touch", "call us", in the widget's seven languages. The widget shows the handoff under
// a Check this reply that does (and under every no answer).
const CONTACT = [
  /\b(?:contact|call|email|e-mail|phone|ring|message|write to) (?:us|our|the|a member|support|sales|customer|someone|your)\b/i,
  /\b(?:contact|reach|get in touch with|speak (?:to|with)|talk (?:to|with)) (?:us|our|the|support|sales)\b/i,
  /\bget in touch\b|\breach out\b|\bcontact support\b|\bcontact sales\b/i,
  /\b(?:kontaktieren|kontaktiere|wenden|melden) (?:Sie|du|dich)\b|\bkontakt(?:ieren)? (?:Sie |Sie bitte )?(?:uns|unser)|\bnehmen Sie (?:bitte )?(?:\p{L}+ )?Kontakt\b/iu,
  /(?<![\p{L}])(?:contáctenos|contáctanos|contacte con|contacta con|póngase en contacto|ponte en contacto|llámenos|escríbanos|comuníquese)(?![\p{L}])/iu,
  /\b(?:contactez|contacter|contactez-nous|appelez-nous|écrivez-nous)\b/iu,
  /\b(?:neem|neemt) (?:\p{L}+ )?contact op\b|\bbel ons\b|\bmail ons\b/iu,
  /(?<![\p{L}])(?:entre em contato|entre em contacto|contacte-nos|fale conosco|ligue para)(?![\p{L}])/iu,
  /\b(?:contattaci|contattateci|contatta|contattare|chiamaci|scrivici)\b/iu,
];
export const tellsToContact = (answer: string): boolean => {
  const text = plain(answer);
  return CONTACT.some((re) => re.test(text));
};

// The Check this signals for an answer that counts as answered, for validation and the picker
// (and the widget's handoff, with tellsToContact):
// - "short": under 8 words with nothing concrete ("Contact Support."), or a reply whose only content
//   is "contact us" (onlyContact). Correct short answers state a figure, a day or a price ("Teeth
//   whitening costs $350 per session.").
// - "off-source": no source shares a word with the question, its common words and the client's
//   name left out ("How do I contact support?" answered from "React Grid Overview"). Not judged
//   when there are no sources, nothing left of the question, or a source in another language
//   than the question's (the reply may rest on a translation).
export const SHORT_WORDS = 8;
export type AnswerCheck = "short" | "off-source";

export interface AnswerCheckFacts {
  question: string;
  answer: string;
  // What the visitor sees under the reply: each page's title and the passage cited from it
  // (else what was retrieved from it), with its language when known.
  sources: readonly { title: string; text?: string; language?: string }[];
  // The client's name visitors see: its words say nothing about the question ("How much does
  // Crayola's 24-pack cost?" matches every Crayola page).
  brand?: string;
}

const wordCount = (text: string) => text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;

// The words of "please contact us, our team can help you" in the widget's languages: a reply made
// of these, the question's own words and the client's name says nothing but "contact us".
const CONTACT_WORDS = new Set(
  matchWords(
    [
      "contact contacting contacted please discuss discussing reach touch call calling email phone message talk speak speaking help helping",
      "team sales sale support assist assistance happy glad member members connect connecting right person people someone explore learn",
      "find options together question questions need needs information info",
      "kontakt kontaktieren kontaktiere bitte vertrieb vertriebsteam hilfe helfen gerne besprechen erreichen",
      "contacto contacte contactar contactenos ventas soporte equipo ayuda ayudarle favor hablar",
      "contacter contactez commercial equipe aide aider plaisir",
      "neem opnemen verkoop hulp helpen graag",
      "entre contato contacte vendas suporte equipe ajuda ajudar",
      "contattaci contatta contattare vendite assistenza squadra aiuto aiutare",
    ].join(" "),
  ),
);

// A reply whose only content is "contact us": it tells the visitor to contact the team, gives
// nothing concrete, and every other word it uses is the question's own or the client's name
// ("To discuss becoming a Sitefinity partner, please contact us.", the demo, round 4).
function onlyContact(question: string, answer: string, brand?: string): boolean {
  if (!tellsToContact(answer) || hasConcreteDetail(answer)) return false;
  const known = [...matchWords(question), ...matchWords(brand ?? "")];
  return matchWords(answer).every((w) => CONTACT_WORDS.has(w) || known.some((k) => sameWord(k, w)));
}

export function answerChecks({ question, answer, sources, brand }: AnswerCheckFacts): AnswerCheck[] {
  const checks: AnswerCheck[] = [];
  if ((wordCount(answer) < SHORT_WORDS && !hasConcreteDetail(answer)) || onlyContact(question, answer, brand)) checks.push("short");
  const named = new Set(matchWords(brand ?? ""));
  const asked = matchWords(question).filter((w) => !named.has(w));
  const language = detectLanguage(question);
  const languages = sources.map((s) => languageOf(s.language) ?? detectLanguage(`${s.title}\n${s.text ?? ""}`));
  const across = language && languages.some((l) => l && l !== language);
  if (asked.length && sources.length && !across) {
    const fits = sources.some((s) => relatedWords(asked, matchWords(`${s.title}\n${s.text ?? ""}`)) > 0);
    if (!fits) checks.push("off-source");
  }
  return checks;
}

// While streaming: the start of Agentic RAG's no-context sentence, held back so it never
// flashes up before the widget replaces it.
export const mayBeNoContext = (partial: string): boolean => {
  const text = partial.trim();
  return text.length > 0 && NO_CONTEXT_ANSWER.startsWith(text);
};

// The best-scoring paragraph Agentic RAG retrieved, and how it was scored: the stream's
// retrieval item and the synchronous answer's retrieval_results have the same shape.
export function bestScore(resources: Record<string, unknown>): { score: number; type: string } | undefined {
  let best: { score: number; type: string } | undefined;
  for (const resource of Object.values(resources)) {
    const fields = ((resource as { fields?: unknown } | undefined)?.fields ?? {}) as Record<
      string,
      { paragraphs?: Record<string, { score?: unknown; score_type?: unknown }> }
    >;
    for (const field of Object.values(fields)) {
      for (const p of Object.values(field?.paragraphs ?? {})) {
        if (typeof p?.score === "number" && (!best || p.score > best.score)) best = { score: p.score, type: String(p.score_type ?? "") };
      }
    }
  }
  return best;
}

// The question log's numeric status codes, as the stream names them.
const LOG_STATUS: Record<string, string> = { "0": "success", "-1": "error", "-2": "no_context", "-3": "no_retrieval_data" };

export interface LogRowFacts {
  answer?: unknown;
  status?: unknown;
  resources_count?: unknown;
}

// A question-log row as reply facts, for when the widget's own verdict didn't arrive. The log
// carries the status and how many resources were retrieved, but no relevance score and no
// citations, so the reranker part of the rule can't apply: a polite non-answer the model wrote
// from weak matches counts as answered here, where the widget would have caught it. (Seen
// 2026-10-30: a no_context row has status -2 and an empty answer.)
export function logReplyFacts(row: LogRowFacts): ReplyFacts {
  const code = String(row.status ?? 0);
  const retrieved = Number(row.resources_count ?? 0);
  const status = retrieved > 0 || code !== "0" ? (LOG_STATUS[code] ?? "error") : "no_retrieval_data";
  return { answer: typeof row.answer === "string" ? row.answer : "", status };
}

// The question as the hash sees it: NFKC, lower case, runs of whitespace as one space, trimmed.
export const normalizeQuestion = (question: string): string => question.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();

// A short, stable fingerprint of a question, so the widget's verdict can be matched to the
// question log without sending the text again. Synchronous and plain JavaScript (cyrb53's
// mixing, both halves kept: 64 bits as 16 hex digits), because crypto.subtle needs a secure
// context that a client's page may not be.
export function questionHash(question: string): string {
  const text = normalizeQuestion(question);
  let h1 = 0xdeadbeef ^ text.length;
  let h2 = 0x41c6ce57 ^ text.length;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, "0") + (h1 >>> 0).toString(16).padStart(8, "0");
}

// ---- the language of a question or answer ----

// The commonest short words of each language the widget serves, in questions and in answers. A
// word several languages share counts for each of them in part, so "de" or "la" alone never decides.
const WORDS: Record<Language, string> = {
  en: "the and is are was does do did what which who how why when where can could would should will i you your my we our us it this that these those there have has be of to for with from about any much many or not on in at an a get still me yes if than then only they them their",
  es: "el la los las y es son está están yo usted ustedes nosotros su sus nuestro nuestra no con para por un una unos unas de del que qué cómo cuánto cuánta cuál cuáles dónde cuándo puedo puede pueden hay al lo se mi me cuesta tienen tiene también o sí a cuando donde muy pero nuestros nuestras",
  fr: "le la les et est sont je vous nous votre vos notre nos pas avec pour sur un une des du de que qui quoi comment combien quel quelle quels quelles où quand pourquoi ce cette ces peut pouvez puis ou au aux il elle y a coûte oui non",
  de: "der die das und ist sind war ich sie wir ihr ihre unser unsere nicht mit für auf ein eine einen einem kann können wie was welche welcher welches wer gibt es zu von im auch oder wo wann warum viel viele kostet kosten mein meine bei über dem den des noch schon werden wird haben hat ob man ja nein ihnen sich nur wenn dann aber sowie",
  nl: "de het een en is zijn ik u jij je wij we uw ons onze niet met voor op van dat die wat hoe hoeveel welke waar wanneer waarom kan kunnen kun er ook of naar bij mijn kost kosten heeft hebben ja nee",
  pt: "o a os as e é são está estão eu você vocês nós seu sua nosso nossa não com para por um uma uns umas de do da dos das que como quanto quanta qual quais onde quando posso pode podem há ao no na nos meu minha custa têm tem também sim",
  it: "il lo la i gli le e è sono io voi noi vostro vostra nostro nostra non con per un una uno di del della dei delle che come quanto quanta quale quali dove quando perché posso può possono ci al alla nel nella mio mia costa avete ha anche sì non a",
};
// Words no language owns, whichever lists they're on: short ones several languages use alike,
// and units. Figures and currency never count, as only letters make words. "per" on the
// Italian list made "Plans start at $29 per user per month." Italian (round 3).
const NEUTRAL = new Set("a in per pro no am pm vs via max min ok h hr hrs km kg cm mm".split(" "));
const WEIGHTS = new Map<string, Map<Language, number>>();
for (const [language, words] of Object.entries(WORDS) as [Language, string][]) {
  for (const word of words.split(" ")) if (!NEUTRAL.has(word)) WEIGHTS.set(word, (WEIGHTS.get(word) ?? new Map()).set(language, 1));
}
for (const shared of WEIGHTS.values()) for (const language of shared.keys()) shared.set(language, 1 / shared.size);

// Letters that point to one language (or two), counted once per text.
const LETTERS: [RegExp, Partial<Record<Language, number>>][] = [
  [/[äöüß]/, { de: 1.5 }],
  [/[ñ¿¡]/, { es: 1.5 }],
  [/[ãõ]/, { pt: 1.5 }],
  [/ç/, { fr: 0.75, pt: 0.75 }],
  [/[êâîôûëïœ]/, { fr: 1.5 }],
  [/[ìò]/, { it: 1.5 }],
];

// How strongly a text points to each language, best first: a word only one language uses
// counts 1 for it, a word two share counts ½ for each, and so on; a language's own letters add
// to it once.
function scores(text: string): [Language, number][] {
  const score = new Map<Language, number>();
  const add = (language: Language, n: number) => score.set(language, (score.get(language) ?? 0) + n);
  // Capitals are abbreviations, not words: "EST" is a time zone, not French.
  const words = (text.normalize("NFC").match(/\p{L}+/gu) ?? []).filter((w) => w.length < 2 || w !== w.toUpperCase());
  for (const word of words.map((w) => w.toLowerCase())) {
    for (const [language, weight] of WEIGHTS.get(word) ?? []) add(language, weight);
    // Dutch "ij" (wij, zijn, bij), which English and German words almost never have.
    if (word.includes("ij")) add("nl", 0.5);
  }
  const lower = text.normalize("NFC").toLowerCase();
  for (const [re, adds] of LETTERS) if (re.test(lower)) for (const [language, n] of Object.entries(adds)) add(language as Language, n);
  return [...score.entries()].sort((a, b) => b[1] - a[1]);
}

// The widget's language a text is written in, or undefined when it can't tell (too short, only
// names, or two languages too close to call). A word or two that only one language uses is
// enough: "Which plan includes NTA Plus?", "Was kostet WhatsUp Gold?", "¿Cuánto cuesta?".
export function detectLanguage(text: string): Language | undefined {
  const [best, second] = scores(text);
  if (!best || best[1] < 1) return undefined;
  return !second || best[1] >= second[1] * 1.5 ? best[0] : undefined;
}

// Validation judges an answer's language only from this much: about four words that point to
// it (see scores). Below that the language is unknown, and there's no language verdict. Short
// answers that state a price, hours or a date have far less ("Telerik DevCraft Complete costs
// $1,299 per developer, per year." has none).
export const MIN_DISTINCTIVE_WORDS = 4;

export interface AnswerLanguage {
  language: Language;
  // Twice as strong as any other: enough to fail an answer on. Otherwise a person checks it.
  confident: boolean;
  // Each language's score (see scores).
  scores: Partial<Record<Language, number>>;
}

// The language an answer is written in, as validation judges it, or undefined when it's unknown.
// Questions go by detectLanguage, which a word or two decides.
export function answerLanguage(text: string): AnswerLanguage | undefined {
  const ranked = scores(text);
  const [best, second] = ranked;
  if (!best || best[1] < MIN_DISTINCTIVE_WORDS) return undefined;
  return { language: best[0], confident: best[1] >= 2 * (second?.[1] ?? 0), scores: Object.fromEntries(ranked) };
}

// Asking in the visitor's language. A Knowledge Box with pages in several languages ranks a
// page in one language as high as its translation (seen on whatsupgold.com, 2026-10-30: English
// questions retrieved the German pages first). Agentic RAG records each resource's language when
// it processes it (metadata.language, the primary one), and /ask can filter on it per request:
// the saved search configuration can't, because the language changes with each visitor.
//
// The language to ask in: the question's own, else the page's, when the KB holds pages in more
// than one language and that is one of them. Undefined means ask across all pages.
export function retrievalLanguage(
  question: string,
  pageLanguage: Language | undefined,
  contentLanguages: readonly string[],
): Language | undefined {
  const held = new Set(contentLanguages.map(languageOf).filter((l): l is Language => Boolean(l)));
  if (held.size < 2) return undefined;
  const language = detectLanguage(question) ?? pageLanguage;
  return language && held.has(language) ? language : undefined;
}

// The /ask fields that keep retrieval to pages whose main language is `language` (verified
// 2026-10-30 with /find on whatsupgold.com: only English pages). Without only_primary, German
// pages with English product names match English too. When the filtered ask finds no answer,
// ask again without it: some things are only on the other language's pages.
export const languageFilter = (language: Language) => ({
  filter_expression: { field: { prop: "language", language, only_primary: true } },
});

// The field filter that keeps text the data augmentation agents generated (the console's
// synthetic questions and "what this page answers") out of retrieval and citation. The pilot
// (docs/ANSWER-QUALITY-PLAN.md, "Pilot result") measured answers getting worse when it was cited.
// Joined with "and" to any other field filter, in the saved configurations and in each ask's own
// filter (which replaces the saved one's), while a deployment has the agents on.
export const NOT_GENERATED = { not: { prop: "generated", by: "data-augmentation" } };

// `field` and-ed with NOT_GENERATED when `exclude`, else unchanged. Pure.
export function withoutGenerated(field: Record<string, unknown> | undefined, exclude: boolean): Record<string, unknown> | undefined {
  if (!exclude) return field;
  if (!field) return NOT_GENERATED;
  return { and: [...(Array.isArray(field.and) && Object.keys(field).length === 1 ? field.and : [field]), NOT_GENERATED] };
}

// A question offering alternatives ("Can I get a free trial or a demo?"), and a reply whose claim
// is about one while the rest gives the other: it partly answers (round 7).
function answersOther(claim: NegativeClaim, answer: string, question = ""): boolean {
  const parts = question.split(/\s(?:or|oder|ou|oppure)\s/iu);
  const claimed = matchWords(claim.sentence);
  const rest = matchWords(answer.replace(claim.sentence, ""));
  return (
    parts.length > 1 &&
    parts.some((p) => {
      const words = matchWords(p).filter((w) => !isFrame(w));
      return !words.some((w) => claimed.includes(w)) && words.some((w) => rest.includes(w));
    })
  );
}
