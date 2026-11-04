// Words that carry meaning, for matching a question to a page or a source: shared by the
// console (validation's page finder, the answer checks) and the widget (which sources to show).

const STOPWORDS = new Set(
  [
    "the and for with from how does did can could should would are was were been its this that these those what which who whom when where why",
    "get got have has had about into off over than then there their them they any some not yes will just more most also you your our ours",
    "much many",
    "der die das und oder wie was ist ein eine einen für mit von zu im am auf bei kann ich sie wir mein ihr",
    "los las del con por para que una uno como cuanto cuánto donde puedo puede tiene",
    "les des une pour avec est comment combien dans sur que qui",
    "il lo gli della delle per con come quanto dove posso può che una",
    "het een van voor met hoe wat waar kan ik wij",
    "os as um uma para com como quanto onde posso pode que",
  ]
    .join(" ")
    .split(" ")
    .map((w) => w.normalize("NFKD").replace(/[̀-ͯ]/g, "")),
);

// A text's words, for matching: no accents, lower case, no short or common words, and plurals
// as singulars ("walls" → "wall").
export function matchWords(text: string): string[] {
  const words = text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w))
    .map((w) =>
      w.endsWith("ies") && w.length > 4 ? `${w.slice(0, -3)}y` : w.endsWith("s") && !w.endsWith("ss") && w.length > 3 ? w.slice(0, -1) : w,
    );
  return [...new Set(words)];
}

// How many of the first list's words the second holds: a word matches the same word, or a longer
// one it starts ("paint" and "painted").
export function matchScore(words: readonly string[], other: readonly string[]): number {
  const has = (w: string) => other.some((t) => t === w || (w.length >= 4 && t.length >= 4 && (t.startsWith(w) || w.startsWith(t))));
  return words.filter(has).length;
}

// Words for a price, in the widget's languages (as matchWords gives them): a question about cost
// is about a pricing, quote or licensing page whatever words each uses. The first list also
// counts any word it starts ("Preise", "kostet", "licensing").
const PRICE_STEMS = "pric preis kost cost precio prezz prij tarif licen lizenz quot purchas".split(" ");
const PRICE_WORDS = new Set(
  (
    "fee buy gebuhr angebot kaufen cuesta cuestan presupuesto cotizacion comprar coute cout devi acheter offerte kopen " +
    "preco custa custo orcamento compra preventivo acquista acquistare"
  ).split(" "),
);
export const isPriceWord = (w: string) => PRICE_WORDS.has(w) || PRICE_STEMS.some((s) => w.startsWith(s));

// Two words for the same thing: the same word, one form of the other ("price" and "pricing",
// "remove" and "removal": a shared start of 4 letters or more, all but 2 of the shorter word's),
// or both words for a price ("cost" and "pricing", "kostet" and "Preise").
export function sameWord(a: string, b: string): boolean {
  if (a === b) return true;
  if (isPriceWord(a) && isPriceWord(b)) return true;
  let common = 0;
  while (common < a.length && a[common] === b[common]) common++;
  return common >= 4 && common >= Math.min(a.length, b.length) - 2;
}

// How many of the first list's words the second holds, as sameWord sees them: for whether a
// source is about what was asked (answerChecks in verdict.ts), where matchScore is for ranking.
export const relatedWords = (words: readonly string[], other: readonly string[]): number =>
  words.filter((w) => other.some((t) => sameWord(w, t))).length;

// ---- the intent a visitor's question asks about (round 5) ----
//
// For routing a question to its intent's pages: the widget asks with the intent's saved search
// configuration (intentConfigName), which keeps to the pages labelled for it, and falls back to
// the default configuration when that finds no answer. Validation asks the same way. The words
// are the console's own for key pages (content-plan.ts QUESTION_WORDS), plus events, as matchWords
// gives them (no accents, lower case, plurals as singulars).
export const ROUTE_INTENTS = ["price", "buy", "trial", "events", "support", "contact"] as const;
export type RouteIntent = (typeof ROUTE_INTENTS)[number];

