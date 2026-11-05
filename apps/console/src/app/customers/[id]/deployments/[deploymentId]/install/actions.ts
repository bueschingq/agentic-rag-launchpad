"use server";

// The install guide's actions: check a page, and share or revoke read-only links to the guide.

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { actorId } from "@/lib/auth.ts";
import { checkDeploymentInstall } from "@/lib/install.ts";
import { loadDeployment } from "@/lib/provisioning.ts";
import { createShareLink, revokeShareLink } from "@/lib/share.ts";

const guide = (tenantId: string, deploymentId: string) => `/customers/${tenantId}/deployments/${deploymentId}/install`;

export async function checkInstallAction(tenantId: string, deploymentId: string, url: string) {
  if (!(await loadDeployment(tenantId, deploymentId))) return { error: "This deployment no longer exists." };
  return checkDeploymentInstall(deploymentId, url, { actor: await actorId() });
}

export async function shareGuide(tenantId: string, deploymentId: string): Promise<void> {
  if (!(await loadDeployment(tenantId, deploymentId))) redirect(`/customers/${tenantId}`);
  const link = await createShareLink("install", tenantId, deploymentId, await actorId());
  revalidatePath(guide(tenantId, deploymentId));
  redirect(`${guide(tenantId, deploymentId)}?link=${encodeURIComponent(link)}#share`);
}

export async function revokeGuideLink(tenantId: string, deploymentId: string, linkId: string): Promise<void> {
  await revokeShareLink(linkId, tenantId, await actorId());
  revalidatePath(guide(tenantId, deploymentId));
  redirect(`${guide(tenantId, deploymentId)}?revoked=1#share`);
}
