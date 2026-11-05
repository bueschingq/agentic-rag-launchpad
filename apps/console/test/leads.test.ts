import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import type { WidgetSettings } from "@launchpad/theme";
import { consentText, type LeadContext, leadMessage, leadPayload, parseLead } from "../src/lib/leads.ts";

// The schema partners map their CRM to, as published.
const schema = JSON.parse(readFileSync(new URL("../../../docs/lead-payload.schema.json", import.meta.url), "utf8"));

// Just enough JSON Schema for the published file: type, const, enum, required, properties,
// additionalProperties, items, maxItems, maxLength and the two formats it uses.
type Schema = Record<string, unknown>;
function problems(value: unknown, s: Schema, path = "$"): string[] {
  const out: string[] = [];
  if ("const" in s && value !== s.const) out.push(`${path}: not ${JSON.stringify(s.const)}`);
  if (Array.isArray(s.enum) && !s.enum.includes(value)) out.push(`${path}: not one of ${s.enum.join(", ")}`);
  const type = s.type as string | undefined;
  if (type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [`${path}: not an object`];
    const v = value as Record<string, unknown>;
    for (const key of (s.required as string[] | undefined) ?? []) if (!(key in v)) out.push(`${path}.${key}: missing`);
    const props = (s.properties as Record<string, Schema> | undefined) ?? {};
    for (const [key, child] of Object.entries(v)) {
      if (props[key]) out.push(...problems(child, props[key], `${path}.${key}`));
      else if (s.additionalProperties === false) out.push(`${path}.${key}: not in the schema`);
    }
  } else if (type === "array") {
    if (!Array.isArray(value)) return [`${path}: not an array`];
    if (typeof s.maxItems === "number" && value.length > s.maxItems) out.push(`${path}: too many items`);
    for (const [i, item] of value.entries()) out.push(...problems(item, s.items as Schema, `${path}[${i}]`));
  } else if (type === "string") {
    if (typeof value !== "string") return [`${path}: not a string`];
    if (typeof s.maxLength === "number" && value.length > s.maxLength) out.push(`${path}: too long`);
    if (s.format === "date-time" && Number.isNaN(Date.parse(value))) out.push(`${path}: not a date-time`);
    if (s.format === "uri" && !/^https?:\/\/[^\s]+$/.test(value)) out.push(`${path}: not a URI`);
  }
  return out;
}

const settings: WidgetSettings = {
  languages: ["en", "de"],
  privacyUrl: "https://www.whatsupgold.com/privacy",
  lead: {
    enabled: true,
    fields: ["name", "email", "message"],
    requiredFields: ["email"],
    consentText: "I agree that WhatsUp Gold may contact me.",
  },
  ctas: [{ label: "Get a quote", url: "", keywords: ["quote"], action: "lead" }],
  translations: { de: { ctas: [{ label: "Angebot anfordern", keywords: ["angebot"] }] } },
};
const ctx: LeadContext = { settings, language: "auto", now: new Date("2026-10-30T14:02:00Z") };
const body = (over: Record<string, unknown> = {}) => ({
  conversation_id: "c1",
  fields: { email: "ana@client.example", message: "Please send a quote." },
  consent: true,
  consent_text: "I agree that WhatsUp Gold may contact me.",
  page_url: "https://www.whatsupgold.com/pricing",
  language: "en",
  placement: "cta",
  cta_label: "Get a quote",
  attribution: { landingPage: "https://www.whatsupgold.com/", utm_source: "linkedin", utm_campaign: "q4" },
  ...over,
});
const lead = (over: Record<string, unknown> = {}, c = ctx) => {
  const parsed = parseLead(body(over), c);
  assert.ok("value" in parsed, JSON.stringify(parsed));
  return parsed.value;
};

