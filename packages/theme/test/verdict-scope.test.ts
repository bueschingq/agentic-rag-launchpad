import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HANDOFF_VERDICTS, isAnswered, readReply, showsModelText, VERDICTS, verdict } from "../src/index.ts";

// Round 6, item 6: the verdict reads what a reply does with the thing asked, not whether it holds a
// negative phrase. Text only (no passages), as the question log has it.
const read = (question: string, answer: string, language = "en") => readReply({ answer, question, language, status: "success" });

describe("the scope-aware verdict", () => {
  it("names its outcomes, and the ones the widget shows the handoff card under", () => {
    assert.ok(VERDICTS.includes("deflection") && VERDICTS.includes("substituted"));
    assert.deepEqual([...HANDOFF_VERDICTS], ["may-not-answer", "deflection", "substituted"]);
    for (const v of HANDOFF_VERDICTS) {
      assert.equal(isAnswered(v), false);
      assert.equal(showsModelText(v), true);
    }
  });

  it("counts a negative only when its object is what was asked", () => {
    assert.equal(read("Can I get a free trial?", "Yes. You can start a 30-day free trial; no credit card is needed.").verdict, "answered");
    assert.equal(
      read(
        "Can I run Agentic RAG on my own servers?",
        "Yes. The page states that hybrid deployment keeps everything in your own NucliaDB instance, with nothing in Progress Cloud.",
      ).verdict,
      "answered",
    );
    assert.equal(
      read("How much does the Pro plan cost?", "Pricing for that plan isn't something I have to hand.").verdict,
      "may-not-answer",
    );
  });

  it("reads a page that states a negative fact as an answer, and a page that states nothing as a claim", () => {
    assert.ok(isAnswered(read("Can I get a refund?", "Our Terms page says no refunds are given after 30 days.").verdict));
    assert.equal(read("What are your prices?", "The page lists no prices.").verdict, "may-not-answer");
  });

  it("calls a reply whose only way forward is a pointer a deflection", () => {
    assert.equal(read("How do I contact sales?", "Contact us through our Contact page.").verdict, "deflection");
    assert.equal(read("Wie erreiche ich den Support?", "Bitte nutzen Sie dafür unsere Kontaktseite.", "de").verdict, "deflection");
    assert.equal(
      read("Are there any upcoming events?", "You'll find everything about our events on the Events page.").verdict,
      "deflection",
    );
    // Contact details, or a way to talk to someone, answer it; a page answers "where".
    assert.equal(read("How do I contact sales?", "Email sales@acme.com or use the Contact page.").verdict, "answered");
    assert.equal(
      read("How do I contact sales?", "Fill in the contact form, or request a callback and a consultant calls within five minutes.")
        .verdict,
      "answered",
    );
    assert.equal(read("Where can I find free coloring pages?", "On our Free Printable Coloring Pages page.").verdict, "answered");
    // A page as the step of a how-to isn't a deflection.
    assert.equal(read("How do I cancel my plan?", "Go to the Billing page.").verdict, "answered");
  });

  it("takes one part of a two-part question answered as an answer, not a substitution", () => {
    assert.equal(
      read("What are your opening hours and prices?", "Our opening hours are Monday to Friday, 8am to 6pm, at the clinic.").verdict,
      "answered",
    );
    assert.equal(
      read("What does the plan cost?", "The plan includes unlimited users, reports and a mobile app for your team.").verdict,
      "substituted",
    );
  });

  it("calls a step for another thing than the one asked a substitution", () => {
    const demo = read("Can I get a free trial?", "You can book a personalised demo from our Request a demo page.");
    assert.equal(demo.verdict, "substituted");
    assert.deepEqual(demo.substitute, { asked: "a trial", offered: "a demo" });
    assert.equal(read("Proposez-vous un essai gratuit ?", "Vous pouvez réserver une démo personnalisée.", "fr").verdict, "substituted");
    assert.equal(
      read("What is your phone number?", "You can reach our support team by email at support@example.com.").verdict,
      "substituted",
    );
    // Saying what isn't offered, and giving what is, answers it.
    assert.equal(
      read("What is your phone number?", "We don't offer phone support, but you can email support@example.com.").verdict,
      "answered",
    );
    assert.equal(read("Can I get a free trial or demo?", "Yes. Start a free trial, or request a personalised demo.").verdict, "answered");
  });

  it("holds a reply that says the prices are listed and gives none", () => {
    const r = read(
      "How much does WhatsUp Gold cost for 300 devices?",
      "Pricing is listed starting at 50 devices, not specifically for 300 devices. Contact Sales on our pricing page for a quote.",
    );
    assert.equal(r.verdict, "may-not-answer");
  });

  it("lets a plain yes or no with content found on the cited pages at least partly answer", () => {
    const passages = ["Trials: start a 14-day free trial from the Plans page."];
    const r = verdict({
      answer: "Yes. Start a 14-day free trial from the Plans page. The page doesn't say whether a card is needed.",
      question: "Is there a card needed for the free trial?",
      status: "success",
      passages,
    });
    assert.ok(isAnswered(r), r);
  });
});
