// Which saved search configuration and which pages a question is asked of first. An intent
// question (price, buy, trial or demo, events, support, contact, by its words in the widget's
// languages: questionIntents in @launchpad/theme) goes to its intent's configuration, which
// carries a short prompt for it, and to the pages the worker labelled for it (labelset
// launchpad_page); the default configuration answers anything that finds nothing there, as the
// widget's second ask. Measured 2026-10-31 on chef.io: "What does Chef Business cost?" got no
// answer from the default configuration and "$59 per node, per year" from the pricing pages
// (docs/ANSWER-QUALITY-PLAN.md).
//
// The page filter goes with each ask rather than living in the saved configuration alone: a
// request's own fields replace the configuration's, and on a KB with pages in several languages
// the widget's language filter is one of them (it would drop the configuration's label filter).
// So the ask carries both, joined: a German price question reads /de/pricing, not /pricing. Key
// pages sent before labels existed are named by resource id until they're read again
// (PublicWidgetConfig.intentPages), as the console's labelFilter does.

import { askedKind, asksWhen, datesIn, type Language, languageFilter, NOT_GENERATED, type PublicWidgetConfig } from "@launchpad/theme";

// The worker's page-type labels (the console's content-plan.ts PAGE_LABELSET).
export const PAGE_LABELSET = "launchpad_page";

// The labels whose pages answer each intent (content-plan.ts labelsFor): a price question can be
// answered from a buying page (telerik.com's /purchase.aspx is its price list), a contact question
// from a support one.
const ANSWERED_BY: Record<string, readonly string[]> = {
  price: ["price", "buy"],
  buy: ["buy", "price"],
  contact: ["contact", "support"],
  support: ["support", "contact"],
};

// Asking for a way to reach the client, in the widget's languages: a phone number, an email or a
// postal address is a market's own, like a price.
const REACH =
  /(?<![\p{L}])(?:phone|telephone|telefon\p{L}*|t[ée]l[ée]phone|num[ée]ro|n[uú]mero|nummer|e-?mail|adres\p{L}*|address|dirección|direcci[oó]n|indirizzo|morada|whatsapp)(?![\p{L}])/iu;

// Whether a question's answer belongs to the visitor's market, so it's never taken from another
// language's pages: an intent question (a price, a trial, support, contact) or one asking how to
// reach the client. An events question isn't: a site with no Spanish events page still has its events
// (round 7: "¿Hay algún webinar próximo?" found nothing where English named the webinar).
export const staysInLanguage = (question: string, intents: readonly string[]): boolean =>
  intents.some((i) => i !== "events") || REACH.test(question);

// The first of the question's intents that has a configuration of its own, if any.
export function routedIntent(
  question: string,
  configs: PublicWidgetConfig["intentConfigs"],
  intentsOf: (question: string) => readonly string[],
): string | undefined {
  if (!configs || !Object.keys(configs).length) return undefined;
  return intentsOf(question).find((intent) => configs[intent]) ?? (configs.events && asksWhen(question) ? "events" : undefined);
}

// A date question whose reply cites a page stating events still to come, yet gives no day and month
// (round 7: "im November 2026 … Ein genaues Datum nennt die Seite nicht", where the page says 5
// November): no answer, with the handoff card. By what the reply states, so no phrases and any language.
export const datelessEvent = (question: string, answer: string, cited: readonly { href: string }[], pages?: readonly string[]): boolean =>
  Boolean(pages?.length) &&
  askedKind(question) === "date" &&
  !datesIn(answer).length &&
  cited.some((s) => pages!.some((p) => s.href.includes(p)));

type FieldFilter = Record<string, unknown>;

// An intent's pages: its labels, and key pages not labelled yet, by resource id.
export function intentPages(intent: string, resources: readonly string[] = []): FieldFilter {
  const terms: FieldFilter[] = [
    ...(ANSWERED_BY[intent] ?? [intent]).map((label) => ({ prop: "label", labelset: PAGE_LABELSET, label })),
    ...resources.map((id) => ({ prop: "resource", id })),
  ];
  return terms.length === 1 ? terms[0]! : { or: terms };
}

// The /ask fields that keep an ask to one language's pages, to an intent's pages, or both; and,
// with `excludeGenerated` (PublicWidgetConfig.excludeGenerated), away from the text the data
// augmentation agents generated, which this filter would otherwise let back in.
export function pagesFilter(
  language: Language | undefined,
  intent: string | undefined,
  resources?: readonly string[],
  excludeGenerated?: boolean,
): { filter_expression?: { field: FieldFilter } } {
  const parts: FieldFilter[] = [];
  if (language) parts.push(languageFilter(language).filter_expression.field);
  if (intent) parts.push(intentPages(intent, resources));
  if (excludeGenerated) parts.push(NOT_GENERATED);
  if (!parts.length) return {};
  return { filter_expression: { field: parts.length === 1 ? parts[0]! : { and: parts } } };
}