describe("leads, schema version 2", () => {
  it("carries the campaign, the button's label and the exact consent wording (MK's check)", () => {
    const value = lead();
    assert.equal(value.attribution.utm_source, "linkedin");
    assert.deepEqual(value.trigger, { placement: "cta", ctaLabel: "Get a quote" });
    assert.deepEqual(value.consent, {
      given: true,
      text: "I agree that WhatsUp Gold may contact me.",
      language: "en",
      privacyUrl: "https://www.whatsupgold.com/privacy",
      at: "2026-10-30T14:02:00.000Z",
    });
  });

  it("records German consent for a German page, the widget's own wording when the partner wrote none", () => {
    const de = lead({
      language: "de",
      consent_text: "Ich bin einverstanden, zu meiner Anfrage kontaktiert zu werden.",
      cta_label: "Angebot anfordern",
    });
    assert.equal(de.consent.language, "de");
    assert.equal(de.consent.text, "Ich bin einverstanden, zu meiner Anfrage kontaktiert zu werden.");
    assert.equal(de.trigger.ctaLabel, "Angebot anfordern");
    const own = { ...settings, translations: { de: { leadConsent: "Ich willige ein, dass WhatsUp Gold mich kontaktiert." } } };
    assert.equal(consentText(own, "de"), "Ich willige ein, dass WhatsUp Gold mich kontaktiert.");
  });

  it("keeps the consent wording only when it is the deployment's own, and a button label only when a button has it", () => {
    const value = lead({ consent_text: "I agree to everything, including spam.", cta_label: "<script>" });
    assert.equal(value.consent.text, "I agree that WhatsUp Gold may contact me.");
    assert.deepEqual(value.trigger, { placement: "cta" });
    assert.deepEqual(lead({ placement: "elsewhere" }).trigger, { placement: "header" });
  });

  it("lets no personal data from the address through: no query strings, no other keys, no email addresses", () => {
    const value = lead({
      page_url: "https://www.whatsupgold.com/pricing",
      attribution: {
        landingPage: "https://www.whatsupgold.com/?email=x@y.z&utm_source=linkedin",
        referrer: "https://mail.example/inbox?to=x@y.z",
        utm_source: "linkedin",
        utm_term: "x@y.z",
        email: "x@y.z",
      },
    });
    assert.deepEqual(value.attribution, {
      landingPage: "https://www.whatsupgold.com/",
      referrer: "https://mail.example/inbox",
      utm_source: "linkedin",
    });
    assert.doesNotMatch(JSON.stringify(leadPayload(value, "Main site", "WhatsUp Gold", new Date())), /x@y\.z/);
  });

  it("validates against the published schema, delivery's text and subject included", () => {
    const value = lead({ transcript: [{ author: "USER", text: "Can I get a quote?" }] });
    const payload = leadPayload(value, "Main site", "WhatsUp Gold", new Date("2026-10-30T14:02:05Z"));
    const message = leadMessage(value, "Main site", "WhatsUp Gold");
    // What the webhook receives (packages/notify postWebhook).
    const webhook = { text: message.text, subject: message.subject, fields: message.fields, ...payload };
    assert.deepEqual(problems(webhook, schema), []);
    assert.equal(payload.schemaVersion, 2);
    assert.deepEqual(problems({ ...webhook, consent: { ...payload.consent, given: false } }, schema), ["$.consent.given: not true"]);
  });

  it("marks a lead from a staging page as a test, in the subject and the JSON", () => {
    const value = lead();
    const message = leadMessage(value, "Main site", "WhatsUp Gold", { test: true });
    assert.equal(message.subject, "[Test, from a staging page] New lead from the WhatsUp Gold website chat");
    assert.match(message.text, /^A test: sent from a staging page. /);
    const payload = leadPayload(value, "Main site", "WhatsUp Gold", new Date(), { test: true });
    assert.equal(payload.test, true);
    assert.deepEqual(problems({ subject: message.subject, text: message.text, ...payload }, schema), []);
    assert.ok(!("test" in leadPayload(value, "Main site", "WhatsUp Gold", new Date())));
  });

  it("names the customer as visitors see it, and puts the consent wording in the email", () => {
    const message = leadMessage(lead(), "Main site", "WhatsUp Gold");
    assert.equal(message.subject, "New lead from the WhatsUp Gold website chat");
    assert.equal(message.fields?.Consent, "“I agree that WhatsUp Gold may contact me.” (ticked 2026-10-30 14:02 UTC, English)");
    assert.equal(message.fields?.["Opened from"], "the “Get a quote” button");
    assert.equal(message.fields?.Campaign, "utm_source=linkedin, utm_campaign=q4");
  });
});
