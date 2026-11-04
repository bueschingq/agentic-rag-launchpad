// Database side of creating customers and deployments. The Agentic RAG steps are in
// provision.ts; this file stores their results and records each action in the audit log.

import { auditLog, deployments, loadKey, storeKey, tenantContacts, tenants } from "@launchpad/db";
import { KbClient, type KeyRole, provisioningProblem } from "@launchpad/par-client";
import { languageSetting } from "@launchpad/theme";
import { and, asc, eq, isNotNull, lt, ne, or, sql } from "drizzle-orm";
import { augmentDeployment, augmentNewDeployments } from "./augmentation.ts";
import { forgetLimitIfPassed, learnLimitFromRefusal } from "./capacity.ts";
import { ensureContentSync } from "./content.ts";
import type { CustomerInput, KbAccess } from "./customer-form.ts";
import { db } from "./db.ts";
import type { DeploymentInput } from "./deployment-form.ts";
import { defaultStagingDomains } from "./domain-rules.ts";
import { env } from "./env.ts";
import { partnerAccount, zoneClient } from "./par.ts";
import { ANSWERING_RULES, excludesGenerated } from "./prompt.ts";
import { type ProvisionStore, runProvisioning } from "./provision.ts";
import { withSetupName } from "./setup-name.ts";
import { kbSlugFor, slugify, uniqueSlug } from "./slug.ts";

// A run that died mid-way leaves the deployment "provisioning"; after this long it can be retried.
const STALE_RUN_MS = 5 * 60_000;

export async function createCustomer(input: CustomerInput, actor: string | null): Promise<string> {
  const taken = new Set((await db().select({ slug: tenants.slug }).from(tenants)).map((r) => r.slug));
  const slug = uniqueSlug(slugify(input.name) || "customer", taken);
  return db().transaction(async (tx) => {
    const [tenant] = await tx
      .insert(tenants)
      .values({
        slug,
        name: input.name,
        displayName: input.displayName,
        language: input.language,
        monthlyBudgetCents: input.monthlyBudgetCents,
        budgetMode: input.budgetMode,
        billing: input.billing,
      })
      .returning({ id: tenants.id });
    await tx
      .insert(tenantContacts)
      .values(input.contacts.map((c) => ({ ...c, tenantId: tenant!.id, phone: c.phone ?? null, title: c.title ?? null })));
    await tx.insert(auditLog).values(
      await withSetupName({
        actorUserId: actor,
        action: "customer.create",
        targetType: "tenant",
        targetId: tenant!.id,
        detail: { name: input.name, slug, contacts: input.contacts.length, kbAccess: input.contacts.filter((c) => c.kbRole).length },
      }),
    );
    return tenant!.id;
  });
}

// Stores the deployment as a draft; provisionDeployment then builds its KB. Domains beyond the
// site's own (and its www/apex twin) are staging unless New deployment says otherwise.
export async function createDeployment(
  input: DeploymentInput & { stagingDomains?: string[] },
  actor: string | null,
): Promise<string | undefined> {
  const [tenant] = await db()
    .select({ slug: tenants.slug, language: tenants.language })
    .from(tenants)
    .where(and(eq(tenants.id, input.customerId), ne(tenants.status, "archived")));
  if (!tenant) return undefined;

  const [account, zone] = await Promise.all([partnerAccount(), zoneClient()]);
  // KB slugs are unique across the whole account, not just this console.
  const [ours, theirs] = await Promise.all([db().select({ slug: deployments.kbSlug }).from(deployments), zone.listKbs()]);
  const taken = new Set([...ours.map((r) => r.slug), ...theirs.map((kb) => kb.slug)]);
  const kbSlug = uniqueSlug(kbSlugFor(tenant.slug, input.siteUrl), taken);
  const language = input.language ?? tenant.language;
  const stagingDomains = (input.stagingDomains ?? defaultStagingDomains(input.siteUrl, input.domains)).filter((o) =>
    input.domains.includes(o),
  );

  return db().transaction(async (tx) => {
    const [row] = await tx
      .insert(deployments)
      .values({
        tenantId: input.customerId,
        name: input.name,
        siteUrl: input.siteUrl,
        domains: input.domains,
        stagingDomains,
        contentPath: "manual",
        zone: account.zone,
        kbSlug,
        language,
        systemPrompt: input.systemPrompt,
        status: "draft",
      })
      .returning({ id: deployments.id });
    await tx.insert(auditLog).values(
      await withSetupName({
        actorUserId: actor,
        action: "deployment.create",
        targetType: "deployment",
        targetId: row!.id,
        detail: {
          tenantId: input.customerId,
          name: input.name,
          siteUrl: input.siteUrl,
          domains: input.domains,
          stagingDomains,
          kbSlug,
          language,
        },
      }),
    );
    return row!.id;
  });
}

