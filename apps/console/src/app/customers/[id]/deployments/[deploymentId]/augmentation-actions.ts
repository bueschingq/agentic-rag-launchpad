"use server";

// The Agentic RAG agents pilot on one deployment: turn the agents on (its existing pages are then
// processed again by the worker, a batch a minute) or off. They add model use for every page, so
// both are for admins; each is audited (lib/augmentation.ts).

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { augmentDeployment, removeAugmentation } from "@/lib/augmentation.ts";
import { requireAdmin } from "@/lib/auth.ts";
import { loadDeployment } from "@/lib/provisioning.ts";

const page = (tenantId: string, deploymentId: string, query = "") => `/customers/${tenantId}/deployments/${deploymentId}${query}#agents`;

async function provisioned(tenantId: string, deploymentId: string) {
  const row = await loadDeployment(tenantId, deploymentId);
  if (!row) redirect(`/customers/${tenantId}`);
  if (!row.deployment.kbId || !["live", "paused"].includes(row.deployment.status)) redirect(page(tenantId, deploymentId));
  return row.deployment;
}

export async function turnOnAgents(tenantId: string, deploymentId: string): Promise<void> {
  const actor = await requireAdmin();
  await provisioned(tenantId, deploymentId);
  let outcome = "on";
  try {
    await augmentDeployment(deploymentId, { actor: actor.id });
  } catch (err) {
    outcome = `failed:${encodeURIComponent((err instanceof Error ? err.message : String(err)).slice(0, 300))}`;
  }
  revalidatePath(page(tenantId, deploymentId).replace("#agents", ""));
  redirect(page(tenantId, deploymentId, `?agents=${outcome}`));
}

export async function turnOffAgents(tenantId: string, deploymentId: string): Promise<void> {
  const actor = await requireAdmin();
  await provisioned(tenantId, deploymentId);
  let outcome = "off";
  try {
    await removeAugmentation(deploymentId, actor.id);
  } catch (err) {
    outcome = `failed:${encodeURIComponent((err instanceof Error ? err.message : String(err)).slice(0, 300))}`;
  }
  revalidatePath(page(tenantId, deploymentId).replace("#agents", ""));
  redirect(page(tenantId, deploymentId, `?agents=${outcome}`));
}
