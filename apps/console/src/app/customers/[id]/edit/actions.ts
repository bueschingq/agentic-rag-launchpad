"use server";

// Saves an edited customer, pauses or resumes all of its chats, and after a change of "Name
// visitors see", updates every deployment that still uses an old name ("Update all").

import { auditLog, deployments } from "@launchpad/db";
import { languageSetting } from "@launchpad/theme";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { saveAnswers } from "@/lib/answers.ts";
import { actorId } from "@/lib/auth.ts";
import { otherNames, renamedWidgetText } from "@/lib/client-name.ts";
import { parseCustomerForm } from "@/lib/customer-form.ts";
import { clientNaming, setCustomerPaused, updateCustomer } from "@/lib/customers.ts";
import { db } from "@/lib/db.ts";
import { type FormState, failed } from "@/lib/form-state.ts";
import { renameClient } from "@/lib/prompt-templates.ts";
import { withSetupName } from "@/lib/setup-name.ts";
import { saveWidget } from "@/lib/widget.ts";

export async function saveEditedCustomer(tenantId: string, previous: FormState, form: FormData): Promise<FormState> {
  const parsed = parseCustomerForm(form);
  if ("errors" in parsed) return failed(previous, form, parsed.errors);
  await updateCustomer(tenantId, parsed.value, await actorId());
  revalidatePath("/", "layout");
  redirect(`/customers/${tenantId}?saved=1#client-name`);
}

export async function pauseCustomer(tenantId: string, paused: boolean): Promise<void> {
  await setCustomerPaused(tenantId, paused, await actorId());
  revalidatePath("/", "layout");
  redirect(`/customers/${tenantId}?${paused ? "paused" : "resumed"}=1`);
}

// "Update all": in each deployment, every other name for the client (the internal one, earlier
// ones) becomes the name visitors see, in the prompt (saved to the Knowledge Box) and the
// widget's text. Each is a visitor-facing change, so the deployment shows "Changed since
// sign-off" and waits for a new one. A prompt that never named the client isn't guessed at: it
// stays listed with "Update the prompt".
export async function updateClientName(tenantId: string): Promise<void> {
  const naming = await clientNaming(tenantId);
  const visible = naming?.visible?.trim();
  if (!naming || !visible) redirect(`/customers/${tenantId}/edit#displayName`);
  const others = otherNames(visible, [naming.internal, ...naming.previous]);
  const actor = await actorId();
  let updated = 0;
  let failedCount = 0;
  for (const d of naming.deployments) {
    if (!d.problems.some((p) => p.kind === "other-name")) continue;
    const prompt = renameClient(d.systemPrompt, visible, others);
    const widget = renamedWidgetText(d.widgetSettings, visible, others);
    try {
      if (prompt !== d.systemPrompt && d.kbId) await saveAnswers(d.id, prompt, languageSetting(d.language), actor);
      else if (prompt !== d.systemPrompt) {
        // Not provisioned yet: the prompt reaches the Knowledge Box when it's created.
        await db().update(deployments).set({ systemPrompt: prompt }).where(eq(deployments.id, d.id));
        await db()
          .insert(auditLog)
          .values(
            await withSetupName({
              actorUserId: actor,
              action: "deployment.prompt",
              targetType: "deployment",
              targetId: d.id,
              detail: { before: { prompt: d.systemPrompt }, after: { prompt }, reason: "client-name" },
            }),
          );
      }
      if (widget) await saveWidget(tenantId, d.id, { theme: d.theme, settings: widget }, actor);
      if (prompt !== d.systemPrompt || widget) updated++;
    } catch {
      failedCount++;
    }
  }
  revalidatePath("/", "layout");
  redirect(`/customers/${tenantId}?renamed=${updated}${failedCount ? `&renameFailed=${failedCount}` : ""}#client-name`);
}
