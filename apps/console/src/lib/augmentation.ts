// The Agentic RAG agents pilot (docs/ANSWER-QUALITY-PLAN.md, "The DA agent pilot"): two data
// augmentation agents on a deployment's Knowledge Box, created by the console with the KB's own
// generative model.
//
//   synthetic-questions   the questions a visitor would type, per passage, indexed beside it
//   ask                   one sentence per page saying what it answers: field da-launchpad_answers-*
//
// The account setting turns them on for new deployments, created before the first sync so they
// apply as pages are processed (provisioning.ts). The deployment page turns them on for an
// existing one: its pages are then sent through processing again, a batch a minute, by the
// worker's augment job (reprocessPending). What the console created is kept in
// deployments.augmentation, so every step can run again without creating anything twice.

import { type Augmentation, auditLog, contentPages, deployments, loadKey } from "@launchpad/db";
import {
  AugmentClient,
  chooseLlm,
  findTask,
  KbClient,
  type LlmChoice,
  type TaskOperation,
  type TaskParameters,
  type TaskStatus,
  taskStatus,
} from "@launchpad/par-client";
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { saveGeneratedExclusion } from "./answers.ts";
import { db } from "./db.ts";
import { env } from "./env.ts";
import { withSetupName } from "./setup-name.ts";

export const ANSWERS_DESTINATION = "launchpad_answers";

export interface AgentSpec {
  agent: "synthetic-questions" | "ask";
  // Our name for the task in Agentic RAG, which a second run looks for.
  name: string;
  // As the deployment page names it.
  label: string;
  operations: TaskOperation[];
}

// Site-agnostic: nothing here names a customer, a product or a language.
export const AGENTS: AgentSpec[] = [
  {
    agent: "synthetic-questions",
    name: "launchpad-questions",
    label: "Visitor questions",
    operations: [
      {
        qa: {
          max_questions: 6,
          system_question_generator_prompt:
            "You write the questions that visitors to a website type into the site's chat assistant: short and plain, in the visitor's own words, in the language of the passage.",
          question_generator_prompt:
            "Read this passage from a page of the website. Write up to 6 questions a visitor to this website would type that the passage answers: what something costs or includes, how to do something, who to contact, where or when something happens. Use the words a visitor would use, not the page's own headings. Never restate the heading or the page title as a question, and leave out anything the passage doesn't answer.",
          generate_answers_prompt:
            "Answer each question only from the passage, in one or two sentences. Keep figures, units, dates, names and links exactly as the passage writes them. If the passage answers a question only in part, say what it does state and stop. Never add anything the passage doesn't say.",
        },
      },
    ],
  },
  {
    agent: "ask",
    name: "launchpad-answers",
    label: "What each page answers",
    operations: [
      {
        ask: {
          question: "What questions does this page answer for a visitor?",
          destination: ANSWERS_DESTINATION,
          json: false,
          user_prompt:
            'Below is a page from a website.\n\n{question}\n\nIn one sentence of at most 25 words, say what questions this page answers for a visitor, in the language the page is written in. Begin with the first question itself: no preamble, no "This page", no title, no quotation marks, no list.\n\nPage:\n{context}',
        },
      },
    ],
  },
];

// Both agents run on whole fields: synthetic-questions only accepts that, and "what this page
// answers" is about the page, not one paragraph.
export const agentParameters = (spec: AgentSpec, llm: LlmChoice): TaskParameters => ({
  name: spec.name,
  on: 1,
  operations: spec.operations,
  llm,
});

// Existing pages sent through processing again after the agents were turned on.
export interface ReprocessState {
  requestedAt: string;
  // The next page of the KB's resource list to send, in pages of REPROCESS_BATCH.
  page: number;
  sent: number;
  failed: number;
  // The KB's resources when it started, for "120 of 480".
  total?: number;
  // Runs in a row where nothing could be sent; at STALL_LIMIT it stops with lastError.
  stalled?: number;
  lastError?: string;
  finishedAt?: string;
}

