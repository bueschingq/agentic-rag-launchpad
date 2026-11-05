// How a deployment answers, after provisioning: its system prompt and answer language, saved to
// the KB's search configuration with every version kept; a draft prompt tried against the real
// KB before saving (a partner test); and checks that the KB still holds what the console saved,
// and the console's current answering rules.

import {
  auditLog,
  type Confirmation,
  credentials,
  deployments,
  type KeyRoleName,
  loadKey,
  type PriceTable,
  type PriceTableConfirmation,
  promptVersions,
  tenants,
  users,
} from "@launchpad/db";
import { KbClient } from "@launchpad/par-client";
import { intentConfigName, type LanguageSetting, ROUTE_INTENTS, type RouteIntent, withoutToday } from "@launchpad/theme";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { eventsForPrompt, keyPageResources } from "./content.ts";
import { labelFilter } from "./content-plan.ts";
import { db } from "./db.ts";
import { env } from "./env.ts";
import {
  ANSWERING_RULES,
  ANSWERING_RULES_CHANGES,
  composeSystemPrompt,
  composeUserPrompt,
  excludesGenerated,
  intentSearchConfig,
  PRICES_LIST_START,
  pricesParagraph,
  SEARCH_CONFIG,
  searchConfigFor,
  withGeneratedExclusion,
  withPricesParagraph,
} from "./prompt.ts";
import { visitorName } from "./prompt-templates.ts";
import { withSetupName } from "./setup-name.ts";
import { answerSources, promptPrices } from "./validation-rules.ts";

// An intent's label filter, with its key pages' resource ids while pages sent before labels exist.
export async function intentFilter(deploymentId: string, intent: RouteIntent): Promise<{ field: Record<string, unknown> }> {
  const resources = await keyPageResources(deploymentId, intent).catch(() => []);
  return labelFilter(intent, resources);
}

// The intent configurations under the latest rules, as saved beside the default one; without the
// agents' generated text while the deployment has them on. The events one lists the site's upcoming
// events (prompt.ts eventsParagraph; the worker refreshes it daily, jobs/prompt-date.ts).
export async function intentSearchConfigs(
  d: {
    id: string;
    systemPrompt: string;
    language: string;
    augmentation?: unknown;
    priceTable?: PriceTable | null;
    priceTableConfirmation?: PriceTableConfirmation | null;
  },
  today = new Date(),
): Promise<{ name: string; intent: RouteIntent; config: ReturnType<typeof intentSearchConfig> }[]> {
  const exclude = excludesGenerated(d);
  const events = await eventsForPrompt(d.id, today).catch(() => []);
  return Promise.all(
    ROUTE_INTENTS.map(async (intent) => ({
      intent,
      name: intentConfigName(SEARCH_CONFIG, intent),
      config: intentSearchConfig(
        d.systemPrompt,
        d.language as LanguageSetting,
        intent,
        await intentFilter(d.id, intent),
        today,
        exclude,
        events,
        promptPrices(d),
      ),
    })),
  );
}

// A person confirmed or corrected the table: the price configuration's list of prices (prompt.ts
// pricesParagraph) is data, saved at once where the prompt already lists prices, never a rule added
// unchecked. Quiet where there's nothing to save to.
export async function savePricesParagraph(deploymentId: string): Promise<void> {
  const [d] = await db().select().from(deployments).where(eq(deployments.id, deploymentId));
  if (!d?.kbId || !d.systemPrompt) return;
  const kb = await managerClient(d);
  const name = intentConfigName(d.searchConfig, "price");
  const saved = (await kb.listSearchConfigs())[name];
  const prompt = saved?.config.prompt as { system?: string } | undefined;
  if (!saved || typeof prompt?.system !== "string" || !prompt.system.includes(PRICES_LIST_START)) return;
  const system = withPricesParagraph(prompt.system, pricesParagraph(promptPrices(d)));
  if (system !== prompt.system) await kb.saveSearchConfig(name, { ...saved.config, prompt: { ...prompt, system } });
}

// Turning the agents on or off: the KB's saved configurations (the default one and each intent
// one the console saved) re-saved with the generated-text exclusion added or taken out, and
// nothing else changed. Reads the deployment's agents as recorded now. Nothing to do for a
// deployment without a console-saved prompt (it asks with the KB's own defaults).
export async function saveGeneratedExclusion(deploymentId: string): Promise<string[]> {
  const [d] = await db().select().from(deployments).where(eq(deployments.id, deploymentId));
  if (!d?.kbId || !d.systemPrompt) return [];
  const kb = await managerClient(d);
  const saved = await kb.listSearchConfigs();
  const on = excludesGenerated(d);
  const names = [d.searchConfig, ...ROUTE_INTENTS.map((i) => intentConfigName(d.searchConfig, i))].filter((n) => saved[n]);
  for (const name of names) await kb.saveSearchConfig(name, withGeneratedExclusion(saved[name]!.config, on));
  return names;
}

