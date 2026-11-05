// Validation for the new-deployment form. Pure, so it runs under node:test.

import { type LanguageSetting, languageSetting } from "@launchpad/theme";
import type { FormErrors } from "./customer-form.ts";

export const MAX_PROMPT = 4000;
const MAX_DOMAINS = 10;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface DeploymentInput {
  customerId: string;
  name: string;
  siteUrl: string;
  // Origins allowed to embed the chat: the site's first, then any extra (staging, other hosts).
  domains: string[];
  // null: use the customer's language.
  language: LanguageSetting | null;
  systemPrompt: string;
}

// http(s) with a real host: a dotted name, or localhost for a partner testing locally.
function webUrl(value: string): URL | undefined {
  try {
    const url = new URL(value);
    const web = url.protocol === "https:" || url.protocol === "http:";
    return web && (url.hostname.includes(".") || url.hostname === "localhost") ? url : undefined;
  } catch {
    return undefined;
  }
}

export function parseDeploymentForm(form: FormData): { value: DeploymentInput } | { errors: FormErrors } {
  const errors: FormErrors = {};
  const text = (name: string) => {
    const value = form.get(name);
    return typeof value === "string" ? value.trim() : "";
  };

  const customerId = text("customerId");
  if (!UUID.test(customerId)) errors.customerId = "Choose a customer, or add a new one.";

  const name = text("name");
  if (!name) errors.name = "Name the deployment, e.g. the site or section it serves.";
  else if (name.length > 120) errors.name = "Keep the name under 120 characters.";

  // A bare host is common enough to accept; the site is assumed to be on https.
  const rawSite = text("siteUrl");
  const site = webUrl(rawSite) ?? (rawSite && !rawSite.includes("://") ? webUrl(`https://${rawSite}`) : undefined);
  if (!site) errors.siteUrl = "Enter the site's address, e.g. https://www.example.com.";

  const domains = site ? [site.origin] : [];
  const extra = text("extraDomains")
    .split(/[\s,]+/)
    .filter(Boolean);
  for (const line of extra) {
    const url = webUrl(line) ?? (line.includes("://") ? undefined : webUrl(`https://${line}`));
    if (!url) {
      errors.extraDomains = `"${line}" isn't a web address.`;
      break;
    }
    if (!domains.includes(url.origin)) domains.push(url.origin);
  }
  if (domains.length > MAX_DOMAINS) errors.extraDomains = `Allow at most ${MAX_DOMAINS} domains.`;

  const rawLanguage = text("language");
  const language = rawLanguage ? languageSetting(rawLanguage) : null;
  if (rawLanguage && language !== rawLanguage) errors.language = "Pick a language from the list.";

  const systemPrompt = text("systemPrompt");
  if (!systemPrompt) errors.systemPrompt = "Write the system prompt the chatbot answers with.";
  else if (systemPrompt.length > MAX_PROMPT)
    errors.systemPrompt = `Keep the prompt under ${MAX_PROMPT.toLocaleString("en-US")} characters.`;

  if (Object.keys(errors).length) return { errors };
  return { value: { customerId, name, siteUrl: site!.href, domains, language, systemPrompt } };
}