// Runs (or resumes) provisioning. Returns undefined when another run is already under way.
export async function provisionDeployment(id: string, actor: string | null): Promise<"live" | "failed" | undefined> {
  const stale = new Date(Date.now() - STALE_RUN_MS);
  const [claimed] = await db()
    .update(deployments)
    .set({ status: "provisioning" })
    .where(and(eq(deployments.id, id), or(ne(deployments.status, "provisioning"), lt(deployments.updatedAt, stale))))
    .returning();
  if (!claimed) return undefined;

  const contacts = await db()
    .select({ email: tenantContacts.email, kbRole: tenantContacts.kbRole })
    .from(tenantContacts)
    .where(and(eq(tenantContacts.tenantId, claimed.tenantId), isNotNull(tenantContacts.kbRole)))
    .orderBy(asc(tenantContacts.createdAt));

  const { masterKey } = env();
  const update = (values: Partial<typeof deployments.$inferInsert>) => db().update(deployments).set(values).where(eq(deployments.id, id));
  const store: ProvisionStore = {
    saveKbId: async (kbId) => {
      await update({ kbId });
    },
    keyFor: (role: KeyRole) => loadKey(db(), masterKey, id, role),
    storeKey: (role, key) => storeKey(db(), masterKey, { deploymentId: id, role, ...key }),
    // Appended in the database, so concurrent writers can't drop each other's entries.
    log: async (step) => {
      await db()
        .update(deployments)
        .set({ provisioningLog: sql`${deployments.provisioningLog} || ${JSON.stringify([step])}::jsonb` })
        .where(eq(deployments.id, id));
    },
    setStatus: async (status) => {
      await update({ status });
    },
  };

  let result: Awaited<ReturnType<typeof runProvisioning>>;
  try {
    result = await runProvisioning(
      {
        name: claimed.name,
        kbId: claimed.kbId,
        kbSlug: claimed.kbSlug,
        domains: claimed.domains,
        language: languageSetting(claimed.language),
        systemPrompt: claimed.systemPrompt,
        contacts: contacts.map((c) => ({ email: c.email, kbRole: c.kbRole as KbAccess })),
        log: claimed.provisioningLog,
        excludeGenerated: excludesGenerated(claimed),
      },
      {
        zone: await zoneClient(),
        kb: (kbId, token) => new KbClient({ zone: claimed.zone, kbId, credential: { kind: "key", token } }),
        store,
      },
    );
  } catch (err) {
    // The run itself broke (database, NUA key), not one of its steps: leave it retryable now.
    await update({ status: "failed" });
    throw err;
  }
  // The Agentic RAG agents pilot, when the account setting is on: created on a new deployment's KB
  // before its first sync, so they apply as pages are processed. A run that takes the deployment
  // live for the first time counts as new. Without them the deployment works as before, so a
  // failure is recorded and doesn't hold it back (the deployment page can turn them on later).
  const wasLive = claimed.provisioningLog.some((s) => s.step === "live" && s.status === "ok");
  if (result.status === "live" && !wasLive) await addAgentsIfOn(id, actor, store.log);
  // The prompt step saved the default and intent configurations under the latest answering rules
  // (provision.ts): recorded, so the public config routes intent questions from the first answer.
  if (result.status === "live") await update({ answeringRules: ANSWERING_RULES });
  // Content starts syncing straight away (the worker picks it up within a minute), so pages
  // index while the partner works on the widget.
  if (result.status === "live") await ensureContentSync(id);
  // A refusal for the account's Knowledge Box limit teaches the console the limit; a KB created
  // past a learned limit means Progress raised it.
  const refused = result.steps.find((st) => st.status === "failed");
  if (refused && provisioningProblem(refused.detail).kind === "limit") await learnLimitFromRefusal();
  if (result.status === "live") await forgetLimitIfPassed();
  await db()
    .insert(auditLog)
    .values(
      await withSetupName({
        actorUserId: actor,
        action: "deployment.provision",
        targetType: "deployment",
        targetId: id,
        detail: { status: result.status, steps: result.steps.map((s) => `${s.step}: ${s.status}`) },
      }),
    );
  return result.status;
}

// The provisioning step the agents are recorded under (shown as written on the deployment page).
export const AGENTS_STEP = "Agentic RAG agents";

async function addAgentsIfOn(id: string, actor: string | null, log: ProvisionStore["log"]): Promise<void> {
  const at = () => new Date().toISOString();
  try {
    if (!(await augmentNewDeployments())) return;
    const record = await augmentDeployment(id, { actor });
    await log({ step: AGENTS_STEP, status: "ok", at: at(), detail: record.tasks.map((t) => t.agent).join(", ") });
  } catch (err) {
    await log({ step: AGENTS_STEP, status: "failed", at: at(), detail: err instanceof Error ? err.message : String(err) }).catch(() => {});
  }
}

// ---- reads for the provisioning pages ----

export function loadCustomerOptions() {
  return db()
    .select({ id: tenants.id, name: tenants.name, language: tenants.language })
    .from(tenants)
    .where(ne(tenants.status, "archived"))
    .orderBy(asc(tenants.name));
}

export async function loadCustomerProfile(tenantId: string) {
  const [tenant] = await db()
    .select({ name: tenants.name, language: tenants.language, billing: tenants.billing })
    .from(tenants)
    .where(eq(tenants.id, tenantId));
  if (!tenant) return undefined;
  const contacts = await db()
    .select()
    .from(tenantContacts)
    .where(eq(tenantContacts.tenantId, tenantId))
    .orderBy(sql`${tenantContacts.isPrimary} desc`, asc(tenantContacts.createdAt));
  return { ...tenant, contacts };
}

export async function loadDeployment(tenantId: string, deploymentId: string) {
  const [row] = await db()
    // tenantName is the partner's own label; visibleName ("Name visitors see") is for anything
    // the client or visitors read, and is null until someone sets it.
    .select({ deployment: deployments, tenantName: tenants.name, visibleName: tenants.displayName })
    .from(deployments)
    .innerJoin(tenants, eq(tenants.id, deployments.tenantId))
    .where(and(eq(deployments.id, deploymentId), eq(deployments.tenantId, tenantId)));
  return row;
}
