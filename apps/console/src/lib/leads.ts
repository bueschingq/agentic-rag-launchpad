// Leads from the chat's contact form. Checked against the deployment's lead settings, then
// delivered at once to the client's webhook and/or email; a lead is kept only while delivery
// fails (the worker retries for 7 days), then deleted.
//
// The payload is schemaVersion 2 (docs/lead-payload.schema.json, mapping examples in
// docs/leads.md): the version 1 fields unchanged, plus the consent the visitor gave, what opened
// the form, and where the visit came from.

import { deployments, leads, tenants } from "@launchpad/db";
import { deliver, type Message } from "@launchpad/notify";
import {
  type Language,
  type LanguageSetting,
  languageName,
  localizeSettings,
  resolveLanguage,
  type WidgetSettings,
  widgetStrings,
} from "@launchpad/theme";
import { eq } from "drizzle-orm";
import { db } from "./db.ts";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const FIELDS = ["name", "email", "phone", "message"] as const;
const LIMITS = { name: 120, email: 200, phone: 40, message: 2000 } as const;
const PLACEMENTS = ["header", "no-answer", "after-answer", "cta"] as const;
const ATTRIBUTION_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "gclid"] as const;

export interface LeadConsent {
  given: true;
  // The wording the visitor ticked, in their language.
  text: string;
  language: Language;
  privacyUrl?: string;
  at: string;
}

export interface LeadTrigger {
  // Where the form was opened: the header's "Talk to a person", a reply with no answer, the
  // line under an answer, or a call-to-action button.
  placement: (typeof PLACEMENTS)[number];
  ctaLabel?: string;
}

export type LeadAttribution = { landingPage?: string; referrer?: string } & Partial<Record<(typeof ATTRIBUTION_KEYS)[number], string>>;

export interface Lead {
  conversationId: string;
  fields: Partial<Record<(typeof FIELDS)[number], string>>;
  pageUrl?: string;
  language?: string;
  // Only when the visitor ticked "include this conversation".
  transcript?: { author: "USER" | "NUCLIA"; text: string }[];
  consent: LeadConsent;
  trigger: LeadTrigger;
  attribution: LeadAttribution;
}

// What the console knows about the deployment, to check the lead against.
export interface LeadContext {
  settings: WidgetSettings;
  // The deployment's language: fixed, or "auto" for each visitor's.
  language: LanguageSetting;
  now?: Date;
}

// The consent wording a visitor in this language was shown: the partner's for the language,
// else the widget's own.
export function consentText(settings: WidgetSettings, language: Language): string {
  return localizeSettings(settings, language).lead?.consentText?.trim() || widgetStrings(language).consent;
}

// Every label a call-to-action button has, in any of the deployment's languages.
function ctaLabels(settings: WidgetSettings): Set<string> {
  const labels = new Set((settings.ctas ?? []).map((c) => c.label.trim()));
  for (const t of Object.values(settings.translations ?? {}))
    for (const c of t?.ctas ?? []) if (c.label?.trim()) labels.add(c.label.trim());
  return labels;
}

// http(s), without the query or fragment: those can carry personal details.
const bare = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  try {
    const u = new URL(value);
    return u.protocol === "https:" || u.protocol === "http:" ? `${u.origin}${u.pathname}`.slice(0, 1000) : undefined;
  } catch {
    return undefined;
  }
};

function parseAttribution(raw: unknown): LeadAttribution {
  if (!raw || typeof raw !== "object") return {};
  const r = raw as Record<string, unknown>;
  const out: LeadAttribution = {};
  const landingPage = bare(r.landingPage);
  const referrer = bare(r.referrer);
  if (landingPage) out.landingPage = landingPage;
  if (referrer) out.referrer = referrer;
  for (const key of ATTRIBUTION_KEYS) {
    const value = typeof r[key] === "string" ? (r[key] as string).trim().slice(0, 200) : "";
    // An email address in a campaign tag would be personal data, whatever the key.
    if (value && !value.includes("@")) out[key] = value;
  }
  return out;
}

