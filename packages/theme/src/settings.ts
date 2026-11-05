// Non-visual widget settings, and the public config document the widget loads at runtime.
// Shared by the console (which serves it), the database (which stores it) and the widget.

import type { Language, LanguageSetting, WidgetStrings } from "./i18n.ts";
import type { PriceTable } from "./price-claims.ts";
import type { ThemeTokens } from "./tokens.ts";

// embedded: an ask box in the page flow; each answer replaces the last.
// chat:     a full conversation panel in the page flow.
// popup:    an ask bar in the page that opens the conversation in a modal above the content.
// floating: a chat button in a corner of the viewport that opens a panel above it.
export const WIDGET_MODES = ["embedded", "chat", "popup", "floating"] as const;
export type WidgetMode = (typeof WIDGET_MODES)[number];

// Settings are stored as JSON, so anything else falls back to the floating button.
export const widgetMode = (value: unknown): WidgetMode =>
  (WIDGET_MODES as readonly unknown[]).includes(value) ? (value as WidgetMode) : "floating";

// Where the handoff to a person appears: after a reply with no answer, as a button in the
// chat header (under the intro when embedded), and under every answer.
export const HANDOFF_PLACES = ["no-answer", "header", "after-answer"] as const;
export type HandoffPlace = (typeof HANDOFF_PLACES)[number];
// Two prompts, not three: the line under every answer is opt-in.
export const DEFAULT_HANDOFF_PLACES: HandoffPlace[] = ["no-answer", "header"];

// A way to reach a person. Only links today (https, mailto: or tel:); kind leaves room for
// opening the site's live chat later. The in-chat contact form is `lead`, offered beside these.
export interface HandoffContact {
  kind: "link";
  // Unlabelled links get "Contact us", "Call us" or "Email us" in the widget's language.
  label?: string;
  url: string;
}

export interface WidgetHandoff {
  // Replaces the language's default intro ("Our team can help:").
  message?: string;
  contacts: HandoffContact[];
  // Missing in settings saved by hand: DEFAULT_HANDOFF_PLACES.
  show: HandoffPlace[];
}

// A button shown under a reply when the visitor's question or the answer mentions a keyword.
export interface WidgetCta {
  label: string;
  // Empty when the button opens the contact form.
  url: string;
  keywords: string[];
  // "word" (the default): whole words, plurals included, so "cost" never fires on "costume".
  // "contains": anywhere, even inside longer words.
  match?: "word" | "contains";
  // "lead" opens the in-chat contact form instead of a link.
  action?: "link" | "lead";
}

// Events go through the site's own Google Analytics (gtag or Tag Manager's dataLayer);
// the widget never loads it. measurementId routes them to one GA4 property (send_to).
export interface WidgetAnalytics {
  googleAnalytics: boolean;
  measurementId?: string;
}

// The in-chat contact form. It opens from "Talk to a person", from a reply with no answer
// and from call-to-action buttons whose action is "lead", and posts to the console, which
// delivers it (webhook or email, set on the deployment) and keeps only the count.
export const LEAD_FIELDS = ["name", "email", "phone", "message"] as const;
export type LeadField = (typeof LEAD_FIELDS)[number];

export interface WidgetLead {
  enabled: boolean;
  fields: LeadField[];
  requiredFields: LeadField[];
  // Replaces the language's default intro and consent wording.
  intro?: string;
  consentText?: string;
  // Offer a second box, "Include this conversation". On by default.
  transcript?: boolean;
}

// The widget's own text a partner can reword (welcome, placeholder, disclosure, the offline
// message and the handoff intro have fields of their own).
export const COPY_KEYS = ["noAnswer", "failed", "talkToPerson", "stillNeedHelp", "retry", "leadButton", "leadSent"] as const;
export type CopyKey = (typeof COPY_KEYS)[number] & keyof WidgetStrings;
export type CopyOverrides = Partial<Record<CopyKey, string>>;

