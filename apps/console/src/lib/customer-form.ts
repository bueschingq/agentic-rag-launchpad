// Validation for the customer form (new and edit). Pure, so it runs under node:test.
//
// Contacts arrive as indexed fields (contacts.<n>.email, …) from rows the partner can add and
// remove, so the indexes may have gaps. `primary` names the primary contact's index.

import { BILLING_METHODS, type BillingDetails, PAYMENT_TERMS } from "@launchpad/db";
import { isLanguage, type Language } from "@launchpad/theme";

export const KB_ACCESS = ["member", "contributor", "owner"] as const;
export type KbAccess = (typeof KB_ACCESS)[number];

export interface ContactInput {
  name: string;
  email: string;
  phone?: string;
  title?: string;
  language: Language;
  kbRole: KbAccess | null;
  isPrimary: boolean;
}

export interface CustomerInput {
  name: string;
  // The name visitors see: required, and stored even when it's the customer name, so nothing
  // ever falls back to the internal name.
  displayName: string;
  language: Language;
  monthlyBudgetCents: number | null;
  // At 100% of the budget: "alert" only, or "stop" (the chat goes offline until next month).
  budgetMode: "alert" | "stop";
  contacts: ContactInput[];
  billing: BillingDetails;
}

// Field name → message, for the form to show beside each field.
export type FormErrors = Record<string, string>;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CARD_MESSAGE = "That looks like a card number. Keep card details in your billing system, not here.";

// 13–19 digits (spaces or dashes allowed) starting like a card number and passing the Luhn check.
export function looksLikeCardNumber(text: string): boolean {
  for (const match of text.matchAll(/[3-6](?:[ -]?\d){12,18}/g)) {
    const digits = match[0].replace(/\D/g, "");
    let sum = 0;
    for (let i = 0; i < digits.length; i++) {
      let d = Number(digits[digits.length - 1 - i]);
      if (i % 2 === 1) d = d * 2 > 9 ? d * 2 - 9 : d * 2;
      sum += d;
    }
    if (sum % 10 === 0) return true;
  }
  return false;
}

export function parseCustomerForm(form: FormData): { value: CustomerInput } | { errors: FormErrors } {
  const errors: FormErrors = {};
  const text = (name: string) => {
    const value = form.get(name);
    return typeof value === "string" ? value.trim() : "";
  };
  // Optional free text: undefined when empty, an error when too long or card-like.
  const optional = (name: string, max: number, label: string): string | undefined => {
    const value = text(name);
    if (!value) return undefined;
    if (value.length > max) errors[name] = `Keep the ${label} under ${max} characters.`;
    else if (looksLikeCardNumber(value)) errors[name] = CARD_MESSAGE;
    return value;
  };

  const name = text("name");
  if (!name) errors.name = "Enter the customer's name.";
  else if (name.length > 120) errors.name = "Keep the name under 120 characters.";
  const displayName = optional("displayName", 120, "name visitors see") ?? "";
  if (!displayName) errors.displayName = "Enter the name visitors see: how the chat refers to the client. It can be the customer name.";

  const language = text("language") || "en";
  if (!isLanguage(language)) errors.language = "Pick a language from the list.";

  let monthlyBudgetCents: number | null = null;
  if (text("budget")) {
    const budget = Number(text("budget"));
    if (!(Number.isFinite(budget) && budget >= 0 && budget <= 10_000_000)) errors.budget = "The budget must be a number, 0 or more.";
    else monthlyBudgetCents = Math.round(budget * 100);
  }
  const budgetMode = text("budgetMode") === "stop" ? "stop" : "alert";

  const indexes = [...new Set([...form.keys()].flatMap((k) => /^contacts\.(\d+)\./.exec(k)?.[1] ?? []))].sort(
    (a, b) => Number(a) - Number(b),
  );
  const contacts: ContactInput[] = [];
  const seen = new Set<string>();
  const primary = text("primary");
  for (const i of indexes) {
    const f = (field: string) => `contacts.${i}.${field}`;
    const row = { name: text(f("name")), email: text(f("email")).toLowerCase() };
    const phone = optional(f("phone"), 40, "phone number");
    const title = optional(f("title"), 120, "job title");
    // A row left completely blank is ignored rather than rejected.
    if (!row.name && !row.email && !phone && !title) continue;
    if (!row.name) errors[f("name")] = "Enter the contact's name.";
    else if (row.name.length > 120) errors[f("name")] = "Keep the name under 120 characters.";
    if (!EMAIL.test(row.email)) errors[f("email")] = "Enter a valid email address.";
    else if (seen.has(row.email)) errors[f("email")] = "This email is already on another contact.";
    seen.add(row.email);
    const contactLanguage = text(f("language")) || (isLanguage(language) ? language : "en");
    if (!isLanguage(contactLanguage)) errors[f("language")] = "Pick a language from the list.";
    const role = text(f("kbRole"));
    if (role && !(KB_ACCESS as readonly string[]).includes(role)) errors[f("kbRole")] = "Pick an access level from the list.";
    contacts.push({
      ...row,
      phone,
      title,
      language: isLanguage(contactLanguage) ? contactLanguage : "en",
      kbRole: role ? (role as KbAccess) : null,
      isPrimary: primary === i,
    });
  }
  if (contacts.length === 0) errors.contacts = "Add at least one contact.";
  // Without a choice, the first contact is the primary one.
  else if (!contacts.some((c) => c.isPrimary)) contacts[0]!.isPrimary = true;

  const billing: BillingDetails = {};
  const main = contacts.find((c) => c.isPrimary);
  if (form.get("billing.sameAsPrimary") && main) {
    billing.contactName = main.name;
    billing.contactEmail = main.email;
  } else {
    billing.contactName = optional("billing.contactName", 120, "billing contact's name");
    const email = text("billing.contactEmail").toLowerCase();
    if (email && !EMAIL.test(email)) errors["billing.contactEmail"] = "Enter a valid email address.";
    billing.contactEmail = email || undefined;
  }
  const address = {
    line1: optional("billing.line1", 200, "address"),
    line2: optional("billing.line2", 200, "address"),
    city: optional("billing.city", 120, "city"),
    region: optional("billing.region", 120, "state or region"),
    postalCode: optional("billing.postalCode", 20, "postal code"),
    country: optional("billing.country", 80, "country"),
  };
  if (Object.values(address).some(Boolean)) billing.address = address;
  const method = text("billing.method");
  if (method && !(BILLING_METHODS as readonly string[]).includes(method)) errors["billing.method"] = "Pick a payment method from the list.";
  else if (method) billing.method = method as BillingDetails["method"];
  const terms = text("billing.terms");
  if (terms && !(PAYMENT_TERMS as readonly string[]).includes(terms)) errors["billing.terms"] = "Pick payment terms from the list.";
  else if (terms) billing.terms = terms as BillingDetails["terms"];
  billing.poNumber = optional("billing.poNumber", 60, "PO number");
  billing.taxId = optional("billing.taxId", 60, "tax ID");
  billing.externalRef = optional("billing.externalRef", 120, "billing system reference");

  if (Object.keys(errors).length) return { errors };
  // Drop unset keys so the stored JSON only holds what was entered.
  const compact = JSON.parse(JSON.stringify(billing)) as BillingDetails;
  return {
    value: {
      name,
      displayName,
      language: language as Language,
      monthlyBudgetCents,
      budgetMode,
      contacts,
      billing: compact,
    },
  };
}
