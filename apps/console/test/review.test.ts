import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ValidationResult } from "@launchpad/db";
import { provisioningProblem } from "@launchpad/par-client";
import type { WidgetSettings } from "@launchpad/theme";
import { allowanceFrom, capacityMessage } from "../src/lib/capacity.ts";
import { leadSubject } from "../src/lib/leads.ts";
import { promptFromTemplate } from "../src/lib/prompt-templates.ts";
import {
  brandStatus,
  CHECKS_VERSION,
  canSignOff,
  confirmationBy,
  contentChangeSummary,
  contentChangeWords,
  type ReviewFacts,
  reviewDecisions,
  reviewLines,
  signOffOffer,
  signOffState,
  underOlderChecks,
  visitorSettingsHash,
} from "../src/lib/review.ts";
import { LEAK_PHRASES, reviewNotes } from "../src/lib/validation-rules.ts";

// Four generated questions and two of the partner's own, all answered.
const passed: ValidationResult = {
  at: "2026-10-30T10:20:00Z",
  passed: true,
  questions: Array.from({ length: 6 }, (_, i) => ({ question: `Question ${i}?`, answer: "A", sources: [], answered: true, own: i >= 4 })),
};
const by = { by: "u1", name: "Dana Ruiz", at: "2026-10-30T10:30:00Z", verified: true };
const facts = (over: Partial<ReviewFacts> = {}, settings: WidgetSettings = {}): ReviewFacts => ({
  base: "/d",
  settings,
  language: "en",
  brand: "confirmed",
  confirmations: { starters: by },
  leadDelivery: {},
  validation: passed,
  domainsLocked: true,
  content: { indexed: 40, total: 40 },
  ...over,
});
const line = (f: ReviewFacts, key: string) => reviewLines(f).find((l) => l.key === key)!;
const ready = {
  handoff: { contacts: [{ kind: "link" as const, url: "tel:+15550100" }], show: [] },
  privacyUrl: "https://a.example/privacy",
};