// The partner's copy in one more language, for deployments serving several ("auto").
// Anything left out uses the widget's own text in that language, never the main copy, so
// visitors never see two languages at once. CTAs pair by position with settings.ctas; one
// without a label here is left out in this language. A button's link, and each handoff
// contact's (paired by position with handoff.contacts), can point at the language's own page
// (/de/trial rather than /trial); left out, they go where the main ones do.
export interface LocalizedCopy {
  nickname?: string;
  welcome?: string;
  starters?: string[];
  placeholder?: string;
  disclosure?: string;
  offlineMessage?: string;
  handoffMessage?: string;
  copy?: CopyOverrides;
  ctas?: { label?: string; keywords?: string[]; url?: string }[];
  handoffContacts?: { url?: string; label?: string }[];
  leadIntro?: string;
  leadConsent?: string;
}

export interface WidgetSettings {
  nickname?: string;
  // An https image (usually the site's logo or icon) shown in the chat header.
  avatar?: string;
  // The widget's own text (see i18n.ts); "auto" follows the page (resolveLanguage).
  language?: LanguageSetting;
  // With "auto": the languages the site serves, the first being the language the copy
  // below is written in. Visitors in other languages get the first.
  languages?: Language[];
  // The copy for each further language in `languages`.
  translations?: Partial<Record<Language, LocalizedCopy>>;
  // welcome, placeholder, disclosure and offlineMessage override the language's defaults.
  welcome?: string;
  starters?: string[];
  placeholder?: string;
  // AI disclosure line under the input.
  disclosure?: string;
  copy?: CopyOverrides;
  showSources?: boolean;
  feedback?: boolean;
  mode?: WidgetMode;
  poweredBy?: boolean;
  // Shown instead of the chat when the deployment or customer is paused or stopped for budget.
  offlineMessage?: string;
  handoff?: WidgetHandoff;
  ctas?: WidgetCta[];
  lead?: WidgetLead;
  analytics?: WidgetAnalytics;
  // The client's privacy notice, linked from the AI disclosure line and the contact form.
  privacyUrl?: string;
  // Page paths where the widget doesn't render: "/login", "/checkout/*", "*/account/*".
  exclude?: string[];
  // The floating chat button moves up while a fixed bar covers the bottom of the window (a
  // cookie bar, a bottom menu), and back down when it closes. On unless set to false.
  liftAboveBars?: boolean;
  // Partner CSS added to the widget's shadow root after its own styles; it can't reach the page.
  customCss?: string;
}

