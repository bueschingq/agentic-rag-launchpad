// Data augmentation calls: routes and bodies, and the configurations refused before sending
// because the API would accept them and then fail on every resource.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AugmentClient,
  checkTaskParameters,
  chooseLlm,
  findTask,
  generatedText,
  type TaskList,
  type TaskParameters,
  taskStatus,
} from "../src/augment.ts";
import { ParError } from "../src/errors.ts";
import { json, mockFetch } from "./helpers.ts";

const ZONE = "aws-us-east-2-1";
const KB = "00000000-0000-4000-8000-0000000000b1";
const BASE = `https://${ZONE}.dp.progress.cloud/api/v1/kb/${KB}`;
const LLM = { model: "chatgpt-azure-5.6-terra", provider: "microsoft" };

const client = (fetch: ReturnType<typeof mockFetch>["fetch"]) =>
  new AugmentClient({ zone: ZONE, kbId: KB, credential: { kind: "key", token: "manager" }, fetch });

const questions = (over: Partial<TaskParameters> = {}): TaskParameters => ({
  name: "launchpad-questions",
  on: 1,
  operations: [{ qa: { max_questions: 6, question_generator_prompt: "Questions a visitor would type." } }],
  llm: LLM,
  ...over,
});

const answers = (userPrompt: string, over: Partial<TaskParameters> = {}): TaskParameters => ({
  name: "launchpad-answers",
  on: 1,
  operations: [{ ask: { question: "What does this page answer?", destination: "launchpad_answers", user_prompt: userPrompt } }],
  llm: LLM,
  ...over,
});

describe("checkTaskParameters", () => {
  it("accepts the two pilot agents as configured", () => {
    checkTaskParameters("synthetic-questions", questions());
    checkTaskParameters("ask", answers("Q: {question}\n\n{context}"));
    checkTaskParameters("ask", answers(""));
  });

  it("refuses a task without an explicit model", () => {
    assert.throws(() => checkTaskParameters("synthetic-questions", questions({ llm: { model: "", provider: "microsoft" } })), /llm/);
    assert.throws(() => checkTaskParameters("ask", answers("{question} {context}", { llm: { model: "x", provider: " " } })), /llm/);
    assert.throws(() => checkTaskParameters("ask", { ...answers("{question} {context}"), llm: undefined as never }), /llm/);
  });

  it("refuses synthetic questions on paragraphs", () => {
    assert.throws(() => checkTaskParameters("synthetic-questions", questions({ on: 0 })), /on to 1/);
    assert.throws(() => checkTaskParameters("llm-graph", questions({ on: 0 })), /on to 1/);
  });

  it("refuses an ask prompt without its placeholders", () => {
    assert.throws(() => checkTaskParameters("ask", answers("Say what {question} asks.")), /\{context\}/);
    assert.throws(() => checkTaskParameters("ask", answers("Summarise {context}")), /\{question\}/);
    const json = answers("{question} {context}");
    (json.operations[0] as { ask: { json?: boolean } }).ask.json = true;
    assert.throws(() => checkTaskParameters("ask", json), /json/);
  });

  it("refuses a task with nothing to do", () => {
    assert.throws(() => checkTaskParameters("ask", questions({ operations: [] })), /operation/);
  });
});

describe("chooseLlm", () => {
  const models = {
    default: "claude-5-sonnet",
    options: [
      { value: "claude-5-sonnet", name: "Claude 5 Sonnet", provider: "claude3" },
      { value: "chatgpt-azure-5.6-terra", name: "GPT-5.6 Terra", provider: "microsoft" },
    ],
  };

  it("uses the KB's configured model with its provider", () => {
    assert.deepEqual(chooseLlm(models, "chatgpt-azure-5.6-terra"), LLM);
  });

  it("falls back to the schema's default", () => {
    assert.deepEqual(chooseLlm(models, "retired-model"), { model: "claude-5-sonnet", provider: "claude3" });
    assert.deepEqual(chooseLlm(models), { model: "claude-5-sonnet", provider: "claude3" });
  });

  it("refuses when neither is on offer", () => {
    assert.throws(() => chooseLlm({ options: [] }, "retired-model"), /retired-model/);
  });
});

describe("task listing helpers", () => {
  const list: TaskList = {
    tasks: [{ name: "ask" }],
    configs: [
      { id: "t-1", task: { name: "synthetic-questions" }, parameters: { name: "launchpad-questions" } },
      { id: "t-2", task: { name: "ask" }, parameters: { name: "launchpad-answers" } },
    ],
    running: [{ id: "t-1", task: { name: "synthetic-questions" }, parameters: { name: "launchpad-questions" } }],
    done: [{ id: "t-2" }, { id: "t-3", task: { name: "ask" }, parameters: { name: "old-summary" } }],
  };

  it("reports each task's state", () => {
    assert.equal(taskStatus(list, "t-1"), "running");
    assert.equal(taskStatus(list, "t-2"), "configured");
    assert.equal(taskStatus(list, "t-3"), "done");
    assert.equal(taskStatus(list, "t-9"), "missing");
  });

  it("finds a configured task by agent and name, not a finished one", () => {
    assert.equal(findTask(list, "ask", "launchpad-answers")?.id, "t-2");
    assert.equal(findTask(list, "synthetic-questions", "launchpad-answers"), undefined);
    assert.equal(findTask(list, "ask", "old-summary"), undefined);
  });

  it("reads a generated field whatever its source suffix", () => {
    assert.equal(
      generatedText(
        { body: { value: { body: "page" } }, "da-launchpad_answers-t-body": { value: { body: " Prices. " } } },
        "launchpad_answers",
      ),
      "Prices.",
    );
    assert.equal(generatedText({ "da-launchpad_answers-u-link": { value: { body: "Hours." } } }, "launchpad_answers"), "Hours.");
    assert.equal(
      generatedText({ "da-other-t-body": { value: { body: "x" } }, "da-launchpad_answers-t-body": { value: {} } }, "launchpad_answers"),
      undefined,
    );
    assert.equal(generatedText(undefined, "launchpad_answers"), undefined);
  });
});

