// Fix cycle 7e: good answers mistaken for bad ones, from the saved replies of the release checks
// (review-kit/round-7/verification). The chat works from text alone, and a false hold costs the
// visitor the sources, so a borderline case passes here: validation, the picker and the re-run have
// the judge. Beside each mechanism, the real non-answers it must still catch.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isAnswered, verdict } from "../src/index.ts";

const read = (question: string, answer: string, language?: string) =>
  verdict({ answer, question, status: "success", ...(language && { language }) });

describe("a contact question answered with more than one way", () => {
  it("two places named, in any language's quotes or in bold", () => {
    assert.ok(
      isAnswered(
        read(
          "Wie erreiche ich den Support?",
          "Sie erreichen unseren regionalen Support über den Bereich „SEEBURGER Support“ auf der Seite „SEEBURGER Kontaktformular“. Dort können Sie Ihren regionalen Support kontaktieren.",
        ),
      ),
    );
    assert.ok(
      isAnswered(
        read(
          "How do I contact sales?",
          "You can contact our Sales team through the **Contact Sales** or **Speak to Sales** options on our website.\n\nFor a demo, visit **Toggl Pricing Plans for Teams & Individuals** and select **Request Demo**.",
        ),
      ),
    );
  });
  it("alternatives offered", () => {
    assert.ok(
      isAnswered(
        read(
          "How do I get support as a customer?",
          "As a current customer, you can contact your Customer Success Manager or visit our Knowledge Base. Our Support page also says we’re available 24/7 via our contact form. Send us your question and we’ll get back to you with the right solution as soon as possible.",
        ),
      ),
    );
    assert.ok(
      isAnswered(
        read(
          "How do I contact support?",
          "You can contact our technical support by email or through the error-reporting or customer-feedback features available in the Service.\n\nWe aim to respond within 24 business hours, although resolution times are not guaranteed.",
        ),
      ),
    );
  });
  it("one page or form, or an apology, is still a deflection", () => {
    assert.equal(
      read("How do I contact sales?", "Contact us through our Contact Us page. A representative will respond within one business day."),
      "deflection",
    );
    assert.equal(read("Wie erreiche ich den Support?", "Bitte nutzen Sie dafür unsere Kontaktseite."), "deflection");
    assert.equal(read("How do I contact sales?", "Use the contact section of our website."), "deflection");
    assert.ok(
      !isAnswered(
        read(
          "Do you have a customer support phone number for my software licence?",
          "Sorry, I couldn't find an answer to that on this site. Our team can help: Contact us",
        ),
      ),
    );
  });
});

describe("how the site prices, without a figure", () => {
  it("quote-only, beside what it doesn't publish", () => {
    assert.ok(
      isAnswered(
        read(
          "What are your prices?",
          "Our page “Find the right contact” does not list fixed prices. For product selection, licensing, prices, and purchasing, please contact your local representative.\n\nFor HALCON, “HALCON Editions and Licensing” states that individual quotes are available based on edition, license type, and project requirements.",
        ),
      ),
    );
  });
  it("what the price depends on, to a question with no price word", () => {
    assert.ok(
      isAnswered(
        read(
          "Can you give me a ballpark figure?",
          "We don’t publish a ballpark price. Our Plans and Pricing page says pricing is a fixed, upfront annual fee based on the products you need and your Annual Construction Volume. Field Productivity is priced based on FTE. Get a custom quote through our Plans and Pricing page.",
        ),
      ),
    );
  });
  it("a comparison answered with its own pricing model isn't another subject", () => {
    assert.ok(
      isAnswered(
        read(
          "How does your pricing compare with Acme?",
          "Our pricing is a fixed annual fee based on your construction volume, with no per-user charges.",
        ),
      ),
    );
  });
  it("who to ask, or a page's name, isn't how it prices", () => {
    assert.equal(
      read(
        "How much does the Enterprise plan cost per year?",
        "I'm sorry, but I couldn't find pricing details for the Enterprise plan in the information I have access to. Our sales team would be the best people to help with a quote.",
      ),
      "may-not-answer",
    );
    assert.equal(
      read(
        "How much does Chef cost?",
        "Chef 360 uses a predictable subscription model, typically calculated per managed node. Our website does not list specific subscription prices. Visit our Pricing & Plans page.",
      ),
      "may-not-answer",
    );
    assert.equal(
      read(
        "How much does the Pro plan cost?",
        "The Pro plan includes unlimited projects, SSO and priority support, and works with all our integrations.",
      ),
      "substituted",
    );
  });
});

describe("a phone number, in any language's words", () => {
  it("the question's own word for it needn't come back", () => {
    assert.ok(isAnswered(read("Wat is het telefoonnummer van de klantenservice?", "U kunt ons bellen op +31 20 123 4567.")));
  });
  it("a directory by region answers it", () => {
    assert.ok(
      isAnswered(
        read("Wie lautet die Telefonnummer des Kundendienstes?", "Für Deutschland: +49 7131 6000. Für Österreich: +43 1 234 5678."),
      ),
    );
  });
  it("one number scoped away, or for a place the question doesn't name, is still another subject", () => {
    assert.equal(
      read("What is the phone number for support?", "For California privacy requests, call us at +1-949-783-1000."),
      "substituted",
    );
    assert.equal(
      read("What is the phone number for your office in Germany?", "Our Boston headquarters can be reached at +1 617 555 0100."),
      "substituted",
    );
    assert.equal(read("What is your phone number?", "You can reach our support team by email at support@example.com."), "substituted");
  });
});

describe("partial hours", () => {
  it("to a support question too", () => {
    assert.equal(
      read(
        "What are your support hours?",
        "We're available Monday to Friday, 8:00 to 18:00. The page doesn't state our weekend support hours.",
      ),
      "partly",
    );
  });
});