export function parseLead(body: unknown, ctx: LeadContext): { value: Lead } | { error: string } {
  const lead = ctx.settings.lead as { enabled?: boolean; fields?: string[]; requiredFields?: string[] } | undefined;
  if (!lead?.enabled) return { error: "This chat doesn't take contact details." };
  if (!body || typeof body !== "object") return { error: "Send the form as JSON." };
  const b = body as Record<string, unknown>;
  if (b.consent !== true) return { error: "Consent is required." };
  const raw = (b.fields && typeof b.fields === "object" ? b.fields : {}) as Record<string, unknown>;
  const fields: Lead["fields"] = {};
  const allowed = new Set(lead.fields ?? ["name", "email", "message"]);
  for (const key of FIELDS) {
    const value = typeof raw[key] === "string" ? (raw[key] as string).trim() : "";
    if (!value) continue;
    if (!allowed.has(key)) continue;
    if (value.length > LIMITS[key]) return { error: `The ${key} is too long.` };
    fields[key] = value;
  }
  for (const key of lead.requiredFields ?? ["email"]) {
    if (!fields[key as keyof Lead["fields"]]) return { error: `The ${key} is required.` };
  }
  if (fields.email && !EMAIL.test(fields.email)) return { error: "Enter a valid email address." };
  if (!fields.email && !fields.phone) return { error: "Leave an email address or a phone number." };

  const transcript = Array.isArray(b.transcript)
    ? b.transcript
        .slice(-20)
        .flatMap((t: { author?: unknown; text?: unknown }) =>
          (t?.author === "USER" || t?.author === "NUCLIA") && typeof t.text === "string"
            ? [{ author: t.author as "USER" | "NUCLIA", text: t.text.slice(0, 4000) }]
            : [],
        )
    : undefined;
  const pageUrl = typeof b.page_url === "string" && /^https?:\/\//.test(b.page_url) ? b.page_url.slice(0, 1000) : undefined;

  // The language the visitor was served in, as the widget would have chosen it.
  const reported = typeof b.language === "string" ? b.language.slice(0, 10) : undefined;
  const language = resolveLanguage(ctx.language, reported ? [reported] : [], ctx.settings.languages ?? []);
  // The wording they ticked: as the widget reports it when it is the deployment's own (in any
  // language, as it may have changed language mid-visit), else what this language shows now.
  const shown = typeof b.consent_text === "string" ? b.consent_text.trim() : "";
  const known = [...new Set([language, ...(ctx.settings.languages ?? [])])].map((l) => consentText(ctx.settings, l));
  const consent: LeadConsent = {
    given: true,
    text: known.includes(shown) ? shown : consentText(ctx.settings, language),
    language,
    ...(ctx.settings.privacyUrl && { privacyUrl: ctx.settings.privacyUrl }),
    at: (ctx.now ?? new Date()).toISOString(),
  };

  const placement = PLACEMENTS.find((p) => p === b.placement) ?? "header";
  const label = typeof b.cta_label === "string" ? b.cta_label.trim() : "";
  // Only a label the deployment's buttons actually have: nothing else from the page is passed on.
  const trigger: LeadTrigger = { placement, ...(placement === "cta" && ctaLabels(ctx.settings).has(label) && { ctaLabel: label }) };

  return {
    value: {
      conversationId: typeof b.conversation_id === "string" ? b.conversation_id.slice(0, 64) : "",
      fields,
      ...(pageUrl && { pageUrl }),
      ...(reported && { language: reported }),
      ...(transcript?.length && { transcript }),
      consent,
      trigger,
      attribution: parseAttribution(b.attribution),
    },
  };
}

// Who the lead email names: the name visitors see, else the site's address; never the
// partner's internal name for the customer.
export function leadName(displayName: string | null | undefined, siteUrl: string): string {
  if (displayName?.trim()) return displayName.trim();
  try {
    return new URL(siteUrl).host;
  } catch {
    return siteUrl;
  }
}

