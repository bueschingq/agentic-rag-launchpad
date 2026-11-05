import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  type ClientNameFacts,
  clientNameDetail,
  clientNameProblems,
  promptUpdate,
  renamedWidgetText,
  visitorStrings,
} from "../src/lib/client-name.ts";
import { leadName, leadSubject } from "../src/lib/leads.ts";
import { promptFromTemplate, renameClient, templateOf, updatedPrompt } from "../src/lib/prompt-templates.ts";
import { LEAK_PHRASES } from "../src/lib/validation-rules.ts";

const SITE = "https://www.progress.com/sitefinity-cms";
// The demo's saved prompt in round 3, signed off while it called the client by the partner's
// internal name and invited "the context" answers.
const DEMO_PROMPT =
  "You are the website assistant for Sitefinity Demo Co (review). Answer only from the provided context, and suggest contacting Sitefinity Demo Co (review) when it doesn't say.";

const facts = (over: Partial<ClientNameFacts> = {}): ClientNameFacts => ({
  internal: "Sitefinity Demo Co (review)",
  visible: "Progress",
  prompt: promptFromTemplate("general", "Progress", SITE),
  strings: [],
  leadEmail: leadSubject(leadName("Progress", SITE)),
  leakPhrases: LEAK_PHRASES,
  ...over,
});

