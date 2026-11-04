// The Agentic RAG agents pilot: the two agents' configuration, creating them once on a KB with
// its own model, the reprocess's progress, and cleaning the generated "what this page answers".

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AugmentClient, checkTaskParameters, type TaskItem } from "@launchpad/par-client";
import { json, mockFetch, type RecordedCall } from "../../../packages/par-client/test/helpers.ts";
import {
  AGENTS,
  ANSWERS_DESTINATION,
  agentParameters,
  cleanAnswerLine,
  ensureAgents,
  nextReprocess,
  type ReprocessState,
} from "../src/lib/augmentation.ts";

const ZONE = "aws-us-east-2-1";
const KB = "00000000-0000-4000-8000-0000000000b1";
const NOW = new Date("2026-10-31T12:00:00Z");
const LLM = { model: "chatgpt-azure-5.6-terra", provider: "microsoft" };

// The KB's DA endpoints, with `configs` as the tasks already there; started tasks get ids t-1, t-2…
function fakeKb(configs: TaskItem[] = [], opts: { startReturnsId?: boolean } = {}) {
  const tasks = [...configs];
  return mockFetch((call: RecordedCall) => {
    const path = new URL(call.url).pathname.replace(`/api/v1/kb/${KB}`, "");
    if (call.method === "GET" && path === "/tasks") return json({ tasks: [], configs: tasks, running: [], done: [] });
    if (call.method === "GET" && path === "/schema") {
      return json({
        generative_model: {
          default: "chatgpt-azure-5.6-terra",
          options: [
            { name: "GPT-5.6 Terra", value: "chatgpt-azure-5.6-terra", provider: "microsoft" },
            { name: "Claude 5 Sonnet", value: "claude-5-sonnet", provider: "claude3" },
          ],
        },
      });
    }
    if (call.method === "GET" && path === "/configuration") return json({ generative_model: "chatgpt-azure-5.6-terra" });
    if (call.method === "POST" && path === "/task/start") {
      const body = call.body as { name: string; parameters: { name: string } };
      const id = `t-${tasks.length + 1}`;
      tasks.push({ id, task: { name: body.name }, parameters: body.parameters });
      return json(opts.startReturnsId === false ? {} : { id });
    }
    return json({ detail: `unexpected ${call.method} ${path}` }, 404);
  });
}

const client = (fetch: ReturnType<typeof mockFetch>["fetch"]) =>
  new AugmentClient({ zone: ZONE, kbId: KB, credential: { kind: "key", token: "manager" }, fetch });
const starts = (calls: RecordedCall[]) => calls.filter((c) => c.url.endsWith("/task/start"));

describe("the pilot's agents", () => {
  it("are configured as the API needs them, or nothing would run", () => {
    for (const spec of AGENTS) checkTaskParameters(spec.agent, agentParameters(spec, LLM));
    assert.deepEqual(
      AGENTS.map((a) => a.agent),
      ["synthetic-questions", "ask"],
    );
  });

  it("ask for six visitor questions answered only from the passage", () => {
    const qa = (AGENTS[0]!.operations[0] as { qa: Record<string, unknown> }).qa;
    assert.equal(qa.max_questions, 6);
    assert.match(String(qa.question_generator_prompt), /visitor to this website would type/);
    assert.match(String(qa.question_generator_prompt), /Never restate the heading or the page title/);
    assert.match(String(qa.generate_answers_prompt), /only from the passage/);
  });

  it("write one short sentence to launchpad_answers", () => {
    const ask = (AGENTS[1]!.operations[0] as { ask: { destination: string; user_prompt: string } }).ask;
    assert.equal(ask.destination, ANSWERS_DESTINATION);
    assert.match(ask.user_prompt, /one sentence of at most 25 words, say what questions this page answers for a visitor/);
    assert.match(ask.user_prompt, /no preamble/);
  });

  it("name no site, product or language", () => {
    const text = JSON.stringify(AGENTS);
    assert.doesNotMatch(text, /chef|telerik|crayola|whatsup|sitefinity|english/i);
  });
});

