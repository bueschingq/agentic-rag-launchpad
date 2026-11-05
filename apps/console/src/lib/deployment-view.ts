// Everything the deployment page shows, gathered in one place: the deployment and its customer,
// content, validation, the checklist's facts, keys, refused domains and budget state.

import { auditLog, credentials, deployments, refusedOrigins, siteScans, tenants, usageDaily, users } from "@launchpad/db";
import { KbClient } from "@launchpad/par-client";
import { type LinkContext, languageName, languageSetting } from "@launchpad/theme";
import { and, desc, eq, gt, gte, inArray, isNull, min, sql } from "drizzle-orm";
import { pagePaths } from "../app/api/public/deployments/[id]/config/pages.ts";
import { promptDrift } from "./answers.ts";
import { budgetState } from "./budget.ts";
import { visitorStrings } from "./client-name.ts";
import {
  type ContentChange,
  contentChangesSince,
  keptByHand,
  keyPagesUnused,
  loadContent,
  missingPages,
  pagesOutOfDate,
} from "./content.ts";
import { nameChanges } from "./customers.ts";
import { answeredOrigins } from "./dashboard.ts";
import { db } from "./db.ts";
import { rulesChangeLine } from "./history.ts";
import { snippetSightings } from "./install.ts";
import { leadName, leadSubject } from "./leads.ts";
import {
  type ContentFacts,
  clockFigures,
  type DeploymentFacts,
  deploymentStage,
  onboardingChecklist,
  onboardingHeldAt,
  onboardingStart,
  preflightPassed,
} from "./onboarding.ts";
import { latestSteps } from "./provision.ts";
import {
  brandStatus,
  priceTableChanged,
  priceTableState,
  reviewLines,
  signOffState,
  underOlderChecks,
  visitorSettingsHash,
} from "./review.ts";
import { isRefusalNote } from "./site-refusal.ts";
import { LEAK_PHRASES, reviewNotes } from "./validation-rules.ts";
import { previewKey } from "./widget.ts";
import { consentGaps } from "./widget-form.ts";

