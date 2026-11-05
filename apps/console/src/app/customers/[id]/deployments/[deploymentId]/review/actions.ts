"use server";

// Review and sign off: a named person confirms what visitors will see, which publishes the chat
// (it shows on sites from then on). Skipping the handoff or the privacy link is recorded the same
// way, so going without one is a decision, not an oversight.

import { auditLog, type DeploymentConfirmations, deployments } from "@launchpad/db";
import { languageSetting } from "@launchpad/theme";
import { eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { accountBlock } from "@/lib/account-block.ts";
import { applyAnsweringRules, saveAnswers } from "@/lib/answers.ts";
import { blockSignOffNote } from "@/lib/ask-refusal.ts";
import { actorId, currentUser } from "@/lib/auth.ts";
import { promptUpdate } from "@/lib/client-name.ts";
import { db } from "@/lib/db.ts";
import { loadDeploymentView } from "@/lib/deployment-view.ts";
import {
  CHECKS_VERSION,
  canSignOff,
  confirmationBy,
  priceTableLine,
  type Skippable,
  signedPriceHash,
  visitorSettingsHash,
} from "@/lib/review.ts";
import { withSetupName } from "@/lib/setup-name.ts";
import { runAgainNow } from "@/lib/validation.ts";
import { nothingOpen } from "@/lib/validation-rules.ts";

export interface ReviewActionState {
  error?: string;
}

const pagePath = (tenantId: string, deploymentId: string) => `/customers/${tenantId}/deployments/${deploymentId}`;

export async function signOffDeployment(
  tenantId: string,
  deploymentId: string,
  _previous: ReviewActionState,
  form: FormData,
): Promise<ReviewActionState> {
  // The same lines the person saw, the prompt the Knowledge Box answers with included.
  const view = await loadDeploymentView(tenantId, deploymentId, { servedPrompt: true });
  if (!view) redirect(`/customers/${tenantId}`);
  // The price table's line too (round 6), as Review shows it.
  const lines = [...view.review, priceTableLine(view.base, view.deployment.priceTable, view.deployment.priceTableConfirmation)];
  if (!canSignOff(lines)) return { error: "Some lines still need attention: fix or skip them first." };
  const blocked = await accountBlock(db()).catch(() => undefined);
  if (blocked) return { error: blockSignOffNote(blocked.state) };
  const confirmation = confirmationBy(await currentUser(), String(form.get("name") ?? ""));
  if ("error" in confirmation) return confirmation;
  const d = view.deployment;
  const settingsHash = visitorSettingsHash(d);
  // When the sign-off held after the first sync (the onboarding clock's second figure): kept
  // across a new sign-off, and now when the first sync has finished and the latest run leaves
  // nothing open.
  const heldAt = d.signOff?.heldAt ?? (nothingOpen(d.validation) ? new Date().toISOString() : undefined);
  await db().transaction(async (tx) => {
    await tx
      .update(deployments)
      // Stamped with the review's rules, so a later raise of the bar flags it (underOlderChecks).
      .set({
        signOff: {
          ...confirmation,
          settingsHash,
          checksVersion: CHECKS_VERSION,
          priceTableHash: signedPriceHash(d),
          ...(heldAt && { heldAt }),
        },
        published: true,
        readyAt: d.readyAt ?? new Date(),
      })
      .where(eq(deployments.id, d.id));
    await tx.insert(auditLog).values(
      await withSetupName({
        actorUserId: confirmation.by,
        action: "deployment.signoff",
        targetType: "deployment",
        targetId: d.id,
        detail: {
          name: confirmation.name,
          verified: confirmation.verified,
          settingsHash,
          checksVersion: CHECKS_VERSION,
          ...(view.olderChecks && { previousChecksVersion: view.deployment.signOff?.checksVersion ?? 1 }),
          // What it looked like at sign-off, line by line.
          lines: lines.map((l) => ({ key: l.key, state: l.state })),
          ...(view.signOff.state === "changed" && { replaces: view.signOff.signOff.at }),
        },
      }),
    );
  });
  revalidatePath(pagePath(tenantId, deploymentId));
  redirect(`${pagePath(tenantId, deploymentId)}?signedoff=1`);
}

// "Run it now" on Review's Validation line, while a run waits for half the pages: the last run's
// questions, asked now by the person.
export async function runValidationNow(tenantId: string, deploymentId: string): Promise<void> {
  const view = await loadDeploymentView(tenantId, deploymentId);
  if (!view) redirect(`/customers/${tenantId}`);
  const result = await runAgainNow(view.deployment.id, await actorId());
  revalidatePath(pagePath(tenantId, deploymentId));
  redirect(
    `${pagePath(tenantId, deploymentId)}/review${"error" in result ? `?run=${encodeURIComponent(result.error.slice(0, 400))}` : "?run=done"}`,
  );
}

export async function skipPart(
  tenantId: string,
  deploymentId: string,
  kind: Skippable,
  _previous: ReviewActionState,
  form: FormData,
): Promise<ReviewActionState> {
  const view = await loadDeploymentView(tenantId, deploymentId);
  if (!view) redirect(`/customers/${tenantId}`);
  const line = view.review.find((l) => l.skip?.kind === kind);
  if (!line) return { error: "That can't be skipped now." };
  const confirmation = confirmationBy(await currentUser(), String(form.get("name") ?? ""));
  if ("error" in confirmation) return confirmation;
  const patch: DeploymentConfirmations = { [kind]: { ...confirmation, ...(line.skip?.count !== undefined && { count: line.skip.count }) } };
  await db().transaction(async (tx) => {
    await tx
      .update(deployments)
      // A stored value that isn't an object would swallow the merge: start from {} then.
      .set({
        confirmations: sql`(case when jsonb_typeof(${deployments.confirmations}) = 'object' then ${deployments.confirmations} else '{}'::jsonb end) || ${JSON.stringify(patch)}::jsonb`,
      })
      .where(eq(deployments.id, deploymentId));
    await tx.insert(auditLog).values(
      await withSetupName({
        actorUserId: confirmation.by,
        action: "deployment.skip",
        targetType: "deployment",
        targetId: deploymentId,
        detail: { part: kind, name: confirmation.name, consequence: line.skip!.consequence },
      }),
    );
  });
  revalidatePath(`${pagePath(tenantId, deploymentId)}/review`);
  return {};
}

export async function undoSkip(tenantId: string, deploymentId: string, kind: Skippable): Promise<void> {
  const user = await currentUser();
  await db().transaction(async (tx) => {
    await tx
      .update(deployments)
      .set({ confirmations: sql`${deployments.confirmations} - ${kind}` })
      .where(eq(deployments.id, deploymentId));
    await tx.insert(auditLog).values(
      await withSetupName({
        actorUserId: user.id,
        action: "deployment.skip",
        targetType: "deployment",
        targetId: deploymentId,
        detail: { part: kind, undone: true, name: user.name },
      }),
    );
  });
  revalidatePath(`${pagePath(tenantId, deploymentId)}/review`);
}

// "Update the prompt": saves the current template with the name visitors see and the partner's
// own lines (lib/client-name.ts promptUpdate), computed again here from what's saved. `before` is
// the prompt the person looked at: if it changed meanwhile, nothing is saved.
export async function updatePrompt(tenantId: string, deploymentId: string, from: "review" | "up-to-date", form: FormData): Promise<void> {
  const view = await loadDeploymentView(tenantId, deploymentId);
  if (!view) redirect(`/customers/${tenantId}`);
  const d = view.deployment;
  const back =
    from === "up-to-date" ? `${pagePath(tenantId, deploymentId)}/review/up-to-date` : `${pagePath(tenantId, deploymentId)}/review/prompt`;
  if (String(form.get("before") ?? "") !== d.systemPrompt) redirect(`${back}?error=changed#prompt`);
  const update = promptUpdate(d, {
    internal: view.tenant.name,
    visible: view.tenant.displayName,
    previous: view.nameChanges.flatMap((c) => [c.before, c.after]),
  });
  if (!update) redirect(`${back}?error=name#prompt`);
  try {
    // Audited as "deployment.prompt", which Bring up to date reads as its prompt step.
    await saveAnswers(d.id, update.prompt, languageSetting(d.language), await actorId());
  } catch {
    redirect(`${back}?error=kb#prompt`);
  }
  revalidatePath(pagePath(tenantId, deploymentId));
  redirect(from === "up-to-date" ? `${back}?prompt=saved#prompt` : `${pagePath(tenantId, deploymentId)}/review?prompt=updated`);
}

// "Switch to the newer rules", under Review's side-by-side when the rules rollout held this
// deployment (round 5, item 6): a named person applies the latest answering rules after seeing
// which answers they change. Audited as deployment.rules.applied with the person's name.
export async function switchAnsweringRules(
  tenantId: string,
  deploymentId: string,
  _previous: ReviewActionState,
  form: FormData,
): Promise<ReviewActionState> {
  const view = await loadDeploymentView(tenantId, deploymentId);
  if (!view) redirect(`/customers/${tenantId}`);
  const confirmation = confirmationBy(await currentUser(), String(form.get("name") ?? ""));
  if ("error" in confirmation) return confirmation;
  const result = await applyAnsweringRules(deploymentId, { who: confirmation }).catch((err: unknown) => ({
    error: `The Knowledge Box didn't take the newer rules: ${err instanceof Error ? err.message : String(err)}`,
  }));
  if ("error" in result) return { error: result.error };
  revalidatePath(pagePath(tenantId, deploymentId));
  redirect(`${pagePath(tenantId, deploymentId)}/review?rules=${result.version}`);
}
