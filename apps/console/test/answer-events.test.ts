import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { questionHash } from "@launchpad/theme";
import { isTestQuestion } from "../src/lib/report.ts";
import { answerEventsFromBody, countName, countsFromBody, isTestOrigin, questionEventFromBody } from "../src/lib/widget-events.ts";

describe("answer events from the widget", () => {
  const hash = questionHash("¿Venden bicicletas?");

  it("keeps the verdict and thumbs with the question's hash, and nothing else", () => {
    const body = JSON.stringify({
      events: [
        {
          name: "arag_chat_answer",
          conversation_id: "c1",
          question_hash: hash,
          answered: false,
          language: "es",
          question: "¿Venden bicicletas?",
        },
        { name: "arag_chat_feedback", conversation_id: "c1", question_hash: hash, value: "down", answered: true },
        // No hash (an older widget): counted, but not an answer event.
        { name: "arag_chat_answer", conversation_id: "c2", answered: true },
        { name: "arag_chat_answer", conversation_id: "c3", question_hash: "not-a-hash", answered: true },
        { name: "arag_chat_feedback", conversation_id: "c1", question_hash: hash, value: "sideways" },
        { name: "arag_chat_answer", conversation_id: "<script>", question_hash: hash, answered: true },
      ],
    });
    assert.deepEqual(answerEventsFromBody(body), [
      { kind: "answer", conversationId: "c1", questionHash: hash, answered: false, language: "es", attempts: 1 },
      { kind: "feedback", conversationId: "c1", questionHash: hash, feedback: "down" },
    ]);
    // The daily counts still see every answer event.
    assert.equal(countsFromBody(body).get("arag_chat_answer\u0000answered")?.count, 3);
    assert.deepEqual(answerEventsFromBody("not json"), []);
  });
});

describe("a question the widget asked again", () => {
  it("keeps how many asks it took, 1 or 2", () => {
    const hash = questionHash("How much is it for 300 devices?");
    const body = (attempts: unknown) =>
      JSON.stringify({ events: [{ name: "arag_chat_answer", conversation_id: "c1", question_hash: hash, answered: true, attempts }] });
    const attemptsOf = (b: string) => (answerEventsFromBody(b)[0] as { attempts: number }).attempts;
    assert.equal(attemptsOf(body(2)), 2);
    assert.equal(attemptsOf(body(undefined)), 1, "an older widget");
    assert.equal(attemptsOf(body(40)), 2);
    assert.equal(attemptsOf(body("2")), 1);
  });
});

describe("the question event, sent as the question is asked", () => {
  const hash = questionHash("How do I get slime out of carpet?");

  it("takes the conversation and the question's hash, and nothing else", () => {
    const body = JSON.stringify({
      type: "question",
      conversationId: "c1",
      questionHash: hash,
      question: "How do I get slime out of carpet?",
    });
    assert.deepEqual(questionEventFromBody(body), { conversationId: "c1", questionHash: hash });
  });

  it("turns away anything else: a batch, a bad hash or conversation, or not JSON", () => {
    assert.equal(questionEventFromBody(JSON.stringify({ events: [] })), undefined);
    assert.equal(questionEventFromBody(JSON.stringify({ type: "question", conversationId: "c1", questionHash: "nope" })), undefined);
    assert.equal(questionEventFromBody(JSON.stringify({ type: "question", conversationId: "<script>", questionHash: hash })), undefined);
    assert.equal(questionEventFromBody(JSON.stringify({ type: "answer", conversationId: "c1", questionHash: hash })), undefined);
    assert.equal(questionEventFromBody("null"), undefined);
    assert.equal(questionEventFromBody("not json"), undefined);
    // A question event counts nothing in the daily figures and is no answer event.
    const body = JSON.stringify({ type: "question", conversationId: "c1", questionHash: hash });
    assert.equal(countsFromBody(body).size, 0);
    assert.deepEqual(answerEventsFromBody(body), []);
  });
});

describe("test traffic", () => {
  const staging = ["https://staging.crayola.com"];

  it("is a staging domain's, by exact origin, or this machine's", () => {
    assert.ok(isTestOrigin("https://staging.crayola.com/", staging));
    assert.ok(!isTestOrigin("https://www.crayola.com", staging));
    assert.ok(!isTestOrigin("https://staging.crayola.com:8443", staging), "another port is another site");
    assert.ok(isTestOrigin("http://localhost:4191", []), "a stand-in site on this machine, marked or not");
    assert.ok(isTestOrigin("http://127.0.0.1:4174", []));
    assert.ok(!isTestOrigin(null, staging), "an older widget's event: counted for the client");
  });

  it("covers questions from staging and partner tests, and keeps the widget's counts apart", () => {
    assert.ok(isTestQuestion({ partnerTest: false, origin: "https://staging.crayola.com" }, staging));
    assert.ok(isTestQuestion({ partnerTest: true, origin: null }, []));
    assert.ok(!isTestQuestion({ partnerTest: false, origin: "https://www.crayola.com" }, staging));
    assert.equal(countName("arag_chat_open", true), "test:arag_chat_open");
    assert.equal(countName("arag_chat_open", false), "arag_chat_open");
  });
});
