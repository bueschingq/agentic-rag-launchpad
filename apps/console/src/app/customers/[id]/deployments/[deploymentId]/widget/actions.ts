"use server";

// Scans the customer's site with the sniffer (10–30 s), saves the widget's theme and settings,
// and records a person's confirmation of the brand and of the starter questions. Sites pick a
// save up within the public config's one-minute cache. A scan changes nothing on the widget.
// A confirmation that wasn't recorded says so: the review's gate stays shut without it.

import { revalidatePath } from "next/cache";
import { actorId, currentUser } from "@/lib/auth.ts";
import type { FormErrors } from "@/lib/customer-form.ts";
import { confirmationBy } from "@/lib/review.ts";
import { ScanError, scanSite } from "@/lib/sniffer.ts";
import { askStarters } from "@/lib/validation.ts";
import { chosenStarters } from "@/lib/validation-rules.ts";
import {
  ConfirmationNotRecorded,
  type Confirmed,
  confirmedOf,
  loadWidgetPage,
  type ScanSummary,
  saveConfirmation,
  saveScan,
  saveWidget,
} from "@/lib/widget.ts";
import { parseWidgetDraft, scanTarget } from "@/lib/widget-form.ts";

export type ScanResult = { scan: ScanSummary } | { error: string };

const NOT_RECORDED =
  "Saved, but the confirmation wasn't recorded. Reload the page and confirm again; if it happens again, tell your console's admin.";

// Usually the deployment's site, but any page of it can be scanned (one with its main buttons,
// say), and imported deployments have no site address of their own.
export async function runScan(tenantId: string, deploymentId: string, pageUrl: string): Promise<ScanResult> {
  const target = scanTarget(pageUrl);
  if (!target) return { error: "Enter the address of a public web page, e.g. https://www.example.com." };
  const page = await loadWidgetPage(tenantId, deploymentId);
  if (!page) return { error: "This deployment no longer exists." };
  try {
    const scan = await scanSite(target);
    return { scan: await saveScan(deploymentId, scan, await actorId()) };
  } catch (err) {
    if (err instanceof ScanError) return { error: err.message };
    throw err;
  }
}

export interface SaveState {
  errors: FormErrors;
  // Counts successful saves, so the page can tell a new one from the last.
  saved: number;
  confirmed?: Confirmed;
  // Said after the save, e.g. why a confirmation wasn't recorded.
  notice?: string;
  // The save went through, but a confirmation asked for with it wasn't recorded.
  unrecorded?: boolean;
}

// The form carries the draft, and also:
// - startersChosen: the starter questions were typed or kept by this person, so the save
//   records them as chosen (confirmations.starters).
// - confirmBrand: "Save and confirm brand", recording the brand as saved.
// - typedName: in setup mode, the name to record with a confirmation.
export async function saveWidgetSettings(tenantId: string, deploymentId: string, previous: SaveState, form: FormData): Promise<SaveState> {
  const parsed = parseWidgetDraft(String(form.get("draft") ?? ""));
  if ("errors" in parsed) return { ...previous, errors: parsed.errors, notice: undefined };
  const confirmBrand = form.get("confirmBrand") === "1";
  const startersChosen = form.get("startersChosen") === "1";
  const user = await currentUser();
  const by = confirmBrand || startersChosen ? confirmationBy(user, String(form.get("typedName") ?? "")) : undefined;
  if (confirmBrand && by && "error" in by) return { ...previous, errors: { typedName: by.error }, notice: undefined };
  const before = await loadWidgetPage(tenantId, deploymentId);
  if (!(await saveWidget(tenantId, deploymentId, parsed.value, user.id))) {
    return { ...previous, errors: { _form: "This deployment no longer exists." }, notice: undefined };
  }
  // Starters changed here are asked into the latest validation run, as the picker does, so
  // none reaches visitors unasked.
  if (
    before &&
    JSON.stringify(chosenStarters(before.deployment.widgetSettings)) !== JSON.stringify(chosenStarters(parsed.value.settings))
  ) {
    await askStarters(deploymentId);
  }
  let confirmed: Confirmed | undefined;
  let notice: string | undefined;
  let unrecorded = false;
  if (by && !("error" in by)) {
    for (const part of [...(startersChosen ? (["starters"] as const) : []), ...(confirmBrand ? (["brand"] as const) : [])]) {
      try {
        const saved = await saveConfirmation(tenantId, deploymentId, part, by, user.id);
        if (saved) confirmed = confirmedOf(saved);
      } catch (err) {
        if (!(err instanceof ConfirmationNotRecorded)) throw err;
        unrecorded = true;
      }
    }
  } else if (startersChosen) notice = "Saved. To record who chose the starter questions, type your name and save again.";
  revalidatePath(`/customers/${tenantId}/deployments/${deploymentId}`);
  if (!confirmed) {
    const page = await loadWidgetPage(tenantId, deploymentId);
    if (page)
      confirmed = confirmedOf({
        theme: page.deployment.theme,
        settings: page.deployment.widgetSettings,
        confirmations: page.deployment.confirmations,
      });
  }
  return {
    errors: {},
    saved: previous.saved + 1,
    confirmed,
    notice: unrecorded ? NOT_RECORDED : notice,
    ...(unrecorded && { unrecorded }),
  };
}

// "Confirm brand": the chat name, avatar and primary color as saved now.
export async function confirmBrand(
  tenantId: string,
  deploymentId: string,
  typedName: string,
): Promise<{ confirmed: Confirmed } | { error: string }> {
  const user = await currentUser();
  const by = confirmationBy(user, typedName);
  if ("error" in by) return by;
  let saved: Awaited<ReturnType<typeof saveConfirmation>>;
  try {
    saved = await saveConfirmation(tenantId, deploymentId, "brand", by, user.id);
  } catch (err) {
    if (err instanceof ConfirmationNotRecorded)
      return { error: "The confirmation wasn't recorded. Reload the page and try again; if it happens again, tell your console's admin." };
    throw err;
  }
  if (!saved) return { error: "This deployment no longer exists." };
  revalidatePath(`/customers/${tenantId}/deployments/${deploymentId}`);
  return { confirmed: confirmedOf(saved) };
}