describe("reviewLines", () => {
  it("can't be signed off without a handoff, until someone skips it on purpose", () => {
    const missing = facts({}, { privacyUrl: "https://a.example/privacy" });
    assert.equal(line(missing, "handoff").state, "todo");
    assert.match(line(missing, "handoff").skip!.consequence, /no way to reach the team/);
    assert.ok(!canSignOff(reviewLines(missing)));
    const skipped = facts({ confirmations: { starters: by, noHandoff: by } }, { privacyUrl: "https://a.example/privacy" });
    assert.equal(line(skipped, "handoff").state, "skipped");
    assert.ok(canSignOff(reviewLines(skipped)));
    assert.ok(canSignOff(reviewLines(facts({}, ready))));
  });

  it("needs a privacy notice and somewhere for leads to go while the contact form is on", () => {
    const form = { lead: { enabled: true, fields: [], requiredFields: [] } };
    const noDestination = facts({ confirmations: { starters: by, noPrivacy: by } }, { ...form, handoff: ready.handoff });
    // Skipping the privacy link doesn't count with the form on.
    assert.equal(line(noDestination, "privacy").state, "todo");
    assert.equal(line(noDestination, "privacy").skip, undefined);
    assert.equal(line(noDestination, "form").state, "todo");
    assert.match(line(noDestination, "form").detail, /nowhere to go/);
    const ok = facts({ leadDelivery: { webhookUrl: "https://hooks.example/x" } }, { ...form, ...ready });
    assert.ok(canSignOff(reviewLines(ok)));
    // The form with a destination is a handoff on its own.
    assert.equal(line(facts({ leadDelivery: { emails: ["a@b.example"] } }, { ...form, privacyUrl: "x" }), "handoff").state, "ok");
    assert.match(line(ok, "form").detail, /leads go to the webhook at hooks\.example/);
  });

  it("asks for validation again when it ran early in the first sync, and doesn't count 'tell me about' questions", () => {
    const early = { ...passed, content: { answerable: 52, total: 202, partial: true } } as ValidationResult;
    const thin = line(facts({ validation: early }, ready), "validation");
    assert.equal(thin.state, "check");
    assert.match(thin.detail, /52 of 202/);
    assert.ok(!canSignOff(reviewLines(facts({ validation: early }, ready))));
    // An older run with fallback questions in place of generated ones no longer passes.
    const fallback = {
      ...passed,
      questions: passed.questions.map((q, i) => (i < 3 ? { ...q, question: `What can you tell me about topic ${i}?` } : q)),
    };
    const old = line(facts({ validation: fallback }, ready), "validation");
    assert.equal(old.state, "todo");
    assert.match(old.detail, /3 "tell me about" questions aren't counted/);
  });

  it("holds sign-off for generic consent wording until someone writes the client's or keeps it on purpose", () => {
    const form = { lead: { enabled: true, fields: [], requiredFields: [] } };
    const generic = facts({ leadDelivery: { emails: ["a@b.example"] }, consentMissing: ["English"] }, { ...form, ...ready });
    assert.equal(line(generic, "form").state, "check");
    assert.match(line(generic, "form").skip!.consequence, /English/);
    assert.ok(!canSignOff(reviewLines(generic)));
    const kept = { ...generic, confirmations: { starters: by, genericConsent: by } };
    assert.equal(line(kept, "form").state, "skipped");
    assert.ok(canSignOff(reviewLines(kept)));
  });

  it("says which served languages show no starters", () => {
    const served = { ...ready, starters: ["Question 0?"], languages: ["en" as const, "de" as const, "es" as const] };
    const none = line(facts({ language: "auto" }, served), "starters");
    assert.equal(none.state, "ok");
    assert.match(none.detail, /; German and Spanish visitors see none \(add theirs in Widget, Languages\)\.$/);
    assert.equal(none.href, "/d/widget#languages");
    const german = line(facts({ language: "auto" }, { ...served, translations: { de: { starters: ["Frage 0?"] } } }), "starters");
    assert.match(german.detail, /; Spanish visitors see none/);
    assert.doesNotMatch(line(facts({}, served), "starters").detail, /see none/);
  });

  it("holds sign-off for an unconfirmed brand, unchosen starters and unchecked answers, but not for CTAs or GA", () => {
    assert.equal(line(facts({ brand: "changed" }, ready), "brand").state, "check");
    assert.equal(line(facts({ confirmations: {} }, { ...ready, starters: ["What is it?"] }), "starters").state, "check");
    const flagged: ValidationResult = {
      ...passed,
      questions: [{ question: "How much?", answer: "$1,149", sources: [], answered: true, flags: ["price"] }],
    };
    assert.equal(line(facts({ validation: flagged }, ready), "validation").state, "check");
    assert.ok(!canSignOff(reviewLines(facts({ validation: flagged }, ready))));
    assert.equal(line(facts({}, ready), "ctas").required, false);
    assert.equal(line(facts({}, ready), "analytics").required, false);
  });
});

describe("sign-off", () => {
  const d = {
    theme: { color: { primary: "#eb0249" } },
    widgetSettings: { nickname: "Telerik" },
    systemPrompt: "Be brief.",
    language: "en",
  };

  it("notices any change to what visitors see, and nothing else", () => {
    const hash = visitorSettingsHash(d);
    assert.equal(visitorSettingsHash({ ...d, widgetSettings: { nickname: "Telerik", welcome: undefined } }), hash);
    assert.equal(signOffState({ ...by, settingsHash: hash }, hash).state, "signed");
    assert.equal(signOffState({ ...by, settingsHash: hash }, visitorSettingsHash({ ...d, systemPrompt: "Be chatty." })).state, "changed");
    assert.equal(signOffState(null, hash).state, "none");
  });

  it("counts a change of the name visitors see after the sign-off as a change", () => {
    const hash = visitorSettingsHash(d);
    const signed = { ...by, settingsHash: hash };
    const after = signOffState(signed, hash, new Date("2026-10-30T11:00:00Z"));
    assert.ok(after.state === "changed" && after.nameChanged);
    assert.equal(signOffState(signed, hash, new Date("2026-10-30T09:00:00Z")).state, "signed");
  });

  it("counts pages added, kept or left out by hand after the sign-off as a change, and offers sign off the changes", () => {
    const hash = visitorSettingsHash(d);
    const signed = { ...by, settingsHash: hash };
    const after = signOffState(signed, hash, undefined, "2026-10-30T11:00:00.000Z");
    assert.ok(after.state === "changed" && after.contentChanged && !after.nameChanged);
    assert.equal(signOffOffer(after.state, false), "changes");
    // A change from before the sign-off, or none still standing, leaves it signed.
    assert.equal(signOffState(signed, hash, undefined, "2026-10-30T09:00:00.000Z").state, "signed");
    assert.equal(signOffState(signed, hash, undefined, undefined).state, "signed");
    const both = signOffState(signed, hash, new Date("2026-10-30T11:00:00Z"), new Date("2026-10-30T11:05:00Z"));
    assert.ok(both.state === "changed" && both.nameChanged && both.contentChanged);
  });

  it("words content changes for Review's change list and the deployment page", () => {
    const added = { kind: "added" as const, url: "https://www.telerik.com/contact", label: "Added by hand: /contact" };
    const kept = {
      kind: "kept" as const,
      url: "https://www.whatsupgold.com/blog/real-cost",
      label: "Kept by hand despite a stale price: /blog/real-cost",
      reason: "The client confirmed the price.",
    };
    const left = { kind: "left-out" as const, url: "https://www.telerik.com/old", label: "Left out by hand: /old" };
    const keys = { kind: "key-pages" as const, label: "Key pages added: /pricing, /contact" };
    const settings = { kind: "settings" as const, label: "Content settings: page budget" };
    assert.equal(contentChangeWords(added), "added /contact by hand");
    assert.equal(contentChangeWords(kept), "kept /blog/real-cost by hand despite a stale price (“The client confirmed the price”)");
    assert.equal(contentChangeWords(left), "left /old out by hand");
    assert.equal(contentChangeWords(keys), "added the key pages /pricing, /contact");
    assert.equal(contentChangeWords(settings), "changed the content settings (page budget)");
    assert.equal(contentChangeSummary([added]), "1 page added by hand");
    assert.equal(contentChangeSummary([added, kept, left]), "2 pages added by hand and 1 left out by hand");
    assert.equal(contentChangeSummary([left, settings]), "1 page left out by hand and the content settings changed");
    assert.equal(contentChangeSummary([keys]), "key pages added");
  });

  it("offers a new sign-off only for changes or today's checks, never while the last one stands", () => {
    assert.equal(signOffOffer("none", false), "first");
    assert.equal(signOffOffer("changed", false), "changes");
    assert.equal(signOffOffer("changed", true), "changes");
    assert.equal(signOffOffer("signed", true), "checks");
    // Nothing visitors see changed (a validation run since doesn't count): no button at all.
    assert.equal(signOffOffer("signed", false), undefined);
  });

  it("names the person, or asks for a name in setup mode", () => {
    const named = confirmationBy(
      { id: "u1", email: "d@a.example", name: "Dana Ruiz", role: "partner_member", setupMode: false },
      undefined,
    );
    assert.ok("verified" in named && named.verified && named.name === "Dana Ruiz");
    const setup = { id: null, email: null, name: "Setup admin", role: "partner_admin" as const, setupMode: true };
    assert.ok("error" in confirmationBy(setup, " "));
    const typed = confirmationBy(setup, "Sam");
    assert.ok("name" in typed && typed.name === "Sam (setup mode, not verified)" && !typed.verified);
  });

  it("knows a brand changed after it was confirmed", () => {
    const confirmed = { brand: { ...by, values: { nickname: "Telerik", primary: "#EB0249" } } };
    assert.equal(brandStatus({ nickname: "Telerik" }, { color: { primary: "#eb0249" } }, confirmed), "confirmed");
    assert.equal(brandStatus({ nickname: "Telerik UI" }, { color: { primary: "#eb0249" } }, confirmed), "changed");
    assert.equal(brandStatus({ nickname: "Telerik" }, {}, {}), "unconfirmed");
  });
});

describe("the Client's name line", () => {
  const name = (prompt: string, over: Partial<NonNullable<ReviewFacts["clientName"]>> = {}) =>
    line(
      facts(
        {
          clientName: {
            internal: "Crayola (UX review r3)",
            visible: "Crayola",
            prompt,
            strings: [],
            leadEmail: leadSubject("Crayola"),
            leakPhrases: LEAK_PHRASES,
            ...over,
          },
        },
        ready,
      ),
      "name",
    );
  const template = promptFromTemplate("general", "Crayola", "https://www.crayola.com");

  it("is done only for what the product read, and holds sign-off otherwise", () => {
    assert.equal(name(template).state, "ok");
    const leaked = name(`${template}\n\nAnswer only from the provided context.`);
    assert.deepEqual([leaked.state, leaked.fix, leaked.href], ["check", "Update the prompt", "/d/review/prompt"]);
    // A hand edit with the internal name.
    const edited = name(`${template} Sign as Crayola (UX review r3).`);
    assert.equal(edited.state, "check");
    assert.match(edited.detail, /still calls the client "Crayola \(UX review r3\)"/);
  });

  it("holds sign-off after a name change until the prompt says the new name", () => {
    const company = { visible: "Crayola Company", previous: ["Crayola"], leadEmail: leadSubject("Crayola Company") };
    const renamed = name(template, company);
    assert.equal(renamed.state, "check");
    // "Crayola" is a short form of the new name, so what holds it is the prompt not saying it.
    assert.match(renamed.detail, /never names the client "Crayola Company"/);
    const updated = promptFromTemplate("general", "Crayola Company", "https://www.crayola.com");
    assert.equal(name(updated, company).state, "ok");
  });

  it("sends a widget problem to the widget page, and a missing name to the customer", () => {
    const widget = name(template, { strings: [{ where: "the chat name", text: "Crayola (UX review r3)" }] });
    assert.deepEqual([widget.state, widget.href], ["check", "/d/widget"]);
    const unset = name(template, { visible: null });
    assert.deepEqual([unset.state, unset.href], ["todo", "/d/edit#displayName"]);
  });
});

describe("signed off under older checks", () => {
  it("is any sign-off without today's checks version", () => {
    assert.equal(CHECKS_VERSION, 3);
    assert.ok(underOlderChecks({}));
    assert.ok(underOlderChecks({ checksVersion: 1 }));
    assert.ok(!underOlderChecks({ checksVersion: CHECKS_VERSION }));
    // Never signed off isn't "older checks": it needs a first sign-off.
    assert.ok(!underOlderChecks(null));
  });

  it("keeps Review's Content line at Check this until it's brought up to date, never Done", () => {
    const older = facts({ olderChecks: { contentApplied: false, reextracting: 0 } }, ready);
    const content = line(older, "content");
    assert.deepEqual([content.state, content.fix, content.href], ["check", "Bring up to date", "/d/review/up-to-date"]);
    assert.match(content.detail, /^Check this: signed off under older checks/);
    assert.ok(!canSignOff(reviewLines(older)));
    // Applied, but pages still being read again.
    const reading = line(facts({ olderChecks: { contentApplied: true, reextracting: 12 } }, ready), "content");
    assert.deepEqual([reading.state, /12 pages are still being read again/.test(reading.detail)], ["check", true]);
    // Applied and read again: the usual line.
    const done = facts({ olderChecks: { contentApplied: true, reextracting: 0 } }, ready);
    assert.equal(line(done, "content").state, "ok");
    assert.ok(canSignOff(reviewLines(done)));
  });
});

describe("validation decisions and starters on Review", () => {
  it('lists every removal and every "doesn\'t cover this" with who and why', () => {
    const at = "2026-10-30T15:12:00Z";
    const notes = {
      ...reviewNotes(passed),
      removed: [{ question: "How much is it?", reason: "Not on the site yet", name: "Quinton", at }],
      notCovered: [{ question: "Do you ship to Mars?", reason: "They don't", name: "Quinton", at }],
    };
    assert.deepEqual(reviewDecisions(notes), [
      "“How much is it?” removed after No answer, by Quinton (2026-10-30 15:12 UTC): Not on the site yet",
      "“Do you ship to Mars?”: the site doesn't cover this, by Quinton (2026-10-30 15:12 UTC): They don't",
    ]);
    assert.deepEqual(reviewDecisions(undefined), []);
  });

  it("says what validation did with the chosen starters, and holds a starter that wasn't answered", () => {
    const starters = { ...ready, starters: ["How much does it cost?"] };
    const run: ValidationResult = {
      ...passed,
      questions: [
        ...passed.questions,
        {
          question: "How much does it cost?",
          answer: "$849 per developer.",
          sources: [],
          answered: true,
          starter: true,
          flags: ["price"],
          acknowledged: by,
        } as ValidationResult["questions"][number],
      ],
    };
    const ok = line(facts({ validation: run, notes: reviewNotes(run) }, starters), "starters");
    assert.equal(ok.state, "ok");
    assert.equal(ok.detail, "1 chosen by Dana Ruiz, 1 answered, 1 price checked by Dana Ruiz.");
    const unanswered = { ...run, questions: run.questions.map((q) => (q.question.startsWith("How much") ? { ...q, answered: false } : q)) };
    const held = line(facts({ validation: unanswered, notes: reviewNotes(unanswered) }, starters), "starters");
    assert.equal(held.state, "check");
    assert.match(held.detail, /1 got no answer/);
    // A starter the latest run never asked.
    const notAsked = line(facts({ notes: reviewNotes(passed) }, starters), "starters");
    assert.deepEqual([notAsked.state, /not asked in the latest validation run/.test(notAsked.detail)], ["check", true]);
  });
});

describe("capacity and provisioning problems", () => {
  it("says how many Knowledge Boxes are left, and what to do at none", () => {
    assert.deepEqual(allowanceFrom(27, { limit: 30, source: "refused" }), { used: 27, limit: 30, left: 3, source: "refused" });
    assert.equal(capacityMessage(allowanceFrom(27, { limit: 30, source: "pat" })).tone, "warning");
    const full = capacityMessage(allowanceFrom(30, { limit: 30, source: "pat" }));
    assert.equal(full.tone, "critical");
    assert.match(full.text, /None left/);
    assert.match(capacityMessage(allowanceFrom(12, undefined)).text, /add a PAT/);
  });

  it("puts known API failures in plain words, with who acts", () => {
    const limit = provisioningProblem(
      'Stopped at "kb": POST …/kbs → 402: You reached the maximum number of Knowledge Boxes for this account.',
    );
    assert.equal(limit.kind, "limit");
    assert.doesNotMatch(limit.text, /402|POST/);
    assert.equal(provisioningProblem("Agentic RAG refused the key request (403): the account key needs KB management.").who, "admin");
    assert.equal(provisioningProblem("fetch failed: getaddrinfo ENOTFOUND").kind, "unreachable");
    assert.equal(provisioningProblem(undefined).kind, "other");
  });
});

describe("Review's round-4 lines", () => {
  const q = (question: string, over: Partial<ValidationResult["questions"][number]> & Record<string, unknown> = {}) => ({
    question,
    answer: "A",
    sources: [],
    answered: true,
    ...over,
  });
  const six = passed.questions;

  it("says a pass went without a decision on a No answer, and lists it", () => {
    const run = { ...passed, questions: [...six, q("Do you ship to Canada?", { answered: false })] } as ValidationResult;
    const v = line(facts({ validation: run, notes: reviewNotes(run) }, ready), "validation");
    assert.equal(v.state, "ok");
    assert.match(v.detail, /^Passed: 1 question with No answer and no decision: “Do you ship to Canada\?”\./);
  });

  it("asks for a quote button when the price question has no answer and nothing offers a quote", () => {
    const run = {
      ...passed,
      questions: [
        ...six,
        q("How much do your products cost?", { answered: false, intent: "price", notCovered: { ...by, reason: "By quote" } }),
      ],
    } as ValidationResult;
    const prices = line(facts({ validation: run, notes: reviewNotes(run) }, ready), "prices");
    assert.equal(prices.state, "check");
    assert.match(prices.detail, /^Check this: price questions have no answer and no quote button/);
    assert.equal(prices.required, false);
    const quote = { ...ready, ctas: [{ label: "Request a quote", url: "https://a.example/quote", keywords: ["price"] }] };
    assert.equal(line(facts({ validation: run, notes: reviewNotes(run) }, quote), "prices"), undefined);
  });

  it("shows pages kept by hand with who and why, without holding up sign-off", () => {
    const kept = [
      {
        url: "https://www.whatsupgold.com/blog/real-cost-of-network-monitor",
        title: "The real cost of network monitoring",
        rule: "This page states a price and was published 11 Oct 2016.",
        reason: "The client confirmed the price still applies",
        by: null,
        name: "Quinton",
        verified: false,
        at: "2026-10-30T10:00:00Z",
      },
    ];
    const f = facts({ kept }, ready);
    const k = line(f, "kept");
    assert.equal(k.state, "check");
    assert.equal(
      k.detail,
      "Check this: 1 page kept by hand despite a stale price: The real cost of network monitoring (This page states a price and was published 11 Oct 2016), kept by Quinton (not verified): The client confirmed the price still applies.",
    );
    assert.ok(canSignOff(reviewLines(f)));
  });

  it("says when a thin run runs again by itself, with Run it now", () => {
    const thin = { ...passed, content: { answerable: 38, total: 190, partial: true } } as ValidationResult;
    const v = line(facts({ validation: thin, content: { indexed: 60, total: 190 } }, ready), "validation");
    assert.equal(v.state, "check");
    assert.equal(v.runNow, true);
    assert.match(v.detail, /Runs again by itself at 95 of 190 pages answerable \(now 60/);
  });

  it("records a starter the automatic re-run removed, until someone picks again", () => {
    const run = {
      ...passed,
      startersRemoved: [{ question: "How do I contact sales?", at: "2026-10-30T11:00:00Z", reason: "no answer", auto: "sync-finished" }],
    } as ValidationResult;
    const s = line(facts({ validation: run, notes: reviewNotes(run) }, { ...ready, starters: ["Can I try it?"] }), "starters");
    assert.equal(s.state, "check");
    assert.match(s.detail, /“How do I contact sales\?” removed from the chat after the automatic re-run \(no answer\): pick again/);
    const picked = facts(
      { validation: run, notes: reviewNotes(run), confirmations: { starters: { ...by, at: "2026-10-30T12:00:00Z" } } },
      { ...ready, starters: ["Can I try it?"] },
    );
    assert.doesNotMatch(line(picked, "starters").detail, /removed/);
  });
});

describe("Review's round-5 fixes", () => {
  it("shows when a thin run runs again, with Run it now, even while a price waits for a check", () => {
    const thin = {
      ...passed,
      questions: [...passed.questions, { question: "How much?", answer: "$9.", sources: [], answered: true, flags: ["price" as const] }],
      content: { answerable: 38, total: 190, partial: true },
    } as ValidationResult;
    const v = line(facts({ validation: thin, content: { indexed: 60, total: 190 } }, ready), "validation");
    assert.equal(v.state, "check");
    assert.equal(v.runNow, true);
    assert.match(v.detail, /price to check/);
    assert.match(v.detail, /Runs again by itself at 95 of 190 pages answerable/);
  });
});

describe("Review's key pages line", () => {
  it("lists key pages the chat can't answer from, as Check this that doesn't hold up sign-off", () => {
    const unused = [
      {
        url: "https://www.example.com/contact",
        why: "/contact has almost no text (3 words): the chat can't answer from it. Put the contact details in Handoff, or add a page that states them.",
      },
    ];
    const f = facts({ keyPagesUnused: unused }, ready);
    const k = line(f, "keypages");
    assert.equal(k.state, "check");
    assert.match(k.detail, /^Check this: 1 key page the chat can't answer from\. \/contact has almost no text/);
    assert.ok(canSignOff(reviewLines(f)));
  });
});
