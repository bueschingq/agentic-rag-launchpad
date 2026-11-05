// Data augmentation (DA) agents on a Knowledge Box: agents that run over every resource as it is
// processed and write back onto it (synthetic questions, a generated text field). Authenticated
// with the KB's manager key.
//
// The API accepts several configurations that then fail silently, every resource stuck or empty,
// so startTask refuses them before sending (checkTaskParameters):
//   - a task does not inherit the KB's generative model: without `llm` every resource fails;
//   - `synthetic-questions` and `llm-graph` only run on whole fields (`on: 1`);
//   - an `ask` prompt must hold {context}, and {question} when a question is set.
// Agents only apply as resources are processed: existing ones need reprocessResource.
//
// Shapes read live on 2026-10-31 (a review KB, read-only): /schema puts generative_model at the
// top level (older zones nest it under `properties`), each option is {value, name, provider, …},
// and /configuration names the KB's own model. /tasks has the buckets tasks (agent definitions),
// configs, running and done; the shape of a configured task is from the DA skill, not yet seen.

import type { Credential } from "./credentials.ts";
import { ParError } from "./errors.ts";
import { type FetchLike, requestJson, send, zoneApi } from "./http.ts";

export type AgentName = "synthetic-questions" | "ask" | "labeler" | "llm-graph" | "llama-guard" | "prompt-guard" | (string & {});

// The model a task runs on: an option's `value` and `provider` from the KB schema.
export interface LlmChoice {
  model: string;
  provider: string;
}

// synthetic-questions: question and answer pairs per chunk, indexed but not exposed.
export interface QaOperation {
  max_questions?: number;
  system_question_generator_prompt?: string;
  question_generator_prompt?: string;
  generate_answers_prompt?: string;
  summary_prompt?: string;
}

// ask: a prompt run over each field, written to a new text field `da-{destination}-{suffix}`.
export interface AskOperation {
  question: string;
  destination: string;
  json?: boolean;
  // Must hold {context}, and {question} when `question` is set. Empty uses the default prompt.
  user_prompt?: string;
}

export type TaskOperation = { qa: QaOperation } | { ask: AskOperation } | Record<string, unknown>;

export interface TaskParameters {
  // Our name for the task, shown in /tasks.
  name: string;
  // 0: each paragraph, 1: whole fields.
  on: 0 | 1;
  filter?: Record<string, unknown> | null;
  operations: TaskOperation[];
  llm: LlmChoice;
}

// One task as /tasks lists it.
export interface TaskItem {
  id: string;
  task?: { name: AgentName; [key: string]: unknown };
  parameters?: Partial<TaskParameters> & Record<string, unknown>;
  [key: string]: unknown;
}

export interface TaskList {
  // The agents this KB offers, each with the JSON Schema of its parameters.
  tasks: { name: AgentName; description?: string | null; validation?: unknown }[];
  configs: TaskItem[];
  running: TaskItem[];
  done: TaskItem[];
}

export type TaskStatus = "running" | "configured" | "done" | "missing";

export interface GenerativeModel {
  value: string;
  name: string;
  provider: string;
  [key: string]: unknown;
}

// Refuses the configurations the API would accept and then fail on silently. Throws, naming the fix.
export function checkTaskParameters(agent: AgentName, params: TaskParameters): void {
  if (!params.llm?.model?.trim() || !params.llm.provider?.trim()) {
    throw new Error("Set llm {model, provider} explicitly: a task without it fails on every resource.");
  }
  if ((agent === "synthetic-questions" || agent === "llm-graph") && params.on !== 1) {
    throw new Error(`${agent} only runs on whole fields: set on to 1.`);
  }
  if (!params.operations?.length) throw new Error("A task needs at least one operation.");
  for (const op of params.operations) {
    const ask = (op as { ask?: AskOperation }).ask;
    if (!ask) continue;
    if (!ask.question?.trim() || !ask.destination?.trim()) throw new Error("An ask operation needs a question and a destination.");
    const prompt = ask.user_prompt ?? "";
    if (!prompt) continue;
    if (ask.json) throw new Error("An ask operation with json can't take a user_prompt.");
    if (!prompt.includes("{context}")) throw new Error("An ask prompt must contain {context}.");
    if (!prompt.includes("{question}")) throw new Error("An ask prompt with a question must contain {question}.");
  }
}

// The KB's own model, as a task's llm: the configured one if the schema offers it, else the
// schema's default. Throws when neither is on offer, rather than start a task that fails.
export function chooseLlm(models: { default?: string; options: GenerativeModel[] }, configured?: string): LlmChoice {
  for (const value of [configured, models.default]) {
    const option = value ? models.options.find((o) => o.value === value) : undefined;
    if (option?.provider) return { model: option.value, provider: option.provider };
  }
  throw new Error(`The Knowledge Box's generative model (${configured ?? models.default ?? "none"}) isn't among the schema's options.`);
}

// Where a task stands in a /tasks listing.
export function taskStatus(list: TaskList, id: string): TaskStatus {
  if (list.running.some((t) => t.id === id)) return "running";
  if (list.configs.some((t) => t.id === id)) return "configured";
  if (list.done.some((t) => t.id === id)) return "done";
  return "missing";
}