export const leadSubject = (name: string) => `New lead from the ${name} website chat`;

// The email and the webhook's text: the visitor's details, the consent they gave in its exact
// wording, and where they came from. `name` is the name visitors see, never the internal one.
// A lead from a staging page is a test: the subject says so, so nobody calls a test visitor.
export function leadMessage(lead: Lead, deployment: string, name: string, opts: { test?: boolean } = {}): Message {
  const fields: Record<string, string> = {};
  if (lead.fields.name) fields.Name = lead.fields.name;
  if (lead.fields.email) fields.Email = lead.fields.email;
  if (lead.fields.phone) fields.Phone = lead.fields.phone;
  if (lead.fields.message) fields.Message = lead.fields.message;
  if (lead.pageUrl) fields.Page = lead.pageUrl;
  if (lead.language) fields.Language = lead.language;
  fields.Consent = `“${lead.consent.text}” (ticked ${lead.consent.at.slice(0, 16).replace("T", " ")} UTC, ${languageName(lead.consent.language)})`;
  if (lead.consent.privacyUrl) fields["Privacy notice"] = lead.consent.privacyUrl;
  fields["Opened from"] = lead.trigger.ctaLabel ? `the “${lead.trigger.ctaLabel}” button` : PLACEMENT_WORDS[lead.trigger.placement];
  const a = lead.attribution;
  const campaign = ATTRIBUTION_KEYS.filter((k) => a[k]).map((k) => `${k}=${a[k]}`);
  if (a.landingPage) fields["Landing page"] = a.landingPage;
  if (a.referrer) fields.Referrer = a.referrer;
  if (campaign.length) fields.Campaign = campaign.join(", ");
  const transcript = lead.transcript?.map((t) => `${t.author === "USER" ? "Visitor" : "Chatbot"}: ${t.text}`).join("\n");
  return {
    subject: `${opts.test ? "[Test, from a staging page] " : ""}${leadSubject(name)}`,
    text: `${opts.test ? "A test: sent from a staging page. " : ""}Someone left their details in the chat on ${deployment}.${transcript ? `\n\nConversation:\n${transcript}` : ""}`,
    fields,
  };
}

const PLACEMENT_WORDS: Record<LeadTrigger["placement"], string> = {
  header: "“Talk to a person” in the chat header",
  "no-answer": "a reply with no answer",
  "after-answer": "“Still need help?” under an answer",
  cta: "a call-to-action button",
};

// The webhook's JSON: version 1's fields as they were, and version 2's consent, trigger and
// attribution. `customer` is the name visitors see.
export function leadPayload(lead: Lead, deployment: string, customer: string, receivedAt: Date, opts: { test?: boolean } = {}) {
  return {
    schemaVersion: 2 as const,
    kind: "lead" as const,
    receivedAt: receivedAt.toISOString(),
    deployment,
    customer,
    ...(opts.test && { test: true as const }),
    ...lead,
  };
}

// Delivers now; on failure, keeps it for the worker to retry.
export async function acceptLead(deploymentId: string, lead: Lead, opts: { test?: boolean } = {}): Promise<void> {
  const [row] = await db()
    .select({ name: deployments.name, delivery: deployments.leadDelivery, siteUrl: deployments.siteUrl, displayName: tenants.displayName })
    .from(deployments)
    .innerJoin(tenants, eq(tenants.id, deployments.tenantId))
    .where(eq(deployments.id, deploymentId));
  if (!row) return;
  const visible = leadName(row.displayName, row.siteUrl);
  const payload = leadPayload(lead, row.name, visible, new Date(), opts);
  const result = await deliver(row.delivery, leadMessage(lead, row.name, visible, opts), { extra: payload });
  if (!result.delivered.length) {
    await db()
      .insert(leads)
      .values({ deploymentId, payload, attempts: 1, lastError: result.errors.join(" · ") || "No delivery set up for leads." });
  }
}