describe("the Client's name check", () => {
  it("is done for the current template with the visible name, and says what it checked", () => {
    assert.deepEqual(clientNameProblems(facts()), []);
    const detail = clientNameDetail([], facts());
    assert.match(detail, /calls the client "Progress"/);
    assert.match(detail, /"Sitefinity Demo Co \(review\)" isn't in it, the widget's text in any language or the lead email/);
  });

  it("catches the demo: the internal name in the prompt, quoted, and a line inviting leaks", () => {
    const problems = clientNameProblems(facts({ prompt: DEMO_PROMPT }));
    assert.deepEqual(
      problems.map((p) => p.kind),
      ["other-name", "missing", "leak"],
    );
    const detail = clientNameDetail(problems, facts());
    assert.match(
      detail,
      /^Check this: the saved prompt still calls the client "Sitefinity Demo Co \(review\)": "You are the website assistant/,
    );
    assert.match(detail, /\(2 more to fix\)/);
    const leak = problems.find((p) => p.kind === "leak");
    assert.ok(leak?.kind === "leak" && /provided context/.test(leak.line));
  });

  it("catches a hand edit that brings the internal name back", () => {
    const edited = `${promptFromTemplate("general", "Progress", SITE)}\n\nAlways sign off as the Sitefinity Demo Co (review) team.`;
    const [first] = clientNameProblems(facts({ prompt: edited }));
    assert.ok(first?.kind === "other-name" && first.line === "Always sign off as the Sitefinity Demo Co (review) team.");
    // Edited in the Agentic RAG dashboard: the prompt the Knowledge Box answers with is read too.
    const served = clientNameProblems(facts({ served: `${DEMO_PROMPT}\n\nAnswer in the language the question is asked in.` }));
    assert.ok(served.some((p) => p.kind === "other-name" && p.where === "the prompt the Knowledge Box answers with"));
    assert.ok(served.some((p) => p.kind === "missing" && p.served));
  });

  it("allows the internal name when it's the name visitors see too", () => {
    const same = facts({
      internal: "Harbor View Dental",
      visible: "Harbor View Dental",
      prompt: promptFromTemplate("healthcare", "Harbor View Dental", SITE),
    });
    assert.deepEqual(clientNameProblems(same), []);
    assert.doesNotMatch(clientNameDetail([], same), /isn't in it/);
  });

  it("waits for a name, and never falls back to the internal one", () => {
    assert.deepEqual(clientNameProblems(facts({ visible: null })), [{ kind: "no-name" }]);
    assert.match(clientNameDetail([{ kind: "no-name" }], facts({ visible: null })), /Name visitors see isn't set/);
    // The lead email names the site rather than the partner's label.
    assert.equal(leadName(null, "https://www.crayola.com/"), "www.crayola.com");
    assert.equal(leadSubject(leadName(" Crayola ", "https://www.crayola.com/")), "New lead from the Crayola website chat");
  });

  it("follows a change of the name visitors see, both ways round", () => {
    const old = promptFromTemplate("general", "Crayola", "https://www.crayola.com");
    const renamed = facts({ internal: "Crayola (UX review r3)", visible: "Crayola Company", previous: ["Crayola"], prompt: old });
    const problems = clientNameProblems(renamed);
    // "Crayola" is a short form of "Crayola Company", so it isn't another name; but the prompt
    // never says the new name, so it still needs updating.
    assert.ok(!problems.some((p) => p.kind === "other-name"));
    assert.ok(problems.some((p) => p.kind === "missing"));
    // Nor is a chat name or starter that uses the short form a problem.
    assert.deepEqual(
      clientNameProblems({
        ...renamed,
        prompt: promptFromTemplate("general", "Crayola Company", "https://www.crayola.com"),
        strings: [
          { where: "the chat name", text: "Crayola" },
          { where: "a starter question", text: "Where can I buy Crayola products?" },
        ],
      }),
      [],
    );
    // The site's own address (www.crayola.com in the template) isn't the client's name.
    assert.deepEqual(
      clientNameProblems({ ...renamed, prompt: promptFromTemplate("general", "Crayola Company", "https://www.crayola.com") }),
      [],
    );
    const fixed = renameClient(old, "Crayola Company", ["Crayola (UX review r3)", "Crayola"]);
    assert.match(fixed, /on www\.crayola\.com, the website of Crayola Company\./);
    assert.deepEqual(clientNameProblems({ ...renamed, prompt: fixed }), []);
    // "Crayola Company" back to "Crayola": the old, longer name is caught though "Crayola" is in it.
    const back = facts({ internal: "Crayola (UX review r3)", visible: "Crayola", previous: ["Crayola Company"], prompt: fixed });
    assert.ok(clientNameProblems(back).some((p) => p.kind === "other-name" && p.name === "Crayola Company"));
    // And the internal name, which contains the visible one.
    const internal = facts({ internal: "Crayola (UX review r3)", visible: "Crayola", prompt: `${old}\n\nWe are Crayola (UX review r3).` });
    assert.ok(clientNameProblems(internal).some((p) => p.kind === "other-name" && p.name === "Crayola (UX review r3)"));
  });

  it("reads every visitor-facing string of the widget, in every language", () => {
    const settings = {
      nickname: "Progress",
      welcome: "Hi! Ask us about Sitefinity.",
      languages: ["en" as const, "de" as const],
      translations: { de: { welcome: "Willkommen bei Sitefinity Demo Co (review)!" } },
      lead: { enabled: true, fields: [], requiredFields: [], consentText: "Progress may contact me." },
    };
    const strings = visitorStrings(settings);
    assert.ok(strings.some((s) => s.where === "the welcome message (German)"));
    const [first] = clientNameProblems(facts({ strings }));
    assert.ok(first?.kind === "other-name" && first.where === "the welcome message (German)");
    assert.match(clientNameDetail([first], facts()), /the welcome message \(German\) still calls the client/);
  });

  it("never counts the console's own template lines as leaks", () => {
    for (const template of ["general", "healthcare", "financial", "education"] as const) {
      assert.deepEqual(clientNameProblems(facts({ prompt: promptFromTemplate(template, "Progress", SITE) })), [], template);
    }
  });
});

describe("Update the prompt", () => {
  it("brings the demo to the current template, saying what it left out and why", () => {
    const update = updatedPrompt(DEMO_PROMPT, {
      client: "Progress",
      siteUrl: SITE,
      otherNames: ["Sitefinity Demo Co (review)"],
      leakPhrases: LEAK_PHRASES,
    });
    assert.equal(update.prompt, promptFromTemplate("general", "Progress", SITE));
    assert.deepEqual(update.kept, []);
    assert.deepEqual(
      update.dropped.map((d) => d.line),
      [
        "You are the website assistant for Sitefinity Demo Co (review).",
        "Answer only from the provided context, and suggest contacting Sitefinity Demo Co (review) when it doesn't say.",
      ],
    );
    // Saved, it passes the check.
    assert.deepEqual(clientNameProblems(facts({ prompt: update.prompt })), []);
  });

  it("keeps the partner's own lines, with the client's name corrected, and the sector it was started from", () => {
    const saved = `${promptFromTemplate("financial", "Lakeside CU (pilot)", "https://www.lakeside.example")}\n\nMention our mobile app when it helps.\nLakeside CU (pilot) members get free checking.`;
    const update = updatedPrompt(saved, {
      client: "Lakeside Credit Union",
      siteUrl: "https://www.lakeside.example",
      otherNames: ["Lakeside CU (pilot)"],
      leakPhrases: LEAK_PHRASES,
    });
    assert.equal(update.template, "financial");
    assert.deepEqual(update.kept, ["Mention our mobile app when it helps.", "Lakeside Credit Union members get free checking."]);
    assert.deepEqual(update.dropped, []);
    assert.ok(update.prompt.startsWith(promptFromTemplate("financial", "Lakeside Credit Union", "https://www.lakeside.example")));
    assert.ok(update.prompt.endsWith("Mention our mobile app when it helps.\nLakeside Credit Union members get free checking."));
    // Run again, nothing changes.
    assert.equal(
      updatedPrompt(update.prompt, {
        client: "Lakeside Credit Union",
        siteUrl: "https://www.lakeside.example",
        otherNames: [],
        leakPhrases: LEAK_PHRASES,
      }).prompt,
      update.prompt,
    );
  });

  it("recognises template lines whatever names fill them, and a name with a full stop in it", () => {
    assert.equal(templateOf('Speak as Acme Inc.: say "we", "us" and "our", as a member of our team would.'), "general");
    assert.equal(templateOf("We sell paint."), undefined);
    const saved = promptFromTemplate("general", "Acme Inc.", "https://acme.example");
    const update = updatedPrompt(saved, {
      client: "Acme Inc.",
      siteUrl: "https://acme.example",
      otherNames: [],
      leakPhrases: LEAK_PHRASES,
    });
    assert.deepEqual([update.kept, update.dropped], [[], []]);
  });

  it("is offered only once there's a name visitors see", () => {
    assert.equal(
      promptUpdate({ systemPrompt: DEMO_PROMPT, siteUrl: SITE }, { internal: "Sitefinity Demo Co (review)", visible: null }),
      undefined,
    );
    assert.ok(promptUpdate({ systemPrompt: DEMO_PROMPT, siteUrl: SITE }, { internal: "Sitefinity Demo Co (review)", visible: "Progress" }));
  });

  it("renames the client in the widget's text for Update all, and leaves an already right widget alone", () => {
    const settings = { nickname: "Crayola", welcome: "Hi, I'm Crayola's helper.", translations: { de: { nickname: "Crayola" } } };
    const renamed = renamedWidgetText(settings, "Crayola Company", ["Crayola"]);
    assert.equal(renamed?.nickname, "Crayola Company");
    assert.equal(renamed?.welcome, "Hi, I'm Crayola Company's helper.");
    assert.equal(renamed?.translations?.de?.nickname, "Crayola Company");
    assert.equal(renamedWidgetText(renamed!, "Crayola Company", ["Crayola"]), undefined);
  });
});
