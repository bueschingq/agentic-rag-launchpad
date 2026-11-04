import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { NO_CONTEXT_ANSWER, todayRule, withoutToday, withToday } from "@launchpad/theme";
import {
  CASE_RULE,
  composeSystemPrompt,
  composeUserPrompt,
  isConsoleUserPrompt,
  PARTIAL_RULE,
  searchConfigFor,
  TOP_K,
} from "../src/lib/prompt.ts";
import { PROMPT_TEMPLATES, promptFromTemplate, templateLinesCurrent, updatedPrompt, visitorName } from "../src/lib/prompt-templates.ts";
import { groupQuestions, questionKey, ruleOf } from "../src/lib/report.ts";

const friday = new Date("2026-10-30T09:00:00Z");

describe("prompt templates", () => {
  it("speak as the website, never about how they work, in every template", () => {
    for (const { key } of PROMPT_TEMPLATES) {
      const p = promptFromTemplate(key, "Telerik", "https://www.telerik.com/");
      assert.match(p, /say "we", "us" and "our"/, key);
      assert.match(p, /Never mention context, documents, sources, data/, key);
      // Round 4: the console's no-answer sentence word for word, never "in one sentence" in the
      // model's own words, and prices by quote said so, with the page.
      assert.match(p, /reply only with this sentence, in English and word for word: Not enough data to answer this\./, key);
      assert.match(p, /prices are by quote or on request, say so/, key);
      // Round 5: a part of an answer, what isn't stated said of the page read, never of the whole
      // site (answering rules 1), and the case asked.
      assert.match(
        p,
        /If our website answers only part of the question, give that part, and say what the page you read doesn't state, naming the page; never say our website as a whole doesn't list or provide something\. If nothing on our website helps/,
        key,
      );
      assert.match(p, /Answer only about the case the visitor asks about/, key);
      assert.doesNotMatch(p, /reply in one sentence that you don't know/, key);
      assert.ok(templateLinesCurrent(p), key);
      // No wording that invites "the context says…" back.
      assert.doesNotMatch(p, /provided context|the context/i, key);
    }
  });

  it("replace the old don't-know line on Update the prompt, rather than keep it as the partner's own", () => {
    const old =
      'You are the chat assistant on www.crayola.com, the website of Crayola. Speak as Crayola: say "we", "us" and "our", as a member of our team would. ' +
      "Answer only with what our website says, and never guess or invent details such as prices, dates, names or policies. " +
      "Never mention context, documents, sources, data or how you found an answer: just answer. " +
      "If our website doesn't say, reply in one sentence that you don't know, and suggest contacting us. " +
      "Be friendly, clear and brief: under 120 words, plain language, short paragraphs or a short list. " +
      "Never ask for personal details such as account numbers, passwords or health information.\n\nMention our stain tips when they help.";
    assert.equal(templateLinesCurrent(old), false);
    const update = updatedPrompt(old, { client: "Crayola", siteUrl: "https://www.crayola.com", otherNames: [], leakPhrases: [] });
    assert.deepEqual(update.kept, ["Mention our stain tips when they help."]);
    assert.equal(
      update.prompt,
      `${promptFromTemplate("general", "Crayola", "https://www.crayola.com")}\n\nMention our stain tips when they help.`,
    );
    assert.ok(templateLinesCurrent(update.prompt));
    // Round 4's no-answer line is replaced too.
    const round4 = old.replace(
      "If our website doesn't say, reply in one sentence that you don't know, and suggest contacting us.",
      `If our website doesn't answer the question, reply only with this sentence, in English and word for word: ${NO_CONTEXT_ANSWER}`,
    );
    assert.deepEqual(
      updatedPrompt(round4, { client: "Crayola", siteUrl: "https://www.crayola.com", otherNames: [], leakPhrases: [] }).kept,
      ["Mention our stain tips when they help."],
    );
  });

  it("use the name visitors see, never the internal one", () => {
    const name = visitorName({ name: "Telerik (exec review)", displayName: "Telerik" });
    assert.equal(name, "Telerik");
    // Nothing falls back to the internal name: unset, the template says "the organization".
    assert.equal(visitorName({ name: "Harbor View Dental", displayName: null }), undefined);
    assert.equal(visitorName({ name: "Harbor View Dental", displayName: "  " }), undefined);
    assert.match(promptFromTemplate("general", undefined, "https://www.harborview.example"), /the website of the organization\./);
    for (const { key } of PROMPT_TEMPLATES) assert.doesNotMatch(promptFromTemplate(key, name, "https://www.telerik.com"), /exec review/);
  });
});

describe("the console's answering rules (the user prompt)", () => {
  it("puts the site's text and the question where Agentic RAG fills them in", () => {
    const user = composeUserPrompt("auto");
    assert.equal(user.match(/\{context\}/g)?.length, 1);
    assert.equal(user.match(/\{question\}/g)?.length, 1);
    assert.ok(user.indexOf("{context}") < user.indexOf("{question}"));
    assert.ok(isConsoleUserPrompt(user));
    assert.ok(!isConsoleUserPrompt("Answer the question: {question} from {context}"));
  });

  it("asks for the question's language, after the site's text, when following each visitor", () => {
    const user = composeUserPrompt("auto");
    assert.match(user, /in the language of the visitor's question, even when the website text is in another language: translate it/);
    // Rules come after the text the model reads, where they hold (whatsupgold.com, 2026-10-30).
    assert.ok(user.indexOf("translate it") > user.indexOf("{question}"));
    assert.match(composeUserPrompt("de"), /Write your answer in German, whatever language the question or the website text is in/);
  });

  it("keeps each product's advice to that product", () => {
    assert.match(composeUserPrompt("en"), /answer only from the pages about the one the visitor asks about/);
    assert.match(composeUserPrompt("en"), /alternatives, migration path, prices or features, as true of another/);
    const strategies = searchConfigFor("Be brief.", "en", null).rag_strategies?.map((s) => s.name);
    assert.deepEqual(strategies, ["neighbouring_paragraphs", "hierarchy"]);
  });

  it("keeps Agentic RAG's no-answer sentence, and no wording visitors could get back", () => {
    for (const language of ["auto", "en", "es"] as const) {
      const user = composeUserPrompt(language);
      // Word for word in English, whatever the language: the widget and the report recognise it.
      assert.ok(user.endsWith(`reply only, in English and word for word whatever the language: ${NO_CONTEXT_ANSWER}`), language);
      assert.doesNotMatch(user.replace("{context}", ""), /context|documents?/i, language);
      // Round 5: a part of an answer is given; the sentence is for when nothing helps.
      assert.ok(user.includes(PARTIAL_RULE) && user.includes(CASE_RULE), language);
      assert.match(user, /Only when nothing in the website text helps with the question, reply only/, language);
    }
    // Round 5: 20 paragraphs, so a key page's text isn't crowded out after the full sync.
    assert.equal(searchConfigFor("Be brief.", "auto", null).top_k, TOP_K);
    assert.deepEqual(searchConfigFor("Be brief.", "auto", null).prompt, {
      system: composeSystemPrompt("Be brief.", "auto", null),
      user: composeUserPrompt("auto"),
    });
  });
});

describe("today's date in the prompt", () => {
  it("is added to every saved prompt, after the language rule", () => {
    const system = composeSystemPrompt("Be brief.", "de", friday);
    assert.equal(system, `Be brief.\n\nAlways answer in German, whatever language the question is in.\n\n${todayRule(friday)}`);
    assert.match(todayRule(friday), /^Today's date is Friday,? 30 October 2026\. /);
    // B's events rule: over only by a full date, with the year (round 5's yearless webinar).
    assert.match(todayRule(friday), /over only if its full date, with the year, is before today/);
    assert.doesNotMatch(todayRule(friday), /dated before today are over/);
    assert.equal(
      (searchConfigFor("Be brief.", "en", friday).prompt as { system: string }).system,
      composeSystemPrompt("Be brief.", "en", friday),
    );
  });

  it("is replaced, not repeated, when the date moves on", () => {
    const saturday = new Date("2026-10-31T00:05:00Z");
    const before = composeSystemPrompt("Be brief.", "auto", friday);
    const after = withToday(before, saturday);
    assert.equal(after, composeSystemPrompt("Be brief.", "auto", saturday));
    assert.equal(after.match(/Today's date is/g)?.length, 1);
    assert.equal(withToday(after, saturday), after);
    // Prompts saved before the date existed get it.
    assert.equal(withToday("Be brief.", friday), `Be brief.\n\n${todayRule(friday)}`);
    // The daily refresh changes only the date: a prompt saved with the older events wording keeps it.
    const dateOf = (d: Date) => todayRule(d).slice(0, todayRule(d).indexOf(". ") + 2);
    const rule =
      "Events, webinars, offers and deadlines dated before today are over: never call them next, upcoming or open. If no date after today is given for what the visitor asks about, say so in one sentence and link our events page if you have it.";
    assert.equal(withToday(`Be brief.\n\n${dateOf(friday)}${rule}`, saturday), `Be brief.\n\n${dateOf(saturday)}${rule}`);
  });

  it("is left out when comparing prompts saved on different days", () => {
    assert.equal(withoutToday(composeSystemPrompt("Be brief.", "es", friday)), composeSystemPrompt("Be brief.", "es", null));
    // A partner's own mention of a date mid-prompt stays.
    const own = "Today's date is not something to guess.\n\nBe brief.";
    assert.equal(withoutToday(own), own);
  });
});

describe("report wording and grouping", () => {
  it("counts identical wordings together, ignoring case and punctuation only", () => {
    assert.equal(questionKey("¿Venden bicicletas?"), questionKey("venden bicicletas"));
    assert.equal(questionKey("What are your hours?!"), questionKey("what are your  hours"));
    // Different wordings stay apart (no grouping by meaning).
    assert.notEqual(questionKey("How much does WhatsUp Gold cost?"), questionKey("How much is WhatsUp Gold?"));
    const groups = groupQuestions([
      { question: "¿Venden bicicletas?", answered: false },
      { question: "¿venden bicicletas?", answered: false },
      { question: "¿Venden bicicletas?", answered: false },
      { question: "Verkaufen Sie Fahrräder?", answered: false },
    ]);
    assert.deepEqual(groups[0], { question: "¿Venden bicicletas?", count: 3, answered: 0 });
    assert.equal(groups.length, 2);
  });

  it("labels questions counted with the earlier rule", () => {
    const at = (d: string) => new Date(`2026-10-${d}T10:00:00Z`);
    assert.deepEqual(ruleOf([{ verdictSource: "widget", askedAt: at("30") }]), { earlier: "none" });
    assert.deepEqual(ruleOf([{ verdictSource: null, askedAt: at("02") }]), { earlier: "all" });
    assert.deepEqual(
      ruleOf([
        { verdictSource: null, askedAt: at("02") },
        { verdictSource: "log", askedAt: at("30") },
        { verdictSource: "widget", askedAt: at("31") },
      ]),
      { earlier: "some", since: at("30") },
    );
  });
});
