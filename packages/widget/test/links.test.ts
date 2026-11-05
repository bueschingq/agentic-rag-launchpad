import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PublicWidgetConfig, WidgetCta } from "@launchpad/theme";
import { type AnalyticsWindow, track } from "../src/analytics.ts";
import { answerHref, contactType, linkHref, linkTarget, matchCtas, mentions, reachesTeam, sameSite, waysToTeam } from "../src/links.ts";

describe("linkHref", () => {
  it("allows web pages, email and phone links", () => {
    assert.equal(linkHref("https://example.com/book"), "https://example.com/book");
    assert.equal(linkHref("mailto:help@example.com"), "mailto:help@example.com");
    assert.equal(linkHref("tel:+15551234567"), "tel:+15551234567");
  });

  it("refuses anything that could run script, and junk", () => {
    assert.equal(linkHref("javascript:alert(1)"), undefined);
    assert.equal(linkHref(" JavaScript:alert(1)"), undefined);
    assert.equal(linkHref("data:text/html,<script>alert(1)</script>"), undefined);
    assert.equal(linkHref("/relative"), undefined);
    assert.equal(linkHref(42), undefined);
  });
});

describe("contactType and linkTarget", () => {
  it("tells phone and email links from pages", () => {
    assert.equal(contactType("tel:+15551234567"), "phone");
    assert.equal(contactType("mailto:a@b.co"), "email");
    assert.equal(contactType("https://b.co/contact"), "page");
  });

  it("opens same-site pages in place and other sites in a new tab", () => {
    assert.equal(linkTarget("https://www.example.com/contact", "www.example.com"), "_top");
    assert.equal(linkTarget("https://calendly.com/example", "www.example.com"), "_blank");
    assert.equal(linkTarget("tel:+15551234567", "www.example.com"), undefined);
  });
});

describe("reachesTeam: a button that would make the handoff card a second way to do the same thing", () => {
  const cta = (label: string, url: string, action?: "lead"): WidgetCta => ({ label, url, keywords: ["x"], ...(action && { action }) });

  it("is a contact, sales or quote button, in the widget's languages (whatsupgold.com's buttons)", () => {
    assert.ok(reachesTeam(cta("Get a quote", "https://www.whatsupgold.com/quote")));
    assert.ok(reachesTeam(cta("Angebot anfordern", "https://www.whatsupgold.com/de/pricing-contact-sales")));
    assert.ok(reachesTeam(cta("Solicitar presupuesto", "https://www.whatsupgold.com/es/presupuesto")));
    assert.ok(reachesTeam(cta("Talk to us", "https://acme.com/kontakt")), "by its address");
    assert.ok(reachesTeam(cta("Send us a message", "", "lead")), "the contact form");
    assert.ok(reachesTeam(cta("Call us", "tel:+15551234567")));
    assert.ok(reachesTeam(cta("Our team", "https://acme.com/team/"), ["https://acme.com/team"]), "where a handoff contact goes");
  });

  it("isn't a pricing, demo or trial button", () => {
    assert.ok(!reachesTeam(cta("See pricing", "https://www.telerik.com/purchase.aspx")));
    assert.ok(!reachesTeam(cta("Book a demo", "https://www.whatsupgold.com/demo")));
    assert.ok(!reachesTeam(cta("Start free trial", "https://www.whatsupgold.com/trial")));
    assert.ok(!reachesTeam(cta("Broken", "javascript:alert(1)")));
  });
});