describe("ensureAgents", () => {
  it("creates both on a bare KB, with the KB's own model", async () => {
    const { fetch, calls } = fakeKb();
    const res = await ensureAgents(client(fetch), null, NOW);
    assert.deepEqual(res.created, ["synthetic-questions", "ask"]);
    assert.deepEqual(res.tasks, [
      { name: "launchpad-questions", id: "t-1", agent: "synthetic-questions", at: NOW.toISOString() },
      { name: "launchpad-answers", id: "t-2", agent: "ask", at: NOW.toISOString() },
    ]);
    const bodies = starts(calls).map((c) => c.body as { name: string; parameters: { on: number; llm: unknown } });
    assert.deepEqual(
      bodies.map((b) => [b.name, b.parameters.on, b.parameters.llm]),
      [
        ["synthetic-questions", 1, LLM],
        ["ask", 1, LLM],
      ],
    );
  });

  it("creates nothing the second time", async () => {
    const { fetch, calls } = fakeKb();
    const first = await ensureAgents(client(fetch), null, NOW);
    const later = new Date("2026-11-01T09:00:00Z");
    const again = await ensureAgents(client(fetch), first, later);
    assert.equal(starts(calls).length, 2);
    assert.deepEqual(again, { tasks: first.tasks, created: [] });
  });

  it("adopts a task left under our name and recreates one deleted outside the console", async () => {
    const left: TaskItem = { id: "x-9", task: { name: "ask" }, parameters: { name: "launchpad-answers" } };
    const { fetch, calls } = fakeKb([left]);
    const recorded = { tasks: [{ name: "launchpad-questions", id: "gone", agent: "synthetic-questions", at: "2026-10-01T00:00:00.000Z" }] };
    const res = await ensureAgents(client(fetch), recorded, NOW);
    assert.deepEqual(res.created, ["synthetic-questions"]);
    assert.deepEqual(
      res.tasks.map((t) => t.id),
      ["t-2", "x-9"],
    );
    assert.equal(starts(calls).length, 1);
  });

  it("finds a started task's id in the listing when the API doesn't return it", async () => {
    const { fetch } = fakeKb([], { startReturnsId: false });
    const res = await ensureAgents(client(fetch), null, NOW);
    assert.deepEqual(
      res.tasks.map((t) => t.id),
      ["t-1", "t-2"],
    );
  });

  it("starts nothing when the KB's model isn't on offer", async () => {
    const { fetch, calls } = mockFetch((call) => {
      if (call.url.endsWith("/tasks")) return json({ tasks: [], configs: [], running: [], done: [] });
      if (call.url.endsWith("/schema")) return json({ generative_model: { options: [] } });
      if (call.url.endsWith("/configuration")) return json({ generative_model: "retired" });
      return json({}, 500);
    });
    await assert.rejects(ensureAgents(client(fetch), null, NOW), /retired/);
    assert.equal(starts(calls).length, 0);
  });
});

describe("nextReprocess", () => {
  const start: ReprocessState = { requestedAt: "2026-10-31T11:00:00.000Z", page: 0, sent: 0, failed: 0, total: 120 };

  it("advances a page per batch and finishes on the last", () => {
    const one = nextReprocess(start, { sent: 50, failed: 0, last: false }, NOW);
    assert.deepEqual(one, { ...start, page: 1, sent: 50 });
    const two = nextReprocess(one, { sent: 48, failed: 2, last: true, error: "429" }, NOW);
    assert.deepEqual(two, { ...start, page: 2, sent: 98, failed: 2, lastError: "429", finishedAt: NOW.toISOString() });
  });

  it("holds its place when nothing could be sent, and gives up after ten runs", () => {
    let state = nextReprocess(start, { sent: 0, failed: 50, last: false, error: "403" }, NOW);
    assert.deepEqual(state, { ...start, stalled: 1, lastError: "403" });
    for (let i = 0; i < 8; i++) state = nextReprocess(state, { sent: 0, failed: 1, last: false, error: "503" }, NOW);
    assert.equal(state.finishedAt, undefined);
    state = nextReprocess(state, { sent: 0, failed: 1, last: false, error: "503" }, NOW);
    assert.equal(state.stalled, 10);
    assert.equal(state.finishedAt, NOW.toISOString());
    assert.equal(state.page, 0);
  });

  it("clears the stall once a batch goes through", () => {
    const stalled = { ...start, stalled: 3, lastError: "503" };
    assert.deepEqual(nextReprocess(stalled, { sent: 50, failed: 0, last: false }, NOW), { ...start, page: 1, sent: 50, lastError: "503" });
  });

  it("finishes at once on an empty list", () => {
    assert.equal(nextReprocess(start, { sent: 0, failed: 0, last: true }, NOW).finishedAt, NOW.toISOString());
  });
});

describe("cleanAnswerLine", () => {
  it("keeps a good line as it is", () => {
    assert.equal(
      cleanAnswerLine("How much each plan costs, what it includes and how to start a trial."),
      "How much each plan costs, what it includes and how to start a trial.",
    );
    assert.equal(cleanAnswerLine("Wie viel kostet das Abo und wie kündige ich?"), "Wie viel kostet das Abo und wie kündige ich?");
  });

  it("strips quotes and an English opener", () => {
    assert.equal(cleanAnswerLine('"How to reach support by phone."'), "How to reach support by phone.");
    assert.equal(cleanAnswerLine("This page answers questions about opening hours."), "opening hours.");
    assert.equal(cleanAnswerLine("This page answers: when the next webinar is."), "when the next webinar is.");
  });
});