// The links a reply shown in the console may keep, as the chat's (components/model-text.tsx): the
// synced pages, the buttons' and contacts' targets, and the deployment's own sites. Never throws:
// without the pages, any page on its own sites may open.
export async function modelTextLinks(
  d: Pick<typeof deployments.$inferSelect, "id" | "siteUrl" | "domains" | "widgetSettings">,
): Promise<LinkContext> {
  const pages = await pagePaths(d.id).catch(() => undefined);
  const settings = d.widgetSettings ?? {};
  const host = (() => {
    try {
      return [new URL(d.siteUrl).host];
    } catch {
      return [];
    }
  })();
  return {
    pagePaths: pages?.pagePaths ?? [],
    capped: !pages || pages.pagePathsCapped === true,
    ctaTargets: [...(settings.ctas ?? []), ...(settings.handoff?.contacts ?? [])].flatMap((c) => (c.url ? [c.url] : [])),
    hosts: [...host, ...d.domains.map((x) => x.replace(/^https?:\/\//, "").replace(/\/.*$/, ""))],
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Resources in the KB, from Agentic RAG (for Sitefinity's connector, which syncs outside us).
async function kbResources(d: typeof deployments.$inferSelect): Promise<number | undefined> {
  if (!d.kbId) return undefined;
  const key = await previewKey(d.id);
  if (!key) return undefined;
  const kb = new KbClient({ zone: d.zone, kbId: d.kbId, credential: { kind: "key", token: key } });
  return Promise.race([
    kb.counters().then((c) => c.resources),
    new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 3000)),
  ]).catch(() => undefined);
}

// Bring up to date's content step (applyUpToDate's audit entry), applied after the sign-off it's
// bringing up to date.
async function contentBroughtUpToDate(deploymentId: string, since: string): Promise<boolean> {
  const [row] = await db()
    .select({ at: auditLog.at })
    .from(auditLog)
    .where(and(eq(auditLog.targetId, deploymentId), eq(auditLog.action, "content.up-to-date"), gt(auditLog.at, new Date(since))))
    .limit(1);
  return Boolean(row);
}

// Answering-rules changes applied since the sign-off, oldest first, for Review's "changes since
// sign-off": "answering rules v4 → v5, applied after a re-check" (history.ts rulesChangeLine). The
// re-check keeps serving the signed-off chat, so they're listed, not a reason to sign off again.
export interface RulesChange {
  at: string;
  text: string;
}
async function rulesChangesSince(deploymentId: string, since: string): Promise<RulesChange[]> {
  const rows = await db()
    .select({ at: auditLog.at, detail: auditLog.detail, name: users.name, email: users.email })
    .from(auditLog)
    .leftJoin(users, eq(users.id, auditLog.actorUserId))
    .where(and(eq(auditLog.targetId, deploymentId), eq(auditLog.action, "deployment.rules.applied"), gt(auditLog.at, new Date(since))))
    .orderBy(auditLog.at);
  return rows.flatMap((r) => {
    const text = rulesChangeLine(r.detail, r.name ?? r.email);
    return text ? [{ at: r.at.toISOString(), text }] : [];
  });
}

// Pages added, kept or left out by hand (and key pages and content settings) since the sign-off
// that still stand, with the signed-in person's name where there was one: "Changed since
// sign-off", like a change of the client's name.
export type ContentChangeSeen = ContentChange & { byName?: string };
async function contentChanges(deploymentId: string, since: string): Promise<ContentChangeSeen[]> {
  const changes = await contentChangesSince(deploymentId, since);
  const ids = [...new Set(changes.flatMap((c) => (c.by ? [c.by] : [])))];
  if (!ids.length) return changes;
  const names = new Map(
    (await db().select({ id: users.id, name: users.name, email: users.email }).from(users).where(inArray(users.id, ids))).map((u) => [
      u.id,
      u.name ?? u.email,
    ]),
  );
  return changes.map((c) => {
    const byName = c.by ? names.get(c.by) : undefined;
    return byName ? { ...c, byName } : c;
  });
}

// opts.servedPrompt: also read the prompt the Knowledge Box answers with (up to 3 s), so the
// Client's name line catches an edit made in the Agentic RAG dashboard. Review and sign-off ask
// for it; the deployment page doesn't wait on it.
export async function loadDeploymentView(tenantId: string, deploymentId: string, opts: { servedPrompt?: boolean } = {}) {
  if (!UUID.test(tenantId) || !UUID.test(deploymentId)) return undefined;
  const [row] = await db()
    .select({ deployment: deployments, tenant: tenants })
    .from(deployments)
    .innerJoin(tenants, eq(tenants.id, deployments.tenantId))
    .where(and(eq(deployments.id, deploymentId), eq(deployments.tenantId, tenantId)));
  if (!row) return undefined;
  const { deployment: d, tenant } = row;

  const olderChecks = underOlderChecks(d.signOff);
  const [
    content,
    budget,
    [scan],
    keys,
    refused,
    [firstSignOff],
    renamed,
    origins,
    drift,
    reextracting,
    contentApplied,
    sightings,
    kept,
    changedContent,
    rulesChanged,
    unusedKeys,
  ] = await Promise.all([
    loadContent(d.id),
    budgetState(tenant.id),
    db()
      .select({ at: siteScans.createdAt, url: siteScans.finalUrl, platform: siteScans.platform })
      .from(siteScans)
      .where(eq(siteScans.deploymentId, d.id)),
    db()
      .select({ role: credentials.role, expiresAt: min(credentials.expiresAt) })
      .from(credentials)
      .where(and(eq(credentials.deploymentId, d.id), isNull(credentials.revokedAt)))
      .groupBy(credentials.role),
    db().select().from(refusedOrigins).where(eq(refusedOrigins.deploymentId, d.id)).orderBy(desc(refusedOrigins.lastSeenAt)),
    // The first sign-off ends the onboarding clock; later ones re-confirm changes, and the first
    // upgrade sign-off (Bring up to date's) ends the time a heldAt can count (onboardingHeldAt).
    db()
      .select({
        at: min(auditLog.at),
        upgradedAt: sql<Date | null>`min(${auditLog.at}) filter (where ${auditLog.detail}->>'previousChecksVersion' is not null)`.mapWith(
          (v) => (v ? new Date(v) : null),
        ),
      })
      .from(auditLog)
      .where(and(eq(auditLog.targetId, d.id), eq(auditLog.action, "deployment.signoff"))),
    nameChanges([tenant.id]).then((m) => m.get(tenant.id) ?? []),
    answeredOrigins(new Date(Date.now() - 30 * 86_400_000), d.id).then((m) => m.get(d.id) ?? []),
    opts.servedPrompt ? promptDrift(d.id) : Promise.resolve({ drifted: false as const }),
    olderChecks ? pagesOutOfDate(d.id) : Promise.resolve(0),
    olderChecks && d.signOff ? contentBroughtUpToDate(d.id, d.signOff.at) : Promise.resolve(false),
    // Check installation found the snippet: in place before the first chat.
    snippetSightings([d.id]),
    // Pages kept by hand despite a date or stale-price rule, for Review's line with who and why.
    keptByHand(d.id).catch(() => []),
    d.signOff ? contentChanges(d.id, d.signOff.at).catch((): ContentChangeSeen[] => []) : Promise.resolve([]),
    d.signOff ? rulesChangesSince(d.id, d.signOff.at).catch((): RulesChange[] => []) : Promise.resolve([]),
    // Key pages the sync couldn't use (too little text, 404, an error page), for Review's line.
    keyPagesUnused(d.id).catch(() => []),
  ]);
  const snippetSeen = sightings.get(d.id);
  const connector = d.contentPath === "sitefinity_connector";
  // Imported deployments got their content outside the console.
  const external = d.contentPath === "manual";
  const resources = connector || external ? await kbResources(d) : undefined;
  const [usage] = await db()
    .select({ questions: sql<number>`coalesce(sum(${usageDaily.questions}), 0)`.mapWith(Number) })
    .from(usageDaily)
    .where(and(eq(usageDaily.deploymentId, d.id), gte(usageDaily.day, new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10))));

  const steps = latestSteps(d.provisioningLog);
  const failed = steps.find((s) => s.status === "failed");
  const signOff = signOffState(
    d.signOff,
    visitorSettingsHash(d),
    renamed[0]?.at,
    changedContent.at(-1)?.at,
    priceTableChanged(d.signOff, d),
  );
  const facts: DeploymentFacts = {
    status: d.status,
    createdAt: d.createdAt,
    readyAt: d.readyAt,
    firstSeenAt: d.firstSeenAt,
    firstSeenOrigin: d.firstSeenOrigin,
    validation: d.validation,
    preflight: d.preflight,
    questions30: usage?.questions ?? 0,
    signOff: signOff.state,
    olderChecks,
    stagingDomains: d.stagingDomains,
    answeredOn: origins,
    ...(snippetSeen && { snippetSeen }),
    ...(failed && { failedStep: { step: failed.step, ...(failed.detail && { detail: failed.detail }) } }),
  };
  const contentFacts: ContentFacts = {
    indexed: content.counts.indexed,
    total: content.total,
    syncStatus: content.source?.lastJobStatus ?? null,
    syncError: content.source?.lastError ?? null,
    connector,
    external,
    ...(resources !== undefined && { kbResources: resources }),
    ...(content.estimate && { estimate: content.estimate.text }),
  };
  const customer = { createdAt: tenant.createdAt, paused: tenant.status === "paused", stoppedForBudget: budget.stopped };
  const base = `/customers/${tenant.id}/deployments/${d.id}`;
  const notes = d.validation ? reviewNotes(d.validation) : undefined;
  const review = reviewLines({
    base,
    settings: d.widgetSettings,
    language: d.language,
    brand: brandStatus(d.widgetSettings, d.theme, d.confirmations),
    confirmations: d.confirmations,
    leadDelivery: d.leadDelivery,
    validation: d.validation,
    domainsLocked: preflightPassed(d.preflight),
    content: {
      indexed: connector || external ? (resources ?? content.counts.indexed) : content.counts.indexed,
      total: connector || external ? (resources ?? content.total) : content.total,
      ...(content.oldestTaken && { oldestTaken: content.oldestTaken }),
      ...(content.counts.skipped && { excluded: content.counts.skipped }),
    },
    consentMissing: consentGaps(d.widgetSettings, languageSetting(d.language)).map(languageName),
    clientName: {
      internal: tenant.name,
      visible: tenant.displayName,
      // Every name the chat called the client before a change of "Name visitors see".
      previous: [...new Set(renamed.flatMap((c) => [c.before, c.after]))].filter((n) => n !== tenant.displayName),
      prompt: d.systemPrompt,
      ...(drift.drifted && drift.kbPrompt !== null && { served: drift.kbPrompt }),
      strings: visitorStrings(d.widgetSettings),
      leadEmail: leadSubject(leadName(tenant.displayName, d.siteUrl)),
      leakPhrases: LEAK_PHRASES,
    },
    ...(notes && { notes }),
    ...(olderChecks && { olderChecks: { contentApplied, reextracting } }),
    kept,
    keyPagesUnused: unusedKeys,
    missingPages: {
      ...(await missingPages(d.id, isRefusalNote(content.source?.lastError)).catch(() => ({ missing: 0, keys: [] }))),
      planned: content.total,
      ...(isRefusalNote(content.source?.lastError) && { note: content.source?.lastError ?? "" }),
    },
  });
  const checklist = onboardingChecklist({
    base,
    customerCreatedAt: tenant.createdAt,
    scanAt: scan?.at ?? null,
    review,
    ...(d.signOff && { signedOffAt: new Date(d.signOff.at) }),
    priceTableOpen: ["unconfirmed", "changed"].includes(priceTableState(d.priceTable, d.priceTableConfirmation)),
    deployment: facts,
    content: contentFacts,
  });

  // A live deployment with onboarding steps still open isn't all green.
  const stage = deploymentStage(facts, contentFacts, customer);
  const open = checklist.filter((s) => s.state !== "done");
  if (stage.key === "live" && stage.tone === "good" && open.length) {
    stage.tone = "warning";
    stage.detail += ` ${open.map((s) => s.label).join(", ")} still open.`;
  }

  const started = onboardingStart(tenant.createdAt, d.createdAt);
  // Not when an upgrade stamped it: the "Onboarded…" line stays as it was (onboardingHeldAt).
  const heldAt = onboardingHeldAt(d.signOff, firstSignOff?.upgradedAt);
  return {
    deployment: d,
    tenant,
    base,
    stage,
    checklist,
    review,
    signOff,
    olderChecks,
    nameChanges: renamed,
    // Content changes since the sign-off that still stand, oldest first.
    contentChanges: changedContent,
    // Answering-rules changes applied since the sign-off, oldest first ("answering rules v4 → v5,
    // applied after a re-check"), for Review's list of changes since sign-off.
    rulesChanges: rulesChanged,
    notes,
    // Pages still waiting to be read again with today's extractor (only counted under older checks).
    reextracting,
    started,
    firstSignedOffAt: firstSignOff?.at ?? null,
    // When the sign-off held after the first sync (SignOff.heldAt, set by validation), and the
    // clock's two figures: "Signed off 13 min after starting", "Held after the first sync: 19 min"
    // (or "not yet"). Empty before the first sign-off.
    heldAt,
    clock: clockFigures(started, firstSignOff?.at ?? null, heldAt),
    content,
    contentFacts,
    budget,
    scan: scan ?? null,
    keys: keys.map((k) => ({ role: k.role, expiresAt: k.expiresAt })),
    refused,
    steps,
  };
}

export type DeploymentView = NonNullable<Awaited<ReturnType<typeof loadDeploymentView>>>;
