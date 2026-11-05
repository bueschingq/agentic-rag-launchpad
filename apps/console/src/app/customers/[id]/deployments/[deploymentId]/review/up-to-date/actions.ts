"use server";

// Bring up to date's steps: apply today's content rules (all, or the pages the person ticked)
// and read every page again; add the site's key pages; keep the current prompt; run validation
// again with the intent questions. Saving the new prompt is "Update the prompt" (../actions.ts).
// Each step leaves its audit entry (record.ts), and only when its button is clicked.

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { actorId, currentUser } from "@/lib/auth.ts";
import { addKeyPages, applyUpToDate, reextractNow } from "@/lib/content.ts";
import { loadDeploymentView } from "@/lib/deployment-view.ts";
import { confirmationBy } from "@/lib/review.ts";
import { runValidation } from "@/lib/validation.ts";
import { recordPromptKept } from "./record.ts";

const pagePath = (tenantId: string, deploymentId: string) => `/customers/${tenantId}/deployments/${deploymentId}`;

async function owned(tenantId: string, deploymentId: string) {
  const view = await loadDeploymentView(tenantId, deploymentId);
  if (!view) redirect(`/customers/${tenantId}`);
  return view.deployment;
}

export async function applyContent(tenantId: string, deploymentId: string, form: FormData): Promise<void> {
  const d = await owned(tenantId, deploymentId);
  const all = form.get("all") === "1";
  const back = `${pagePath(tenantId, d.id)}/review/up-to-date`;
  try {
    // Recorded by applyUpToDate itself ("content.up-to-date"), which Review reads.
    await applyUpToDate(d.id, await actorId(), all ? undefined : form.getAll("url").map(String));
  } catch {
    redirect(`${back}?error=content#content`);
  }
  revalidatePath(pagePath(tenantId, d.id));
  redirect(`${back}?applied=1#content`);
}

// Read the pages again: step 1's own button. Pages read by an older extractor or rules are read
// again now, staying in the chat meanwhile; what today's rules would leave out fills in as they
// are. Opening the page never does this.
export async function readAgain(tenantId: string, deploymentId: string): Promise<void> {
  const d = await owned(tenantId, deploymentId);
  await reextractNow(d.id, await actorId());
  revalidatePath(pagePath(tenantId, d.id));
  redirect(`${pagePath(tenantId, d.id)}/review/up-to-date?reading=1#content`);
}

export interface KeyPagesState {
  error?: string;
  // The error is about the name field.
  needsName?: boolean;
}

// "Add": the site's key pages join the sync and the pages at the end of the budget leave
// (addKeyPages, audited as content.key-pages, which switches the live deployment to today's
// selection). In setup mode, the typed name goes on the record, marked as not verified.
export async function addKeys(tenantId: string, deploymentId: string, _previous: KeyPagesState, form: FormData): Promise<KeyPagesState> {
  const d = await owned(tenantId, deploymentId);
  const user = await currentUser();
  const confirmation = confirmationBy(user, String(form.get("name") ?? ""));
  if ("error" in confirmation) return { error: confirmation.error, needsName: true };
  try {
    await addKeyPages(d.id, user.id, user.setupMode ? confirmation.name : undefined);
  } catch {
    return { error: "The key pages couldn't be added just now: the site's sitemap may not answer. Try again in a minute." };
  }
  revalidatePath(pagePath(tenantId, d.id));
  redirect(`${pagePath(tenantId, d.id)}/review/up-to-date?keys=added#keys`);
}

export async function keepPrompt(tenantId: string, deploymentId: string): Promise<void> {
  const d = await owned(tenantId, deploymentId);
  await recordPromptKept(d.id);
  redirect(`${pagePath(tenantId, d.id)}/review/up-to-date?prompt=kept#prompt`);
}

// The last run's questions, the intent questions it lacks (prepareQuestions' intents, in place of
// generated ones) and the starters, asked again on the pages as they now are.
export async function validateAgain(tenantId: string, deploymentId: string): Promise<void> {
  const d = await owned(tenantId, deploymentId);
  const back = `${pagePath(tenantId, d.id)}/review/up-to-date`;
  const result = await runValidation(d.id, await actorId(), undefined, { addIntents: true });
  if ("error" in result) redirect(`${back}?error=validation&why=${encodeURIComponent(result.error)}#validate`);
  revalidatePath(pagePath(tenantId, d.id));
  redirect(`${back}?validated=${result.validation.passed ? "passed" : "failed"}#validate`);
}