// deployments.augmentation as this file writes it: the tasks, plus the reprocess's progress.
export interface AugmentationRecord extends Augmentation {
  reprocess?: ReprocessState;
}

export const REPROCESS_BATCH = 50;
const STALL_LIMIT = 10;

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

// ---- the account setting ----

// "Improve answers with Agentic RAG agents (pilot)": off by default. It lives in the settings row,
// in a column the schema doesn't declare yet (settings.augment_new_deployments, boolean, default
// false). Until that column exists the setting reads as off and saving it says so.
const SETTING = sql.raw("augment_new_deployments");

function missingColumn(err: unknown): boolean {
  let e: unknown = err;
  for (let depth = 0; depth < 4 && e && typeof e === "object"; depth++) {
    if ((e as { code?: unknown }).code === "42703") return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

export async function augmentNewDeployments(): Promise<boolean> {
  try {
    const rows = await db().execute(sql`select ${SETTING} as "on" from settings where id = 1`);
    return (rows[0] as { on?: unknown } | undefined)?.on === true;
  } catch (err) {
    if (missingColumn(err)) return false;
    throw err;
  }
}

// Whether the setting can be stored yet (the column exists).
export async function augmentSettingStored(): Promise<boolean> {
  try {
    await db().execute(sql`select ${SETTING} from settings limit 1`);
    return true;
  } catch (err) {
    if (missingColumn(err)) return false;
    throw err;
  }
}

export async function saveAugmentNewDeployments(on: boolean, actor: string | null): Promise<"saved" | "needs-column"> {
  try {
    const before = await augmentNewDeployments();
    await db().execute(
      sql`insert into settings (id, ${SETTING}) values (1, ${on}) on conflict (id) do update set ${SETTING} = excluded.${SETTING}, updated_at = now()`,
    );
    await db()
      .insert(auditLog)
      .values(
        await withSetupName({
          actorUserId: actor,
          action: "settings.augmentation",
          targetType: "settings",
          targetId: "1",
          detail: { before, after: on },
        }),
      );
    return "saved";
  } catch (err) {
    if (missingColumn(err)) return "needs-column";
    throw err;
  }
}

// ---- the agents on one KB ----

// The KB's own generative model, as the tasks' llm: a task doesn't inherit it, and without one
// every resource fails.
export async function kbLlm(client: AugmentClient): Promise<LlmChoice> {
  const [models, configured] = await Promise.all([client.generativeModels(), client.configuredModel().catch(() => undefined)]);
  return chooseLlm(models, configured);
}

// Both agents on the KB: a task already there (recorded here, or found under our name) is kept,
// a missing one is created. Returns the tasks and the agents it created.
export async function ensureAgents(
  client: AugmentClient,
  recorded: Augmentation | null | undefined,
  now: Date,
): Promise<{ tasks: Augmentation["tasks"]; created: AgentSpec["agent"][] }> {
  const list = await client.listTasks();
  const live = [...list.configs, ...list.running];
  const tasks: Augmentation["tasks"] = [];
  const created: AgentSpec["agent"][] = [];
  let llm: LlmChoice | undefined;
  for (const spec of AGENTS) {
    const prior = recorded?.tasks.find((t) => t.name === spec.name && t.agent === spec.agent);
    const existing = (prior && live.find((t) => t.id === prior.id)) ?? findTask(list, spec.agent, spec.name);
    if (existing) {
      tasks.push({ name: spec.name, id: existing.id, agent: spec.agent, at: prior?.id === existing.id ? prior.at : now.toISOString() });
      continue;
    }
    llm ??= await kbLlm(client);
    const started = await client.startTask(spec.agent, agentParameters(spec, llm));
    const id = started.id ?? findTask(await client.listTasks(), spec.agent, spec.name)?.id;
    if (!id) throw new Error(`Agentic RAG started ${spec.agent} but didn't return its id.`);
    tasks.push({ name: spec.name, id, agent: spec.agent, at: now.toISOString() });
    created.push(spec.agent);
  }
  return { tasks, created };
}

type DeploymentRow = { id: string; zone: string; kbId: string | null; augmentation: Augmentation | null };

async function managerKey(d: DeploymentRow): Promise<string> {
  if (!d.kbId) throw new Error("This deployment has no Knowledge Box yet.");
  const key = await loadKey(db(), env().masterKey, d.id, "manager");
  if (!key) throw new Error("This deployment has no manager key.");
  return key;
}

async function augmentClient(d: DeploymentRow): Promise<AugmentClient> {
  const token = await managerKey(d);
  return new AugmentClient({ zone: d.zone, kbId: d.kbId!, credential: { kind: "key", token } });
}

async function loadRow(deploymentId: string): Promise<DeploymentRow | undefined> {
  const [d] = await db()
    .select({ id: deployments.id, zone: deployments.zone, kbId: deployments.kbId, augmentation: deployments.augmentation })
    .from(deployments)
    .where(eq(deployments.id, deploymentId));
  return d;
}

// One run per deployment at a time in this process, so a double click creates nothing twice.
const running = new Map<string, Promise<AugmentationRecord>>();

// Creates the two agents on the deployment's KB (those missing) and records them. When it
// creates one on a KB that already holds pages, those pages are queued to be processed again.
// The KB's saved search configurations are then re-saved to keep the agents' generated text out
// of retrieval and citation (the pilot: citing it made answers worse). Safe to run again.
export function augmentDeployment(deploymentId: string, opts: { actor?: string | null; now?: Date } = {}): Promise<AugmentationRecord> {
  const pending = running.get(deploymentId);
  if (pending) return pending;
  const run = (async () => {
    const now = opts.now ?? new Date();
    const d = await loadRow(deploymentId);
    if (!d) throw new Error("Deployment not found.");
    const client = await augmentClient(d);
    const recorded = d.augmentation as AugmentationRecord | null;
    const { tasks, created } = await ensureAgents(client, recorded, now);
    let reprocess = recorded?.reprocess;
    if (created.length) {
      // A new KB holds nothing yet; when the count can't be read, the worker finds out.
      const kb = new KbClient({ zone: d.zone, kbId: d.kbId!, credential: { kind: "key", token: await managerKey(d) } });
      const total = await kb
        .counters()
        .then((c) => c.resources)
        .catch(() => undefined);
      reprocess = total === 0 ? undefined : { requestedAt: now.toISOString(), page: 0, sent: 0, failed: 0, ...(total && { total }) };
    }
    const record: AugmentationRecord = { tasks, ...(reprocess && { reprocess }) };
    await db().update(deployments).set({ augmentation: record }).where(eq(deployments.id, deploymentId));
    if (created.length) {
      await db()
        .insert(auditLog)
        .values(
          await withSetupName({
            actorUserId: opts.actor ?? null,
            action: "deployment.augment",
            targetType: "deployment",
            targetId: deploymentId,
            detail: { created, tasks: tasks.map((t) => `${t.agent}: ${t.id}`), reprocess: reprocess?.total ?? 0 },
          }),
        );
    }
    await saveGeneratedExclusion(deploymentId);
    return record;
  })().finally(() => running.delete(deploymentId));
  running.set(deploymentId, run);
  return run;
}

// Stops and deletes the console's agents on the KB and forgets them. What they already wrote
// stays on each page until the page is processed again; the saved search configurations are
// re-saved without the generated-text exclusion.
export async function removeAugmentation(deploymentId: string, actor: string | null): Promise<void> {
  const d = await loadRow(deploymentId);
  if (!d?.augmentation) return;
  const client = await augmentClient(d);
  const list = await client.listTasks();
  const ids = new Set(d.augmentation.tasks.map((t) => t.id));
  for (const spec of AGENTS) {
    const found = findTask(list, spec.agent, spec.name);
    if (found) ids.add(found.id);
  }
  for (const id of ids) {
    // A task that isn't running may refuse to stop; deleting it is what counts.
    if (taskStatus(list, id) !== "missing") await client.stopTask(id).catch(() => undefined);
    await client.deleteTask(id);
  }
  await db().update(deployments).set({ augmentation: null }).where(eq(deployments.id, deploymentId));
  await saveGeneratedExclusion(deploymentId);
  await db()
    .insert(auditLog)
    .values(
      await withSetupName({
        actorUserId: actor,
        action: "deployment.augment-off",
        targetType: "deployment",
        targetId: deploymentId,
        detail: { removed: [...ids] },
      }),
    );
}

// ---- status, for the deployment page and the pilot report ----

export interface AugmentationView {
  on: boolean;
  tasks: (Augmentation["tasks"][number] & { label: string; status: TaskStatus | "unknown"; model?: string })[];
  reprocess?: ReprocessState;
  // The KB's task list couldn't be read: the tasks are as recorded, their status unknown.
  problem?: string;
}

export async function augmentationFor(deploymentId: string): Promise<AugmentationView> {
  const d = await loadRow(deploymentId);
  const record = d?.augmentation as AugmentationRecord | null | undefined;
  if (!d || !record) return { on: false, tasks: [] };
  const label = (agent: string) => AGENTS.find((a) => a.agent === agent)?.label ?? agent;
  try {
    const list = await (await augmentClient(d)).listTasks();
    const items = [...list.running, ...list.configs, ...list.done];
    return {
      on: true,
      tasks: record.tasks.map((t) => {
        const model = items.find((i) => i.id === t.id)?.parameters?.llm?.model;
        return { ...t, label: label(t.agent), status: taskStatus(list, t.id), ...(model && { model }) };
      }),
      ...(record.reprocess && { reprocess: record.reprocess }),
    };
  } catch (err) {
    return {
      on: true,
      tasks: record.tasks.map((t) => ({ ...t, label: label(t.agent), status: "unknown" as const })),
      ...(record.reprocess && { reprocess: record.reprocess }),
      problem: message(err),
    };
  }
}

// ---- reprocessing existing pages (the worker's augment job) ----

// The next state after one batch: advance on any success, hold on a batch where nothing could be
// sent (a refusal or an outage), and stop after STALL_LIMIT such runs. Pure.
export function nextReprocess(
  state: ReprocessState,
  batch: { sent: number; failed: number; last: boolean; error?: string },
  now: Date,
): ReprocessState {
  const lastError = batch.error ?? state.lastError;
  if (batch.sent === 0 && batch.failed > 0) {
    const stalled = (state.stalled ?? 0) + 1;
    return { ...state, stalled, ...(lastError && { lastError }), ...(stalled >= STALL_LIMIT && { finishedAt: now.toISOString() }) };
  }
  const { stalled: _, ...rest } = state;
  return {
    ...rest,
    page: state.page + 1,
    sent: state.sent + batch.sent,
    failed: state.failed + batch.failed,
    ...(lastError && { lastError }),
    ...(batch.last && { finishedAt: now.toISOString() }),
  };
}

// One batch for every deployment with a reprocess under way. Returns a log line per deployment.
export async function reprocessPending(now = new Date(), batch = REPROCESS_BATCH): Promise<string[]> {
  const due = await db()
    .select({ id: deployments.id, zone: deployments.zone, kbId: deployments.kbId, augmentation: deployments.augmentation })
    .from(deployments)
    .where(
      and(
        isNotNull(deployments.kbId),
        inArray(deployments.status, ["live", "paused"]),
        sql`${deployments.augmentation} -> 'reprocess' is not null`,
        sql`${deployments.augmentation} -> 'reprocess' ->> 'finishedAt' is null`,
      ),
    );
  const lines: string[] = [];
  for (const d of due) {
    const state = (d.augmentation as AugmentationRecord).reprocess!;
    let result: { sent: number; failed: number; last: boolean; error?: string };
    try {
      const client = await augmentClient(d);
      const page = await client.listResources({ page: state.page, size: batch });
      result = { sent: 0, failed: 0, last: page.last };
      for (const rid of page.ids) {
        try {
          await client.reprocessResource(rid);
          result.sent++;
        } catch (err) {
          result.failed++;
          result.error = message(err);
        }
      }
    } catch (err) {
      result = { sent: 0, failed: 1, last: false, error: message(err) };
    }
    const next = nextReprocess(state, result, now);
    // Only onto the same request: turning the agents off (or on again) meanwhile wins.
    await db()
      .update(deployments)
      .set({ augmentation: sql`jsonb_set(${deployments.augmentation}, '{reprocess}', ${JSON.stringify(next)}::jsonb)` })
      .where(and(eq(deployments.id, d.id), sql`${deployments.augmentation} -> 'reprocess' ->> 'requestedAt' = ${state.requestedAt}`));
    lines.push(
      `${d.id}: page ${state.page}, ${result.sent} sent${result.failed ? `, ${result.failed} failed (${result.error})` : ""}${next.finishedAt ? `; finished, ${next.sent} in all` : ""}`,
    );
  }
  return lines;
}

// ---- "what this page answers", for the pages panel's search ----

// Strips what generators add despite the prompt: quotes, and an English "This page answers" opener.
export function cleanAnswerLine(text: string): string {
  return text
    .trim()
    .replace(/^["'“‘]+|["'”’]+$/g, "")
    .replace(/^this page (answers|explains|covers)( (the )?questions?( about| on)?)?:?\s*/i, "")
    .trim();
}

const ANSWERS_TTL_MS = 10 * 60_000;
const answersCache = new Map<string, Map<string, { text: string; at: number }>>();

// The generated "what this page answers" sentence of each synced page that has one, by page URL.
// Empty at once when the agents aren't on. Read from the KB a page at a time (six at once) and
// kept for ten minutes; pass `urls` to read only those pages.
export async function pageAnswers(deploymentId: string, opts: { urls?: string[]; fresh?: boolean } = {}): Promise<Record<string, string>> {
  const d = await loadRow(deploymentId);
  if (!d?.kbId || !d.augmentation?.tasks.some((t) => t.agent === "ask")) return {};
  const pages = await db()
    .select({ url: contentPages.url, rid: contentPages.resourceId })
    .from(contentPages)
    .where(
      and(
        eq(contentPages.deploymentId, deploymentId),
        eq(contentPages.status, "indexed"),
        isNotNull(contentPages.resourceId),
        ...(opts.urls ? [inArray(contentPages.url, opts.urls.length ? opts.urls : [""])] : []),
      ),
    );
  const cache = answersCache.get(deploymentId) ?? new Map<string, { text: string; at: number }>();
  answersCache.set(deploymentId, cache);
  const now = Date.now();
  const todo = pages.filter((p) => opts.fresh || !(cache.get(p.url) && now - cache.get(p.url)!.at < ANSWERS_TTL_MS));
  if (todo.length) {
    const client = await augmentClient(d);
    let next = 0;
    const worker = async () => {
      while (next < todo.length) {
        const p = todo[next++]!;
        try {
          const text = await client.readGeneratedText(p.rid!, ANSWERS_DESTINATION);
          cache.set(p.url, { text: text ? cleanAnswerLine(text) : "", at: now });
        } catch {
          // Left out this time, tried again on the next call.
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(6, todo.length) }, worker));
  }
  const out: Record<string, string> = {};
  for (const p of pages) {
    const text = cache.get(p.url)?.text;
    if (text) out[p.url] = text;
  }
  return out;
}