describe("AugmentClient", () => {
  it("starts a task with the agent's name and its parameters nested", async () => {
    const { fetch, calls } = mockFetch(() => json({ id: "t-1" }));
    const res = await client(fetch).startTask("synthetic-questions", questions());
    assert.equal(res.id, "t-1");
    assert.equal(calls[0]!.method, "POST");
    assert.equal(calls[0]!.url, `${BASE}/task/start`);
    assert.equal(calls[0]!.headers["X-NUCLIA-SERVICEACCOUNT"], "Bearer manager");
    assert.deepEqual(calls[0]!.body, { name: "synthetic-questions", parameters: questions() });
  });

  it("sends nothing for a task that would fail silently", async () => {
    const { fetch, calls } = mockFetch(() => json({ id: "t-1" }));
    await assert.rejects(client(fetch).startTask("synthetic-questions", questions({ on: 0 })), /on to 1/);
    await assert.rejects(client(fetch).startTask("ask", answers("no placeholders")), /\{context\}/);
    assert.equal(calls.length, 0);
  });

  it("lists tasks, filling buckets the API leaves out", async () => {
    const { fetch, calls } = mockFetch(() => json({ tasks: [{ name: "ask" }], configs: [{ id: "t-1" }] }));
    const list = await client(fetch).listTasks();
    assert.equal(calls[0]!.url, `${BASE}/tasks`);
    assert.deepEqual(list, { tasks: [{ name: "ask" }], configs: [{ id: "t-1" }], running: [], done: [] });
  });

  it("stops and deletes a task; a deleted one counts as done", async () => {
    const { fetch, calls } = mockFetch((call) =>
      call.method === "DELETE" && call.url.endsWith("/gone") ? json({ detail: "Not found" }, 404) : json({}),
    );
    const kb = client(fetch);
    await kb.stopTask("t-1");
    await kb.deleteTask("t-1");
    await kb.deleteTask("gone");
    assert.deepEqual(
      calls.map((c) => `${c.method} ${c.url.replace(BASE, "")}`),
      ["POST /task/t-1/stop", "DELETE /task/t-1", "DELETE /task/gone"],
    );
  });

  it("passes other refusals on", async () => {
    const { fetch } = mockFetch(() => json({ detail: "Forbidden" }, 403));
    await assert.rejects(client(fetch).deleteTask("t-1"), (err: unknown) => err instanceof ParError && err.status === 403);
  });

  it("reads the model options from the schema, top level or under properties", async () => {
    const option = {
      name: "GPT-5.6 Terra",
      description: null,
      value: "chatgpt-azure-5.6-terra",
      provider: "microsoft",
      user_key: "azure_openai",
    };
    const top = mockFetch(() =>
      json({ semantic_model: {}, generative_model: { default: "chatgpt-azure-5.6-terra", options: [option, { name: "broken" }] } }),
    );
    assert.deepEqual(await client(top.fetch).generativeModels(), { default: "chatgpt-azure-5.6-terra", options: [option] });
    assert.equal(top.calls[0]!.url, `${BASE}/schema`);
    const nested = mockFetch(() => json({ properties: { generative_model: { options: [option] } } }));
    assert.deepEqual(await client(nested.fetch).generativeModels(), { options: [option] });
  });

  it("reads the KB's configured model", async () => {
    const { fetch, calls } = mockFetch(() => json({ generative_model: "chatgpt-azure-5.6-terra", semantic_model: "x" }));
    assert.equal(await client(fetch).configuredModel(), "chatgpt-azure-5.6-terra");
    assert.equal(calls[0]!.url, `${BASE}/configuration`);
    const none = mockFetch(() => json({ generative_model: "" }));
    assert.equal(await client(none.fetch).configuredModel(), undefined);
  });

  it("reprocesses one resource", async () => {
    const { fetch, calls } = mockFetch(() => json({ seqid: 7 }, 202));
    await client(fetch).reprocessResource("r1");
    assert.equal(calls[0]!.method, "POST");
    assert.equal(calls[0]!.url, `${BASE}/resource/r1/reprocess`);
  });

  it("pages through resource ids", async () => {
    const { fetch, calls } = mockFetch(() =>
      json({ resources: [{ id: "r1", slug: "a" }, { id: "r2" }], pagination: { page: 3, size: 2, last: false } }),
    );
    assert.deepEqual(await client(fetch).listResources({ page: 3, size: 2 }), { ids: ["r1", "r2"], last: false });
    assert.equal(calls[0]!.url, `${BASE}/resources?page=3&size=2`);
    const short = mockFetch(() => json({ resources: [{ id: "r9" }] }));
    assert.deepEqual(await client(short.fetch).listResources({ page: 4, size: 2 }), { ids: ["r9"], last: true });
  });

  it("reads a resource's generated text from its text fields", async () => {
    const { fetch, calls } = mockFetch(() =>
      json({
        id: "r1",
        data: {
          texts: { body: { value: { body: "Long page" } }, "da-launchpad_answers-t-body": { value: { body: "Plans and prices." } } },
        },
      }),
    );
    assert.equal(await client(fetch).readGeneratedText("r1", "launchpad_answers"), "Plans and prices.");
    assert.equal(calls[0]!.url, `${BASE}/resource/r1?show=values&field_type=text`);
  });
});
