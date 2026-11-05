// The order and words of the handoff contacts suggested on the configurator (round 6, item 7):
// the deployment's contact key page first, as the place visitors should reach the team; with none,
// its support key page (round 7: northwesternenergy.com has /customer-service and no page called
// contact, and the only suggestion was the agency's internal email); then the contact page the scan
// found; the customer's internal contact last, labelled for what it is, a person at the client, to
// offer visitors only if the client wants that, never as the default public contact. Pure: the
// configurator applies it, and a test checks it.

import type { ContactSuggestion } from "@/lib/widget-form.ts";

export const PRIMARY_EMAIL_NOTE = "only if the client wants visitors to email this person";
export const PRIMARY_PHONE_NOTE = "only if the client wants visitors to call this person";

export function orderHandoffSuggestions(
  suggestions: readonly ContactSuggestion[],
  contactKeyPage?: string | null,
  supportKeyPage?: string | null,
): ContactSuggestion[] {
  const contact = contactKeyPage?.startsWith("https://") ? contactKeyPage : undefined;
  const support = !contact && supportKeyPage?.startsWith("https://") ? supportKeyPage : undefined;
  const key = contact ?? support;
  const same = (a: string, b: string) => a.replace(/\/+$/, "").toLowerCase() === b.replace(/\/+$/, "").toLowerCase();
  const rest = suggestions.filter((s) => !key || !same(s.contact.url, key));
  const first: ContactSuggestion[] = key
    ? [{ contact: { kind: "link", url: key }, why: contact ? "The contact key page" : "The support key page", from: "pages" }]
    : [];
  const internal = rest
    .filter((s) => s.from === "primary")
    .map((s) => ({
      ...s,
      why: `${s.why.replace("the customer's primary contact", "the customer's internal contact")}: ${
        s.contact.url.startsWith("tel:") ? PRIMARY_PHONE_NOTE : PRIMARY_EMAIL_NOTE
      }`,
    }));
  return [...first, ...rest.filter((s) => s.from !== "primary"), ...internal];
}