// The latest answering rules applied to a deployment: its default configuration and one per
// intent saved with today's date, and the version recorded. By a person (saving the prompt, or
// switching from Review after a hold) or by the worker after a re-check found nothing worse
// (jobs/rules-rollout.ts), audited as deployment.rules.applied with what the re-check found.
export async function applyAnsweringRules(
  deploymentId: string,
  opts: { actor?: string | null; who?: Confirmation; recheck?: { total: number; unchanged: number; better: number }; today?: Date } = {},
): Promise<{ version: number } | { error: string }> {
  const [d] = await db().select().from(deployments).where(eq(deployments.id, deploymentId));
  if (!d?.kbId || !d.systemPrompt) return { error: "This deployment has no saved prompt to apply the rules to." };
  const kb = await managerClient(d);
  const today = opts.today ?? new Date();
  await kb.saveSearchConfig(
    SEARCH_CONFIG,
    searchConfigFor(d.systemPrompt, d.language as LanguageSetting, today, undefined, excludesGenerated(d)),
  );
  for (const c of await intentSearchConfigs(d, today)) await kb.saveSearchConfig(c.name, c.config);
  const from = d.answeringRules;
  await db()
    .update(deployments)
    .set({ answeringRules: ANSWERING_RULES, searchConfig: SEARCH_CONFIG })
    .where(eq(deployments.id, deploymentId));
  await db()
    .insert(auditLog)
    .values(
      await withSetupName({
        actorUserId: opts.actor ?? opts.who?.by ?? null,
        action: "deployment.rules.applied",
        targetType: "deployment",
        targetId: deploymentId,
        detail: {
          from,
          to: ANSWERING_RULES,
          changes: ANSWERING_RULES_CHANGES[ANSWERING_RULES] ?? "",
          ...(opts.recheck && { recheck: opts.recheck }),
          ...(opts.who && { name: opts.who.name, verified: opts.who.verified }),
        },
      }),
    );
  return { version: ANSWERING_RULES };
}

// The customer's name as visitors see it, for the prompt templates.
export async function customerVisitorName(tenantId: string): Promise<string | undefined> {
  const [t] = await db().select({ name: tenants.name, displayName: tenants.displayName }).from(tenants).where(eq(tenants.id, tenantId));
  return t && visitorName(t);
}

async function managerClient(d: typeof deployments.$inferSelect): Promise<KbClient> {
  if (!d.kbId) throw new Error("This deployment has no Knowledge Box yet.");
  const key = await loadKey(db(), env().masterKey, d.id, "manager");
  if (!key) throw new Error("This deployment has no manager key.");
  return new KbClient({ zone: d.zone, kbId: d.kbId, credential: { kind: "key", token: key } });
}

// Imported deployments only have a manager key; anything that can ask will do for a test.
const ASKING_ROLES: KeyRoleName[] = ["reader", "manager"];

// A client that asks as visitors do, for partner tests (prompt tries, validation): the reader
// key, else the manager key, as the configurator's preview asks (previewKey in lib/widget.ts).
// Here so validation runs the same in the worker, without the console's page code.
export async function askingClient(d: { id: string; zone: string; kbId: string | null }): Promise<KbClient | undefined> {
  if (!d.kbId) return undefined;
  const rows = await db()
    .select({ role: credentials.role })
    .from(credentials)
    .where(and(eq(credentials.deploymentId, d.id), inArray(credentials.role, ASKING_ROLES), isNull(credentials.revokedAt)));
  const role = ASKING_ROLES.find((r) => rows.some((row) => row.role === r));
  const key = role && (await loadKey(db(), env().masterKey, d.id, role));
  return key ? new KbClient({ zone: d.zone, kbId: d.kbId, credential: { kind: "key", token: key } }) : undefined;
}

export async function saveAnswers(deploymentId: string, prompt: string, language: LanguageSetting, actor: string | null): Promise<void> {
  const [d] = await db().select().from(deployments).where(eq(deployments.id, deploymentId));
  if (!d) throw new Error("Deployment not found.");
  const kb = await managerClient(d);
  await kb.saveSearchConfig(SEARCH_CONFIG, searchConfigFor(prompt, language, new Date(), undefined, excludesGenerated(d)));
  // Saving the prompt is a person's change: it applies the latest answering rules, intent
  // configurations included.
  for (const c of await intentSearchConfigs({ ...d, systemPrompt: prompt, language })) {
    await kb.saveSearchConfig(c.name, c.config);
  }
  // Imported deployments switch to the console's configuration from here on.
  await db()
    .update(deployments)
    .set({ systemPrompt: prompt, language, searchConfig: SEARCH_CONFIG, answeringRules: ANSWERING_RULES })
    .where(eq(deployments.id, deploymentId));
  // The first save of an imported deployment keeps what it had, so it can be restored.
  const [latest] = await db()
    .select({ id: promptVersions.id })
    .from(promptVersions)
    .where(eq(promptVersions.deploymentId, deploymentId))
    .limit(1);
  if (!latest && d.systemPrompt) {
    await db()
      .insert(promptVersions)
      .values({ deploymentId, prompt: d.systemPrompt, language: d.language, actorUserId: null, createdAt: d.createdAt });
  }
  await db().insert(promptVersions).values({ deploymentId, prompt, language, actorUserId: actor });
  await db()
    .insert(auditLog)
    .values(
      await withSetupName({
        actorUserId: actor,
        action: "deployment.prompt",
        targetType: "deployment",
        targetId: deploymentId,
        detail: { before: { prompt: d.systemPrompt, language: d.language }, after: { prompt, language } },
      }),
    );
}

