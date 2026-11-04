// Words for the stored codes, shared by the forms and the pages that show what was saved.

import type { BillingDetails } from "@launchpad/db";
import {
  type CopyKey,
  type Finish,
  type HandoffPlace,
  LANGUAGES,
  type LanguageSetting,
  type LeadField,
  languageName,
  type SitePlatform,
  type ThemeTokens,
  type WidgetMode,
} from "@launchpad/theme";
import type { KbAccess } from "./customer-form.ts";

export const LANGUAGE_OPTIONS = LANGUAGES.map((l) => ({ value: l.code, label: l.native === l.name ? l.name : `${l.name} (${l.native})` }));

export const languageLabel = (setting: LanguageSetting): string =>
  setting === "auto" ? "Each visitor's own language" : languageName(setting);

export const KB_ACCESS_LABELS: Record<KbAccess, string> = {
  member: "Member: can view the KB",
  contributor: "Contributor: can manage its content",
  owner: "Owner: full control",
};

export const BILLING_METHOD_LABELS: Record<NonNullable<BillingDetails["method"]>, string> = {
  invoice: "Invoice",
  card: "Card, kept in your billing system",
  bank_transfer: "Bank transfer or ACH",
  other: "Other",
};

export const PAYMENT_TERMS_LABELS: Record<NonNullable<BillingDetails["terms"]>, string> = {
  due_on_receipt: "Due on receipt",
  net_15: "Net 15",
  net_30: "Net 30",
  net_60: "Net 60",
};

export const MODE_LABELS: Record<WidgetMode, [string, string]> = {
  floating: ["Floating", "A chat button in a corner of every page, opening a panel above it."],
  popup: ["Popup", "An ask bar in the page that opens the conversation over the content."],
  chat: ["Chat", "The whole conversation as a panel in the page."],
  embedded: ["Embedded", "An ask box in the page, with each answer underneath it."],
};

export const FINISH_LABELS: Record<Finish, string> = {
  flat: "Flat",
  gloss: "Gloss",
  gradient: "Gradient",
};

export const POSITION_LABELS: Record<ThemeTokens["launcher"]["position"], string> = {
  "bottom-right": "Bottom right",
  "bottom-left": "Bottom left",
};

export const HANDOFF_PLACE_LABELS: Record<HandoffPlace, string> = {
  "no-answer": "When the chatbot can't answer, or something goes wrong",
  header: "As a “Talk to a person” button in the chat header",
  "after-answer": "As a “Still need help?” line under every answer",
};

export const LEAD_FIELD_LABELS: Record<LeadField, string> = {
  name: "Name",
  email: "Email",
  phone: "Phone",
  message: "Message",
};

// The widget's own text a partner can reword: the field's label, and when visitors see it.
export const COPY_LABELS: Record<CopyKey, [string, string]> = {
  noAnswer: ["No answer found", "When the chatbot has nothing on the site to answer with."],
  failed: ["Error", "When an answer couldn't load."],
  retry: ["Try again button", "Under an answer that couldn't load."],
  talkToPerson: ["Talk to a person button", "In the chat header."],
  stillNeedHelp: ["“Still need help?” line", "Under answers, when that's turned on."],
  leadButton: ["Contact form button", "Next to the contact links."],
  leadSent: ["Contact form sent", "After a visitor sends the form."],
};

export const CTA_MATCH_LABELS: Record<"word" | "contains", string> = {
  word: "Whole words, plurals included (“cost” matches “costs”, not “costume”)",
  contains: "Anywhere, even inside longer words",
};

export const PLATFORM_LABELS: Record<SitePlatform["platform"], string> = {
  sitefinity: "Sitefinity",
  wordpress: "WordPress",
  drupal: "Drupal",
  sitecore: "Sitecore",
  unknown: "Not recognised",
};

export const options = <K extends string>(labels: Record<K, string>, blank?: string) => [
  ...(blank === undefined ? [] : [{ value: "", label: blank }]),
  ...(Object.entries(labels) as [K, string][]).map(([value, label]) => ({ value, label })),
];