describe("waysToTeam: a reply that already says how to reach the team needs no handoff card", () => {
  const contactUs = { title: "Contact Us", href: "https://www.whatsupgold.com/contact" };
  const grid = { title: "React Grid Overview", href: "https://www.telerik.com/kendo-react-ui/components/grid" };

  it("is a named contact page or form, a link, an email or a phone number (whatsupgold.com, round 5)", () => {
    const sales = "Contact our sales team by completing the contact form on our Contact Us page. A specialist will reply by email shortly.";
    assert.ok(waysToTeam(sales), "names the contact form and page");
    assert.ok(waysToTeam(sales, [contactUs]));
    assert.ok(waysToTeam("Call or text us at **1-800-CRAYOLA** weekdays from 9 AM to 4 PM Eastern Time."));
    assert.ok(waysToTeam("Email sales@acme.com and we'll reply within a day."));
    assert.ok(waysToTeam("Please [contact us](https://acme.com/contact)."));
    assert.ok(waysToTeam("Call +49 30 1234 5678."));
    assert.ok(waysToTeam("Füllen Sie bitte unser Kontaktformular aus."));
    assert.ok(waysToTeam("Rellene el formulario de contacto."));
    assert.ok(waysToTeam("Remplissez le formulaire de contact."));
  });

  it("is a contact page among the sources under it, or where a handoff contact goes", () => {
    assert.ok(waysToTeam("Please contact us.", [contactUs]));
    assert.ok(waysToTeam("Please contact us.", [{ title: "Team", href: "https://acme.com/team" }], ["https://acme.com/team/"]));
  });

  it("isn't a reply that only says to contact the team", () => {
    assert.ok(!waysToTeam("Contact us to discuss becoming a Sitefinity partner."), "the demo's partner question");
    assert.ok(!waysToTeam("Contact Support.", [grid]), "telerik.com: cited to React pages");
    assert.ok(!waysToTeam("Contact our sales team through the **Contact Sales** option on our website."));
    assert.ok(!waysToTeam("Please contact us for more information."), "not the form in information");
    assert.ok(!waysToTeam("For Crayola Goo on carpet, we don't have a carpet-specific removal method listed. Please contact us for help."));
  });
});

describe("matchCtas", () => {
  const book: WidgetCta = { label: "Book an appointment", url: "https://example.com/book", keywords: ["appointment", "booking"] };
  const quote: WidgetCta = { label: "Get a quote", url: "https://example.com/quote", keywords: ["price", "cost"] };
  const reserve: WidgetCta = { label: "Réserver", url: "https://example.com/reserver", keywords: ["réservation"] };

  it("matches keywords in the question or the answer, ignoring case and accents", () => {
    assert.deepEqual(matchCtas([book, quote], "Can I make an APPOINTMENT?", ""), [book]);
    assert.deepEqual(matchCtas([book, quote], "Hours?", "Prices start at $40."), [quote]);
    assert.deepEqual(matchCtas([reserve], "Comment faire une reservation ?", ""), [reserve]);
  });

  it("keeps the partner's order and stops at the limit", () => {
    const third: WidgetCta = { label: "Call", url: "tel:+15551234567", keywords: ["cost"] };
    assert.deepEqual(matchCtas([quote, book, third], "booking cost", ""), [quote, book]);
  });

  it("matches whole words, with plurals, unless a button opts into contains", () => {
    const pricing: WidgetCta = { label: "See pricing", url: "https://example.com/pricing", keywords: ["price", "pricing", "cost"] };
    const rates: WidgetCta = { label: "Our rates", url: "https://example.com/rates", keywords: ["rate"] };
    assert.deepEqual(matchCtas([pricing], "Do you have costume parties for kids?", ""), []);
    assert.deepEqual(matchCtas([rates], "How accurate is your corporate pricing?", ""), []);
    assert.deepEqual(matchCtas([pricing], "What are the costs?", ""), [pricing]);
    assert.deepEqual(matchCtas([rates], "Current rates, please", ""), [rates]);
    assert.deepEqual(matchCtas([{ ...rates, match: "contains" }], "How accurate is it?", ""), [{ ...rates, match: "contains" }]);
    assert.ok(mentions("Can I book a visit?", "book a  visit"));
    assert.ok(!mentions("Follow us on Facebook", "book"));
  });

  it("lets buttons that open the contact form through without a link", () => {
    const callback: WidgetCta = { label: "Request a callback", url: "", keywords: ["callback"], action: "lead" };
    assert.deepEqual(matchCtas([callback], "Can I get a callback?", ""), [callback]);
    assert.deepEqual(matchCtas([{ ...callback, action: "link" }], "Can I get a callback?", ""), []);
  });

  it("skips buttons with unsafe links or blank keywords", () => {
    assert.deepEqual(matchCtas([{ ...book, url: "javascript:alert(1)" }], "appointment", ""), []);
    assert.deepEqual(matchCtas([{ ...book, keywords: [" "] }], "anything", ""), []);
  });
});