// A configured (or running) task with our name for the agent, so a second run reuses it.
export function findTask(list: TaskList, agent: AgentName, name: string): TaskItem | undefined {
  return [...list.configs, ...list.running].find((t) => t.parameters?.name === name && (!t.task?.name || t.task.name === agent));
}

// The generated text an ask agent wrote with this destination: the field id's suffix depends on
// the source field (da-x-t-body for a text field, da-x-u-link for a link), so match the prefix.
export function generatedText(texts: Record<string, { value?: { body?: string } }> | undefined, destination: string): string | undefined {
  const prefix = `da-${destination}-`;
  for (const [id, field] of Object.entries(texts ?? {})) {
    const body = field.value?.body?.trim();
    if (id.startsWith(prefix) && body) return body;
  }
  return undefined;
}

export class AugmentClient {
  readonly zone: string;
  readonly kbId: string;
  readonly #credential: Credential;
  readonly #fetch: FetchLike | undefined;

  constructor(opts: { zone: string; kbId: string; credential: Credential; fetch?: FetchLike }) {
    this.zone = opts.zone;
    this.kbId = opts.kbId;
    this.#credential = opts.credential;
    this.#fetch = opts.fetch;
  }

  get baseUrl(): string {
    return `${zoneApi(this.zone)}/kb/${this.kbId}`;
  }

  // ---- tasks ----

  async listTasks(): Promise<TaskList> {
    const res = await requestJson<Partial<TaskList>>(`${this.baseUrl}/tasks`, this.#opts());
    return { tasks: res?.tasks ?? [], configs: res?.configs ?? [], running: res?.running ?? [], done: res?.done ?? [] };
  }

  // Creates the task and starts it; it then applies to every resource processed from here on.
  async startTask(agent: AgentName, params: TaskParameters): Promise<{ id?: string; [key: string]: unknown }> {
    checkTaskParameters(agent, params);
    const res = await requestJson<{ id?: string } | undefined>(`${this.baseUrl}/task/start`, {
      ...this.#opts(),
      body: { name: agent, parameters: params },
    });
    return res ?? {};
  }

  async stopTask(id: string): Promise<void> {
    const res = await send(`${this.baseUrl}/task/${encodeURIComponent(id)}/stop`, { ...this.#opts(), method: "POST" });
    await res.body?.cancel();
  }

  // Gone already counts as done.
  async deleteTask(id: string): Promise<void> {
    try {
      const res = await send(`${this.baseUrl}/task/${encodeURIComponent(id)}`, { ...this.#opts(), method: "DELETE" });
      await res.body?.cancel();
    } catch (err) {
      if (!(err instanceof ParError && err.status === 404)) throw err;
    }
  }

  // ---- models ----

  async generativeModels(): Promise<{ default?: string; options: GenerativeModel[] }> {
    const schema = await requestJson<Record<string, unknown>>(`${this.baseUrl}/schema`, this.#opts());
    const props = (schema?.properties as Record<string, unknown> | undefined) ?? schema ?? {};
    const gm = props.generative_model as { default?: unknown; options?: unknown } | undefined;
    const options = (Array.isArray(gm?.options) ? gm.options : []).filter(
      (o): o is GenerativeModel => typeof o?.value === "string" && typeof o?.provider === "string",
    );
    return { ...(typeof gm?.default === "string" && { default: gm.default }), options };
  }

  // The generative model the KB answers with (its configuration's generative_model).
  async configuredModel(): Promise<string | undefined> {
    const config = await requestJson<{ generative_model?: unknown }>(`${this.baseUrl}/configuration`, this.#opts());
    return typeof config?.generative_model === "string" && config.generative_model ? config.generative_model : undefined;
  }

  // ---- resources ----

  // Sends one resource through processing again, so the agents apply to it.
  async reprocessResource(rid: string): Promise<void> {
    const res = await send(`${this.baseUrl}/resource/${encodeURIComponent(rid)}/reprocess`, { ...this.#opts(), method: "POST" });
    await res.body?.cancel();
  }

  // One page of the KB's resources (ids only), in the API's stable order.
  async listResources(q: { page: number; size: number }): Promise<{ ids: string[]; last: boolean }> {
    const res = await requestJson<{ resources?: { id: string }[]; pagination?: { last?: boolean } }>(`${this.baseUrl}/resources`, {
      ...this.#opts(),
      query: { page: q.page, size: q.size },
    });
    const ids = (res?.resources ?? []).map((r) => r.id);
    return { ids, last: res?.pagination?.last ?? ids.length < q.size };
  }

  // The text an ask agent wrote on a resource for this destination, if it has run there.
  async readGeneratedText(rid: string, destination: string): Promise<string | undefined> {
    const res = await requestJson<{ data?: { texts?: Record<string, { value?: { body?: string } }> } }>(
      `${this.baseUrl}/resource/${encodeURIComponent(rid)}`,
      { ...this.#opts(), query: { show: ["values"], field_type: ["text"] } },
    );
    return generatedText(res?.data?.texts, destination);
  }

  #opts() {
    return { credential: this.#credential, fetch: this.#fetch };
  }
}