export const INTENT_WORDS: Record<RouteIntent, Record<string, string>> = {
  price: {
    en: "price pricing quote cost expensive fee license licensing licence subscription rate",
    de: "preis preise kosten kostet angebot",
    es: "precio precios cuesta cuestan presupuesto",
    fr: "prix tarif tarifs coute coutent devis",
    nl: "prijs prijzen kost offerte",
    pt: "preco precos custa custam orcamento",
    it: "prezzo prezzi costa costano preventivo",
  },
  buy: {
    en: "buy buying purchase purchasing shop reseller distributor retailer",
    de: "kaufen",
    es: "comprar compra",
    fr: "acheter",
    nl: "kopen",
    pt: "comprar",
    it: "acquistare acquista",
  },
  trial: {
    en: "trial try demo evaluation evaluate",
    de: "testversion demo",
    es: "prueba demostracion demo",
    fr: "essai demo",
    nl: "proefversie demo",
    pt: "teste demonstracao",
    it: "prova demo",
  },
  events: {
    en: "webinar event conference workshop meetup summit upcoming expo tradeshow",
    de: "webinar veranstaltung veranstaltungen konferenz workshop termin termine messe messen",
    es: "webinar seminario evento eventos conferencia taller proximo proxima feria",
    fr: "webinaire evenement evenements conference atelier prochain prochaine salon",
    nl: "webinar evenement evenementen congres beurs",
    pt: "webinar evento eventos conferencia proximo feira",
    it: "webinar evento eventi conferenza prossimo fiera",
  },
  support: {
    en: "support help helpdesk ticket troubleshoot troubleshooting",
    de: "support hilfe",
    es: "soporte ayuda",
    fr: "support assistance aide",
    nl: "ondersteuning hulp",
    pt: "suporte ajuda",
    it: "assistenza supporto aiuto",
  },
  contact: {
    en: "contact contacting sale sales talk call callback phone email reach speak touch",
    de: "kontakt kontaktieren vertrieb erreiche erreichen telefon telefonnummer ruckruf zuruckrufen",
    es: "contacto contactar ventas telefono llamada llamar",
    fr: "contacter ventes telephone numero rappel rappeler",
    nl: "contact verkoop telefoon telefoonnummer terugbellen",
    pt: "contato vendas telefone ligar",
    it: "contatto contattare vendite telefono richiamare chiamata",
  },
};

const INTENT_BY_WORD = new Map<string, RouteIntent[]>();
for (const intent of ROUTE_INTENTS) {
  for (const list of Object.values(INTENT_WORDS[intent])) {
    for (const word of matchWords(list)) INTENT_BY_WORD.set(word, [...new Set([...(INTENT_BY_WORD.get(word) ?? []), intent])]);
  }
}

// The intents a question asks about, by its words, in ROUTE_INTENTS order. "How much does it
// cost?" is a price question, "How do I contact support?" a support and a contact one.
export function questionIntents(question: string): RouteIntent[] {
  const found = new Set<RouteIntent>();
  // "How much is Chef?" names no price word (matchWords drops "much"); "How much RAM…" isn't one.
  if (/\bhow much (?:is|are|for|would|will)\b/i.test(question)) found.add("price");
  // "What plans do you offer?", "Compare your paid plans": plans are priced on the pricing page
  // (round 7: Buzzsprout's answered from a blog post's figure).
  if (/\b(?:(?:what|which)(?:\s+[\w-]+){0,3}?|paid|pricing|your)\s+(?:plans|tiers|packages|editions)\b/i.test(question)) found.add("price");
  for (const word of matchWords(question)) for (const intent of INTENT_BY_WORD.get(word) ?? []) found.add(intent);
  return ROUTE_INTENTS.filter((i) => found.has(i));
}

// The one intent a question is routed by: the first in ROUTE_INTENTS order (a support question
// that says "contact" goes to the support pages, a price question that says "buy" to the price ones).
export const routeIntent = (question: string): RouteIntent | undefined => questionIntents(question)[0];

// The saved search configuration for an intent, beside the deployment's default one.
export const intentConfigName = (base: string, intent: RouteIntent): string => `${base}-${intent}`;