// GET {console}/api/public/deployments/{id}/config
export interface PublicWidgetConfig {
  deploymentId: string;
  zone: string;
  kbId: string;
  // The saved search configuration to ask with; empty for the KB's own defaults.
  searchConfig: string;
  theme: ThemeTokens;
  // Copy the partner left unset is filled in by the widget, which alone knows the visitor's
  // language when it is "auto".
  settings: Required<Pick<WidgetSettings, "language" | "showSources" | "feedback" | "mode" | "poweredBy">> &
    Omit<WidgetSettings, "language" | "showSources" | "feedback" | "mode" | "poweredBy" | "offlineMessage">;
  // false when paused or stopped for budget: render offlineMessage, request no tokens.
  online: boolean;
  offlineMessage?: string;
  // The widget's text in the languages this deployment can use, other than English, which is in
  // the bundle (configStrings). A language missing here falls back to English.
  strings?: Partial<Record<Language, WidgetStrings>>;
  // The languages of the pages the KB holds (the synced pages'). With more than one, the widget
  // asks in the question's language first (retrievalLanguage). Missing from older consoles.
  contentLanguages?: string[];
  // Per intent (price, buy, trial, events, support, contact), the saved search configuration that
  // answers it from the intent's pages (intentConfigName): the widget asks an intent question with
  // it, and of those pages, first, and with searchConfig when that finds no answer. Only intents
  // whose configuration is saved and that have pages; missing from older consoles.
  intentConfigs?: Record<string, string>;
  // Per intent, its key pages sent before page-type labels existed (resource ids), asked of with
  // the labelled ones until they're read again.
  intentPages?: Record<string, string[]>;
  // While the deployment has the data augmentation agents on: every ask's own filter also keeps
  // their generated text out (NOT_GENERATED), as the saved configurations do. Missing otherwise.
  excludeGenerated?: true;
  // The deployment's price table, only while a person's confirmation holds for its rows
  // (confirmedTable): a price-intent reply that contradicts it is replaced with its rows for the
  // plans asked about (checkPriceClaims). Missing when there is none confirmed.
  priceTable?: PriceTable;
  // With none confirmed: the pricing page's own plan-to-figure pairings (rows whose names may not
  // be plans left out). Never replaces a reply; a reply denying a price these rows have gets the
  // handoff card (round 7, item 4). Missing when there are none or a table is confirmed.
  pricingFacts?: PriceTable;
  // The paths of the pages stating events still to come: a date question citing one and answered
  // with no day and month gets the handoff card (the widget's datelessEvent). Only addresses.
  eventPages?: string[];
  // The synced pages' paths, key pages first, capped (compactPagePaths): the only pages a
  // model-written link may open (renderModelText). pagePathsCapped: some were left out, so any
  // page on the deployment's own sites may open. Missing from older consoles: then any page on
  // its sites may.
  pagePaths?: string[];
  pagePathsCapped?: true;
}

// POST {console}/api/public/deployments/{id}/token
export interface PublicTokenResponse {
  token: string;
  // Seconds until expiry. The widget times refreshes from this on its own clock, so a
  // visitor's skewed clock can't make every token look expired.
  expiresIn: number;
  expiresAt: string;
  askUrl: string;
}

export const defaultWidgetSettings: PublicWidgetConfig["settings"] = {
  language: "en",
  showSources: true,
  feedback: true,
  mode: "floating",
  poweredBy: false,
};

// The settings a visitor in `language` sees: the main copy in the deployment's first
// language (or when it serves one), else that language's translations. Pure, so the console
// can preview any language.
export function localizeSettings<S extends WidgetSettings>(
  settings: S,
  language: Language,
  offlineMessage?: string,
): S & { offlineMessage?: string } {
  const served = settings.languages ?? [];
  if (!served.length || language === served[0]) return { ...settings, offlineMessage: settings.offlineMessage ?? offlineMessage };
  const t = settings.translations?.[language] ?? {};
  const ctas = (settings.ctas ?? []).flatMap((cta, i) => {
    const local = t.ctas?.[i];
    const url = cta.action !== "lead" && local?.url?.trim();
    // The language's keywords, then the main ones: a visitor on the Spanish page may ask in English.
    const keywords = [...new Set([...(local?.keywords ?? []), ...cta.keywords])];
    return local?.label?.trim() ? [{ ...cta, label: local.label.trim(), keywords, ...(url && { url }) }] : [];
  });
  // A contact's label is copy too: the language's own, or the widget's default for its kind.
  const contacts = (settings.handoff?.contacts ?? []).map((contact, i) => {
    const local = t.handoffContacts?.[i];
    const { label: _, ...rest } = contact;
    return { ...rest, ...(local?.url?.trim() && { url: local.url.trim() }), ...(local?.label?.trim() && { label: local.label.trim() }) };
  });
  return {
    ...settings,
    nickname: t.nickname ?? settings.nickname,
    welcome: t.welcome,
    starters: t.starters,
    placeholder: t.placeholder,
    disclosure: t.disclosure,
    offlineMessage: t.offlineMessage,
    copy: t.copy,
    handoff: settings.handoff && { ...settings.handoff, message: t.handoffMessage, contacts },
    ctas,
    lead: settings.lead && { ...settings.lead, intro: t.leadIntro, consentText: t.leadConsent },
  };
}
