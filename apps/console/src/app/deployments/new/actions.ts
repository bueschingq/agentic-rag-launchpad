"use server";

// Creates a deployment with its content plan, provisions its Knowledge Box (about 5–10 s
// against Agentic RAG), then shows the result. The plan becomes the sync's settings before the
// first sync can start, and the scan started on the form is saved once the deployment exists.
// A failed step leaves the deployment "failed" with a retry button.

import { LANGUAGES } from "@launchpad/theme";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { after } from "next/server";
import { actorId } from "@/lib/auth.ts";
import { capacityMessage, kbAllowance, waitingForKb } from "@/lib/capacity.ts";
import { applyPlan } from "@/lib/content.ts";
import { type PlanFormValue, parsePlanForm } from "@/lib/content-form.ts";
import { planContent, planSummary } from "@/lib/content-plan.ts";
import { parseDeploymentForm } from "@/lib/deployment-form.ts";
import { type FormState, failed } from "@/lib/form-state.ts";
import { createDeployment, loadCustomerOptions, provisionDeployment } from "@/lib/provisioning.ts";
import { saveScan } from "@/lib/widget.ts";
import { sitemapEntries, takeScan } from "./site-cache.ts";

// The plan as the partner saw it, recomputed from the same sitemap read with their choices.
async function acceptedPlan(siteUrl: string, served: string[], choices: PlanFormValue) {
  try {
    const read = await sitemapEntries(siteUrl, choices.sitemap);
    if (!read.total) return undefined;
    const plan = planContent({
      entries: read.entries,
      served,
      languages: choices.languages,
      rules: choices.rules,
      include: choices.include,
      exclude: choices.exclude,
      budget: choices.pageBudget,
      today: new Date(),
    });
    return planSummary(plan, new Date());
  } catch {
    // No sitemap to read: the sync crawls from the site address instead.
    return undefined;
  }
}

export async function saveDeployment(previous: FormState, form: FormData): Promise<FormState> {
  const actor = await actorId();
  const parsed = parseDeploymentForm(form);
  const plan = parsePlanForm(form);
  if ("errors" in parsed || "errors" in plan) {
    return failed(previous, form, { ...("errors" in parsed ? parsed.errors : {}), ...("errors" in plan ? plan.errors : {}) });
  }
  // Checked again here: the allowance may have run out since the page loaded.
  const allowance = await kbAllowance({ fresh: true });
  if (allowance?.left === 0) return failed(previous, form, { _form: capacityMessage(allowance, await waitingForKb()).text });

  const customer = (await loadCustomerOptions()).find((c) => c.id === parsed.value.customerId);
  const language = parsed.value.language ?? customer?.language ?? "en";
  const served = language === "auto" ? LANGUAGES.map((l) => l.code) : [language];
  const summary = await acceptedPlan(parsed.value.siteUrl, served, plan.value);

  // The extra domains the partner marked as staging, when the form showed them; else
  // createDeployment's default (every extra domain but the site's www/apex twin).
  const stagingDomains = form.has("stagingShown")
    ? form
        .getAll("stagingDomains")
        .map(String)
        .filter((o) => parsed.value.domains.includes(o))
    : undefined;

  let id: string | undefined;
  try {
    id = await createDeployment({ ...parsed.value, ...(stagingDomains && { stagingDomains }) }, actor);
  } catch (err) {
    // Reaching Agentic RAG (NUA key, zone) happens before anything is stored.
    return failed(previous, form, { _form: `Couldn't reach Agentic RAG: ${err instanceof Error ? err.message : err}` });
  }
  if (!id) return failed(previous, form, { customerId: "That customer no longer exists. Choose another." });
  await applyPlan(id, plan.value, summary, actor);

  // The scan usually finished while the partner read the plan: it's saved before the deployment
  // page opens, so that page doesn't offer Scan. If not, it's saved when it finishes.
  const scan = takeScan(plan.value.scanToken, parsed.value.siteUrl);
  if (scan) {
    const deploymentId = id;
    const ready = await Promise.race([scan, new Promise<"running">((resolve) => setTimeout(resolve, 100, "running"))]);
    if (ready !== "running") {
      if (ready) await saveScan(deploymentId, ready, actor);
    } else
      after(async () => {
        const result = await scan;
        if (result) await saveScan(deploymentId, result, actor);
      });
  }

  await provisionDeployment(id, actor);
  revalidatePath("/", "layout");
  redirect(`/customers/${parsed.value.customerId}/deployments/${id}`);
}
