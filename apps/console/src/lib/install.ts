// Runs "Check installation" for a deployment: the sniffer's facts about a page, judged against
// the deployment's id, domains, console address and region. A check that finds the snippet on an
// allowed domain is recorded, so the deployment's stage knows it's in place before any chat.

import { auditLog, deployments, settings } from "@launchpad/db";
import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "./db.ts";
import { publicBaseUrl } from "./env.ts";
import { type InstallCheck, judgeInstall, runInstallCheck, snippetInPlace } from "./install-check.ts";
import { RateLimiter } from "./origin.ts";
import { withSetupName } from "./setup-name.ts";
import { checkPreflight } from "./validation.ts";

// Each check loads a page in a browser: a few a minute per deployment is plenty.
const limiter = new RateLimiter(6, 60_000);

// The audit entry a check that found the snippet leaves (History says it in words).
export const SNIPPET_FOUND = "deployment.install-check";

// opts.anonymous: from a share link, so only the deployment's own domains can be checked; the
// console's scanner isn't for loading any page someone types. opts.actor: who ran it.
export async function checkDeploymentInstall(
  deploymentId: string,
  url: string,
  opts: { anonymous?: boolean; actor?: string | null } = {},
): Promise<{ checks?: InstallCheck[]; error?: string }> {
  let target: URL;
  try {
    target = new URL(url.includes("://") ? url : `https://${url}`);
  } catch {
    return { error: "Enter the address of a page on the site." };
  }
  if (!limiter.allow(deploymentId)) return { error: "Several checks just ran. Try again in a minute." };
  const [d] = await db().select().from(deployments).where(eq(deployments.id, deploymentId));
  if (!d) return { error: "This deployment no longer exists." };
  if (opts.anonymous && !d.domains.includes(target.origin)) {
    return { error: `This link can only check pages on ${d.domains.join(", ")}.` };
  }
  const facts = await runInstallCheck(target.href);
  if ("error" in facts && !("origin" in facts)) return { error: facts.error };
  const [config] = await db().select({ partner: settings.partnerName }).from(settings).where(eq(settings.id, 1));
  // An allowed domain passes only once Agentic RAG answers its preflight (after Allow it, that
  // takes a minute or three).
  const lock =
    d.kbId && facts.origin && d.domains.includes(facts.origin) ? await checkPreflight(d.zone, d.kbId, [facts.origin]) : undefined;
  const checks = judgeInstall(facts, {
    id: d.id,
    domains: d.domains,
    consoleOrigin: publicBaseUrl(),
    zone: d.zone,
    provisioned: Boolean(d.kbId),
    published: d.published,
    partner: config?.partner,
    ...(d.widgetSettings.avatar && { avatar: d.widgetSettings.avatar }),
    ...(d.widgetSettings.exclude?.length && { exclude: d.widgetSettings.exclude }),
    ...(lock && { lockApplied: lock.origins.every((o) => o.ok) }),
  });
  if (snippetInPlace(checks, facts.origin, d.domains)) {
    await db()
      .insert(auditLog)
      .values(
        await withSetupName({
          actorUserId: opts.actor ?? null,
          action: SNIPPET_FOUND,
          targetType: "deployment",
          targetId: d.id,
          detail: { origin: facts.origin, url: facts.finalUrl, ...(opts.anonymous && { via: "share" }) },
        }),
      );
  }
  return { checks };
}

// The latest check that found each deployment's snippet on an allowed domain, by deployment.
export async function snippetSightings(deploymentIds: readonly string[]): Promise<Map<string, { at: Date; origin: string }>> {
  const seen = new Map<string, { at: Date; origin: string }>();
  if (!deploymentIds.length) return seen;
  const rows = await db()
    .select({ id: auditLog.targetId, at: auditLog.at, detail: auditLog.detail })
    .from(auditLog)
    .where(and(eq(auditLog.targetType, "deployment"), inArray(auditLog.targetId, [...deploymentIds]), eq(auditLog.action, SNIPPET_FOUND)))
    .orderBy(desc(auditLog.at));
  for (const r of rows) {
    const origin = r.detail?.origin;
    if (r.id && typeof origin === "string" && !seen.has(r.id)) seen.set(r.id, { at: r.at, origin });
  }
  return seen;
}
