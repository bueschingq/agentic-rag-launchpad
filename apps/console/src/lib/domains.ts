// A deployment's allowed domains live in two places that must agree: the console (which the
// public config and token routes check) and the KB's allowed_origins (which Agentic RAG
// enforces in browsers). Changes go to both, KB first, then the console; the lock takes 15–60 s
// to apply (M0), which the domain check confirms.

import { auditLog, deployments } from "@launchpad/db";
import { eq } from "drizzle-orm";
import { db } from "./db.ts";
import { isStagingOrigin, MAX_DOMAINS } from "./domain-rules.ts";
import { normaliseOrigin } from "./origin.ts";
import { zoneClient } from "./par.ts";
import { withSetupName } from "./setup-name.ts";

// `staging`: which of the domains are staging or test sites (questions from them are test
// traffic); left out, each domain keeps its mark.
export async function setDomains(deploymentId: string, domains: string[], actor: string | null, staging?: string[]): Promise<void> {
  const [d] = await db().select().from(deployments).where(eq(deployments.id, deploymentId));
  if (!d) throw new Error("Deployment not found.");
  const stagingDomains = (staging ?? d.stagingDomains).filter((o) => domains.includes(o));
  // Marking a domain staging changes nothing in the Knowledge Box's lock.
  const lockChanged = domains.length !== d.domains.length || domains.some((o) => !d.domains.includes(o));
  if (d.kbId && lockChanged) await (await zoneClient()).updateKb(d.kbId, { allowedOrigins: domains });
  await db()
    .update(deployments)
    .set({ domains, stagingDomains, ...(lockChanged && { preflight: null }) })
    .where(eq(deployments.id, deploymentId));
  await db()
    .insert(auditLog)
    .values(
      await withSetupName({
        actorUserId: actor,
        action: "deployment.domains",
        targetType: "deployment",
        targetId: deploymentId,
        detail: { before: d.domains, after: domains, stagingBefore: d.stagingDomains, staging: stagingDomains },
      }),
    );
}

// "Allow it" on a refused origin. One on this machine (localhost) is marked staging.
export async function addDomains(deploymentId: string, add: string[], actor: string | null): Promise<void> {
  const [d] = await db()
    .select({ domains: deployments.domains, staging: deployments.stagingDomains })
    .from(deployments)
    .where(eq(deployments.id, deploymentId));
  if (!d) throw new Error("Deployment not found.");
  const next = [...new Set([...d.domains, ...add.flatMap((o) => normaliseOrigin(o) ?? [])])].slice(0, MAX_DOMAINS);
  const staging = [...d.staging, ...next.filter((o) => !d.domains.includes(o) && isStagingOrigin(o, []))];
  if (next.length !== d.domains.length) await setDomains(deploymentId, next, actor, staging);
}
