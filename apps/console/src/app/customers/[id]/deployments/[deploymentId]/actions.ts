"use server";

// Everything the deployment page can do: provisioning, content, validation, pause, the
// writer key for Sitefinity's connector, and allowing a refused domain. Each is audited with
// the person who did it.

import { auditLog, deployments, loadKey, refusedOrigins } from "@launchpad/db";
import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { actorId, requireAdmin } from "@/lib/auth.ts";
import { kbAllowance } from "@/lib/capacity.ts";
import { excludePage, requestSync, retryFailedPages, saveContentSettings } from "@/lib/content.ts";
import { parseContentForm } from "@/lib/content-form.ts";
import { db } from "@/lib/db.ts";
import { addDomains } from "@/lib/domains.ts";
import { env } from "@/lib/env.ts";
import { loadDeployment, provisionDeployment } from "@/lib/provisioning.ts";
import { withSetupName } from "@/lib/setup-name.ts";

const page = (tenantId: string, deploymentId: string, hash = "") => `/customers/${tenantId}/deployments/${deploymentId}${hash}`;

async function owned(tenantId: string, deploymentId: string) {
  const row = await loadDeployment(tenantId, deploymentId);
  if (!row) redirect(`/customers/${tenantId}`);
  return row.deployment;
}

export async function retryProvisioning(tenantId: string, deploymentId: string): Promise<void> {
  const allowance = await kbAllowance({ fresh: true });
  const d = await owned(tenantId, deploymentId);
  if (!d.kbId && allowance?.left === 0) redirect(page(tenantId, deploymentId, "#provisioning"));
  await provisionDeployment(deploymentId, await actorId());
  revalidatePath("/", "layout");
  redirect(page(tenantId, deploymentId));
}

export async function syncNow(tenantId: string, deploymentId: string): Promise<void> {
  await owned(tenantId, deploymentId);
  await requestSync(deploymentId, await actorId());
  revalidatePath(page(tenantId, deploymentId));
  redirect(page(tenantId, deploymentId, "?synced=1#content"));
}

export async function retryFailed(tenantId: string, deploymentId: string): Promise<void> {
  await owned(tenantId, deploymentId);
  const n = await retryFailedPages(deploymentId, await actorId());
  revalidatePath(page(tenantId, deploymentId));
  redirect(page(tenantId, deploymentId, `?retried=${n}#content`));
}

export async function leaveOutPage(tenantId: string, deploymentId: string, url: string): Promise<void> {
  await owned(tenantId, deploymentId);
  await excludePage(deploymentId, url, await actorId());
  revalidatePath(`${page(tenantId, deploymentId)}/content`);
  redirect(`${page(tenantId, deploymentId)}/content?excluded=1`);
}

export interface ContentFormState {
  errors: Record<string, string>;
  saved: number;
  // The save started a running sync over with the new rules.
  restarted?: boolean;
}

export async function saveContent(
  tenantId: string,
  deploymentId: string,
  previous: ContentFormState,
  form: FormData,
): Promise<ContentFormState> {
  const d = await owned(tenantId, deploymentId);
  const parsed = parseContentForm(form, d.siteUrl);
  if ("errors" in parsed) return { errors: parsed.errors, saved: previous.saved };
  const { restarted } = await saveContentSettings(deploymentId, d.siteUrl, parsed.value, await actorId());
  revalidatePath(page(tenantId, deploymentId));
  return { errors: {}, saved: previous.saved + 1, restarted };
}

export async function setPaused(tenantId: string, deploymentId: string, paused: boolean): Promise<void> {
  const d = await owned(tenantId, deploymentId);
  if ((paused && d.status === "live") || (!paused && d.status === "paused")) {
    await db()
      .update(deployments)
      .set({ status: paused ? "paused" : "live" })
      .where(eq(deployments.id, deploymentId));
    await db()
      .insert(auditLog)
      .values(
        await withSetupName({
          actorUserId: await actorId(),
          action: paused ? "deployment.pause" : "deployment.resume",
          targetType: "deployment",
          targetId: deploymentId,
          detail: {},
        }),
      );
  }
  revalidatePath("/", "layout");
  redirect(page(tenantId, deploymentId, paused ? "?paused=1" : "?resumed=1"));
}

// The writer key for Sitefinity's connector. Credentials are for admins, and every reveal is
// audited.
export async function revealWriterKey(tenantId: string, deploymentId: string): Promise<{ key?: string; error?: string }> {
  const actor = await requireAdmin().catch(() => undefined);
  if (!actor) return { error: "Only admins can reveal keys. Ask an admin to copy it for you." };
  await owned(tenantId, deploymentId);
  const key = await loadKey(db(), env().masterKey, deploymentId, "writer");
  if (!key) return { error: "This deployment has no writer key. Retry provisioning to create one." };
  await db()
    .insert(auditLog)
    .values(
      await withSetupName({
        actorUserId: actor.id,
        action: "deployment.reveal-writer-key",
        targetType: "deployment",
        targetId: deploymentId,
        detail: {},
      }),
    );
  return { key };
}

// From the refused-domains list: allow it, here and in the KB's domain lock.
export async function allowRefusedOrigin(tenantId: string, deploymentId: string, origin: string): Promise<void> {
  await owned(tenantId, deploymentId);
  await addDomains(deploymentId, [origin], await actorId());
  await db()
    .delete(refusedOrigins)
    .where(and(eq(refusedOrigins.deploymentId, deploymentId), eq(refusedOrigins.origin, origin)));
  revalidatePath(page(tenantId, deploymentId));
  redirect(page(tenantId, deploymentId, "?allowed=1#go-live"));
}