describe("track", () => {
  const config = (analytics?: { googleAnalytics: boolean; measurementId?: string }) =>
    ({ deploymentId: "d1", settings: { analytics } }) as unknown as PublicWidgetConfig;

  it("always dispatches a DOM event, with no GA call when GA is off", () => {
    const target = new EventTarget();
    const seen: unknown[] = [];
    target.addEventListener("arag-chat:event", (e) => seen.push((e as CustomEvent).detail));
    const calls: unknown[] = [];
    const win: AnalyticsWindow = { gtag: (...args) => calls.push(args), dataLayer: [] };
    track(target, config(), "arag_chat_question", { question_length: 12, starter: false }, win);
    assert.deepEqual(seen, [{ name: "arag_chat_question", deployment_id: "d1", question_length: 12, starter: false }]);
    assert.equal(calls.length, 0);
    assert.equal(win.dataLayer?.length, 0);
  });

  it("uses the site's gtag, routed to a measurement ID when one is set", () => {
    const calls: unknown[][] = [];
    const win: AnalyticsWindow = { gtag: (...args) => calls.push(args), dataLayer: [] };
    track(new EventTarget(), config({ googleAnalytics: true, measurementId: "G-ABC123" }), "arag_chat_open", {}, win);
    assert.deepEqual(calls, [["event", "arag_chat_open", { deployment_id: "d1", send_to: "G-ABC123" }]]);
    assert.equal(win.dataLayer?.length, 0);
  });

  it("falls back to Tag Manager's dataLayer, and to nothing", () => {
    const win: AnalyticsWindow = { dataLayer: [] };
    track(new EventTarget(), config({ googleAnalytics: true }), "arag_chat_cta_click", { cta_label: "Book" }, win);
    assert.deepEqual(win.dataLayer, [{ event: "arag_chat_cta_click", deployment_id: "d1", cta_label: "Book" }]);
    assert.doesNotThrow(() => track(new EventTarget(), config({ googleAnalytics: true }), "arag_chat_open", {}, {}));
  });

  it("survives a broken gtag", () => {
    const win: AnalyticsWindow = {
      gtag: () => {
        throw new Error("blocked");
      },
    };
    assert.doesNotThrow(() => track(new EventTarget(), config({ googleAnalytics: true }), "arag_chat_open", {}, win));
  });
});

describe("links in answers", () => {
  it("treats www, the bare domain and subdomains as one site", () => {
    assert.ok(sameSite("www.client.com", "client.com"));
    assert.ok(sameSite("shop.client.com", "www.client.com"));
    assert.ok(!sameSite("client.com.evil.example", "client.com"));
    assert.ok(!sameSite("otherclient.com", "client.com"));
  });

  it("links only to the client's own sites, over http(s)", () => {
    const hosts = ["www.client.com", "docs.client.io"];
    assert.equal(answerHref("https://client.com/hours", hosts), "https://client.com/hours");
    assert.equal(answerHref("https://docs.client.io/a", hosts), "https://docs.client.io/a");
    assert.equal(answerHref("https://evil.example/phish", hosts), undefined);
    assert.equal(answerHref("javascript:alert(1)", hosts), undefined);
    assert.equal(answerHref("/relative", hosts), undefined);
  });
});
