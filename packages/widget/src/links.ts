// Links the partner configures (call-to-action buttons, handoff contacts) and links inside
// answers. The console validates the partner's, and the widget checks again, since they
// become hrefs on customers' pages.

import { sameSite, type WidgetCta } from "@launchpad/theme";

export type ContactType = "page" | "phone" | "email";

const LINK_PROTOCOLS = new Set(["https:", "http:", "mailto:", "tel:"]);

export function linkHref(url: unknown): string | undefined {
  if (typeof url !== "string") return undefined;
  try {
    const u = new URL(url);
    return LINK_PROTOCOLS.has(u.protocol) ? u.href : undefined;
  } catch {
    return undefined;
  }
}

export const contactType = (href: string): ContactType =>
  href.startsWith("tel:") ? "phone" : href.startsWith("mailto:") ? "email" : "page";

// Pages on the same site open in place, like source links, and the conversation follows
// (it's kept per tab and per origin); other sites open in a new tab; phone and email links
// hand over to the visitor's apps.
export function linkTarget(href: string, pageHost: string): "_top" | "_blank" | undefined {
  if (contactType(href) !== "page") return undefined;
  return new URL(href).host === pageHost ? "_top" : "_blank";
}

// One site: www.client.com, client.com and shop.client.com, but not client.com.evil.example.
export { sameSite };

// Links inside answers: http(s) only, and only to the client's own sites (`hosts`: the page's
// and those of the pages the answer drew on). Anything else is shown as plain text.
export function answerHref(url: string, hosts: readonly string[]): string | undefined {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" && u.protocol !== "http:") return undefined;
    return hosts.some((host) => sameSite(u.host, host)) ? u.href : undefined;
  } catch {
    return undefined;
  }
}

// Lower case without accents, so "Réservation" matches the keyword "reservation".
const fold = (text: string) => text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

// A keyword as a whole word or phrase, with an optional plural ending: "cost" matches "costs"
// but not "costume", and "rate" never fires on "accurate". "contains" matches anywhere.
export function mentions(text: string, keyword: string, match: WidgetCta["match"] = "word"): boolean {
  const k = fold(keyword.trim());
  if (!k) return false;
  const folded = fold(text);
  if (match === "contains") return folded.includes(k);
  const phrase = k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  return new RegExp(`(?:^|[^\\p{L}\\p{N}])${phrase}(?:s|es)?(?=$|[^\\p{L}\\p{N}])`, "u").test(folded);
}

// Words that make a button a way to reach the team, in the widget's languages: contact and sales,
// or a quote ("Get a quote", "Angebot anfordern", "Solicitar presupuesto", "Demander un devis").
const TO_TEAM =
  /(^|[^a-z])(contact|kontakt|contacto|contato|contatt|sales|vertrieb|ventas|vendas|vendite|verkoop|quote|quotation|angebot|presupuesto|cotiza|devis|preventiv|offerte|orcamento)/;

const samePage = (a: string, b: string) => {
  const bare = (u: string) =>
    u
      .replace(/[?#].*$/, "")
      .replace(/\/+$/, "")
      .toLowerCase();
  return bare(a) === bare(b);
};

// Whether a call-to-action button already reaches the team: it opens the contact form, calls or
// emails, goes where a handoff contact goes, or is a contact, sales or quote page by its label or
// address. Under such a button the handoff card would offer the same thing twice.
export function reachesTeam(cta: WidgetCta, contacts: readonly string[] = []): boolean {
  if (cta.action === "lead") return true;
  const href = linkHref(cta.url);
  if (!href) return false;
  if (contactType(href) !== "page" || contacts.some((c) => samePage(c, href))) return true;
  return TO_TEAM.test(fold(`${cta.label} ${new URL(href).pathname}`));
}

// A way to reach the team in a reply's own words: a link or web address, an email, a phone number
// ("1-800-CRAYOLA" too), or a contact page or form it names ("the contact form on our Contact Us
// page", "Kontaktformular", "formulario de contacto").
const WEB = /https?:\/\/|\bwww\.|\]\(|[\w.+-]+@[\w-]+\.[a-z]{2,}/i;
const PHONE = /\+?\d[\d\s().-]{6,}\d|(^|[^a-z0-9])1[-\s.]?8\d\d[-\s.]?[a-z0-9]{4,}/i;
const CONTACT_WORD = "contact|kontakt|contacto|contato|contatt[io]|contactez";
const PAGE_WORD = "page|form|seite|formular|pagina|formulario|formulaire|formulier|modulo";
// The page word whole, or joined on ("Kontaktformular"), never inside another ("information").
const NAMED_PAGE = new RegExp(
  `(${CONTACT_WORD})([a-z -]{0,20}?[ -])?(${PAGE_WORD})s?(?![a-z])|(?<![a-z])(${PAGE_WORD})\\s+(de |di |van |da |du )?(${CONTACT_WORD})`,
  "i",
);

// Whether a reply gives the visitor a way to reach the team itself, or a source link under it is
// one (a contact, sales or quote page by its address or title, or where a handoff contact goes):
// then a handoff card under it would only repeat it (whatsupgold.com, round 5: "Contact our sales
// team by completing the contact form on our Contact Us page", citing Contact Us).
export function waysToTeam(
  answer: string,
  sources: readonly { title: string; href: string }[] = [],
  contacts: readonly string[] = [],
): boolean {
  const text = fold(answer);
  if (WEB.test(text) || PHONE.test(text) || NAMED_PAGE.test(text)) return true;
  return sources.some((s) => contacts.some((c) => samePage(c, s.href)) || TO_TEAM.test(fold(`${s.title} ${new URL(s.href).pathname}`)));
}

// The call-to-action buttons whose keywords the visitor's question or the answer mentions,
// in the partner's order. Buttons that open the contact form need no link.
export function matchCtas(ctas: readonly WidgetCta[], question: string, answer: string, max = 2): WidgetCta[] {
  const text = `${question}\n${answer}`;
  return ctas
    .filter((cta) => (cta.action === "lead" || linkHref(cta.url)) && cta.keywords.some((k) => mentions(text, k, cta.match)))
    .slice(0, max);
}
