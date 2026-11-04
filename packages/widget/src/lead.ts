// The in-chat contact form's rules: which fields it shows, what makes an entry valid, and the
// body it posts to POST {console}/api/public/deployments/{id}/lead. The console delivers the
// lead and keeps only its count.

import { LEAD_FIELDS, type LeadField, type WidgetLead, type WidgetStrings } from "@launchpad/theme";
import type { Attribution } from "./attribution.ts";
import type { Turn } from "./store.ts";

export type LeadValues = Partial<Record<LeadField, string>>;
export type LeadErrorKey = keyof Pick<WidgetStrings, "fieldRequired" | "emailInvalid" | "phoneInvalid" | "consentRequired">;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Digits with the separators people type: +44 (20) 7946-0958.
const PHONE = /^\+?[\d\s().-]{6,25}$/;
const LIMITS: Record<LeadField, number> = { name: 120, email: 200, phone: 40, message: 2000 };

// The fields to show, in a fixed order; a form with none asks for an email and a message.
export function leadFields(lead: WidgetLead): { field: LeadField; required: boolean }[] {
  const chosen = LEAD_FIELDS.filter((f) => lead.fields?.includes(f));
  const fields = chosen.length ? chosen : (["email", "message"] as LeadField[]);
  return fields.map((field) => ({ field, required: Boolean(lead.requiredFields?.includes(field)) || !chosen.length }));
}

export function validateLead(lead: WidgetLead, values: LeadValues, consent: boolean): Partial<Record<LeadField | "consent", LeadErrorKey>> {
  const errors: Partial<Record<LeadField | "consent", LeadErrorKey>> = {};
  for (const { field, required } of leadFields(lead)) {
    const value = values[field]?.trim() ?? "";
    if (!value) {
      if (required) errors[field] = "fieldRequired";
    } else if (field === "email" && !EMAIL.test(value)) errors.email = "emailInvalid";
    else if (field === "phone" && !PHONE.test(value)) errors.phone = "phoneInvalid";
  }
  if (!consent) errors.consent = "consentRequired";
  return errors;
}

export interface LeadBody {
  conversation_id: string;
  fields: LeadValues;
  consent: true;
  // The consent wording the visitor ticked, as shown. The console keeps it only when it is one
  // of the deployment's own, and otherwise records the wording it would have shown.
  consent_text: string;
  // Only when the visitor ticked "Include this conversation".
  transcript?: Turn[];
  // The page without its query or fragment, which can carry personal details.
  page_url: string;
  language: string;
  // Where the form was opened: "header", "no-answer", "after-answer" or "cta", and the
  // call-to-action button's label when it was one.
  placement: string;
  cta_label?: string;
  // The visit's landing page, referrer and campaign tags (attribution.ts).
  attribution?: Attribution;
}

export function leadBody(
  lead: WidgetLead,
  values: LeadValues,
  options: {
    conversationId: string;
    transcript?: Turn[];
    pageUrl: string;
    language: string;
    consentText: string;
    placement: string;
    ctaLabel?: string;
    attribution?: Attribution;
  },
): LeadBody {
  const fields: LeadValues = {};
  for (const { field } of leadFields(lead)) {
    const value = values[field]?.trim();
    if (value) fields[field] = value.slice(0, LIMITS[field]);
  }
  const page = new URL(options.pageUrl);
  return {
    conversation_id: options.conversationId,
    fields,
    consent: true,
    consent_text: options.consentText,
    ...(options.transcript?.length && { transcript: options.transcript }),
    page_url: `${page.origin}${page.pathname}`,
    language: options.language,
    placement: options.placement,
    ...(options.ctaLabel && { cta_label: options.ctaLabel }),
    ...(options.attribution && { attribution: options.attribution }),
  };
}

export async function sendLead(baseUrl: string, deploymentId: string, body: LeadBody): Promise<void> {
  const res = await fetch(`${baseUrl}/api/public/deployments/${encodeURIComponent(deploymentId)}/lead`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.status !== 202 && !res.ok) throw new Error(`Lead request failed: ${res.status}`);
}