export async function loadPromptVersions(deploymentId: string) {
  return db()
    .select({
      id: promptVersions.id,
      prompt: promptVersions.prompt,
      language: promptVersions.language,
      at: promptVersions.createdAt,
      by: users.name,
      byEmail: users.email,
    })
    .from(promptVersions)
    .leftJoin(users, eq(users.id, promptVersions.actorUserId))
    .where(eq(promptVersions.deploymentId, deploymentId))
    .orderBy(desc(promptVersions.createdAt))
    .limit(20);
}

// A draft prompt answering one question, with the deployment's retrieval settings. A partner
// test: it never counts toward the customer's usage.
export async function tryPrompt(deploymentId: string, prompt: string, language: LanguageSetting, question: string) {
  const [d] = await db().select().from(deployments).where(eq(deployments.id, deploymentId));
  if (!d?.kbId) return { error: "This deployment has no Knowledge Box yet." };
  const kb = await askingClient(d);
  if (!kb) return { error: "This deployment has no key to ask with." };
  try {
    const result = await kb.ask(
      { query: question, ...searchConfigFor(prompt, language, new Date(), undefined, excludesGenerated(d)), show: ["basic", "origin"] },
      { partnerTest: true },
    );
    return { answer: (result.answer ?? "").trim(), sources: answerSources(result) };
  } catch (err) {
    return { error: `Agentic RAG didn't answer: ${err instanceof Error ? err.message : err}` };
  }
}

// The KB's saved prompt, when it no longer matches what the console last saved (someone edited
// it in the Agentic RAG dashboard).
export async function promptDrift(deploymentId: string): Promise<{ drifted: false } | { drifted: true; kbPrompt: string | null }> {
  const [d] = await db().select().from(deployments).where(eq(deployments.id, deploymentId));
  if (!d?.kbId || !d.systemPrompt) return { drifted: false };
  try {
    const configs = await Promise.race([
      (await managerClient(d)).listSearchConfigs(),
      new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 3000)),
    ]);
    if (!configs) return { drifted: false };
    const saved = configs[d.searchConfig]?.config.prompt as string | { system?: string } | undefined;
    const system = typeof saved === "object" ? (saved.system ?? null) : (saved ?? null);
    // The date paragraph changes every day (the worker refreshes it), so it isn't compared.
    return system !== null && withoutToday(system) === composeSystemPrompt(d.systemPrompt, d.language as LanguageSetting, null)
      ? { drifted: false }
      : { drifted: true, kbPrompt: system };
  } catch {
    return { drifted: false };
  }
}

// Whether the KB's saved configuration has the console's current answering rules: the system
// prompt as the console composes it today (date aside) and the current user prompt, which holds
// the answer-language rule. Validation's advice under a language failure says to save the
// prompt only when it doesn't. Undefined when it can't tell (no saved prompt, or no answer in 3 s).
export async function answeringRulesCurrent(deploymentId: string): Promise<boolean | undefined> {
  const [d] = await db().select().from(deployments).where(eq(deployments.id, deploymentId));
  if (!d?.kbId || !d.systemPrompt) return undefined;
  try {
    const configs = await Promise.race([
      (await managerClient(d)).listSearchConfigs(),
      new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 3000)),
    ]);
    if (!configs) return undefined;
    const saved = configs[d.searchConfig]?.config.prompt as string | { system?: string; user?: string } | undefined;
    const system = typeof saved === "object" ? saved.system : saved;
    const user = typeof saved === "object" ? saved.user : undefined;
    const language = d.language as LanguageSetting;
    return (
      system !== undefined &&
      withoutToday(system) === composeSystemPrompt(d.systemPrompt, language, null) &&
      user === composeUserPrompt(language)
    );
  } catch {
    return undefined;
  }
}

export async function saveLeadDelivery(
  deploymentId: string,
  webhookUrl: string | null,
  emails: string[],
  actor: string | null,
): Promise<void> {
  const [d] = await db().select({ before: deployments.leadDelivery }).from(deployments).where(eq(deployments.id, deploymentId));
  const after = { ...(webhookUrl && { webhookUrl }), ...(emails.length && { emails }) };
  await db().update(deployments).set({ leadDelivery: after }).where(eq(deployments.id, deploymentId));
  await db()
    .insert(auditLog)
    .values(
      await withSetupName({
        actorUserId: actor,
        action: "deployment.leads",
        targetType: "deployment",
        targetId: deploymentId,
        detail: { before: d?.before ?? {}, after },
      }),
    );
}
