"use server";

// Changes after provisioning: allowed domains (here and in the KB's domain lock), the prompt
// and answer language (saved to the KB, every version kept), and where leads go. Each change
// is audited with before and after.

import { webhookUrlProblem } from "@launchpad/notify";
import { isLanguage, type LanguageSetting } from "@launchpad/theme";
import { revalidatePath } from "next/cache";
import { saveAnswers, saveLeadDelivery, tryPrompt } from "@/lib/answers.ts";
import { actorId } from "@/lib/auth.ts";
import { MAX_PROMPT } from "@/lib/deployment-form.ts";
import { isStagingOrigin, parseDomains } from "@/lib/domain-rules.ts";
import { setDomains } from "@/lib/domains.ts";
import { loadDeployment } from "@/lib/provisioning.ts";
import { runPreflight } from "@/lib/validation.ts";

export interface EditState {
  error?: string;
  saved: number;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const fail = (previous: EditState, error: string): EditState => ({ error, saved: previous.saved });
const done = (previous: EditState): EditState => ({ saved: previous.saved + 1 });

async function owned(tenantId: string, deploymentId: string) {
  const row = await loadDeployment(tenantId, deploymentId);
  if (!row) throw new Error("This deployment no longer exists.");
  return row.deployment;
}

const refresh = (tenantId: string, deploymentId: string) => {
  revalidatePath(`/customers/${tenantId}/deployments/${deploymentId}`);
  revalidatePath(`/customers/${tenantId}/deployments/${deploymentId}/edit`);
};

export async function saveDomainsAction(tenantId: string, deploymentId: string, previous: EditState, form: FormData): Promise<EditState> {
  await owned(tenantId, deploymentId);
  const parsed = parseDomains(String(form.get("domains") ?? ""));
  if ("error" in parsed) return fail(previous, parsed.error);
  const staging = form.getAll("staging").map(String);
  try {
    await setDomains(
      deploymentId,
      parsed.domains,
      await actorId(),
      parsed.domains.filter((o) => staging.includes(o) || isStagingOrigin(o, [])),
    );
  } catch (err) {
    return fail(previous, `Agentic RAG didn't take the change: ${err instanceof Error ? err.message : err}`);
  }
  refresh(tenantId, deploymentId);
  return done(previous);
}

export async function checkDomainLock(tenantId: string, deploymentId: string) {
  await owned(tenantId, deploymentId);
  const result = await runPreflight(deploymentId);
  refresh(tenantId, deploymentId);
  return result;
}

const languageFrom = (value: FormDataEntryValue | null): LanguageSetting | undefined =>
  value === "auto" || isLanguage(value) ? (value as LanguageSetting) : undefined;

export async function saveAnswersAction(tenantId: string, deploymentId: string, previous: EditState, form: FormData): Promise<EditState> {
  await owned(tenantId, deploymentId);
  const prompt = String(form.get("prompt") ?? "").trim();
  const language = languageFrom(form.get("language"));
  if (!prompt) return fail(previous, "Write the prompt, or start from a template.");
  if (prompt.length > MAX_PROMPT) return fail(previous, `Keep the prompt under ${MAX_PROMPT.toLocaleString("en")} characters.`);
  if (!language) return fail(previous, "Choose a language.");
  try {
    await saveAnswers(deploymentId, prompt, language, await actorId());
  } catch (err) {
    return fail(previous, `Agentic RAG didn't take the change: ${err instanceof Error ? err.message : err}`);
  }
  refresh(tenantId, deploymentId);
  return done(previous);
}

export async function tryPromptAction(tenantId: string, deploymentId: string, prompt: string, language: string, question: string) {
  await owned(tenantId, deploymentId);
  const lang = languageFrom(language);
  if (!prompt.trim() || !question.trim() || !lang) return { error: "Write a prompt and a question." };
  return tryPrompt(deploymentId, prompt.trim().slice(0, MAX_PROMPT), lang, question.trim().slice(0, 500));
}

export async function saveLeadsAction(tenantId: string, deploymentId: string, previous: EditState, form: FormData): Promise<EditState> {
  await owned(tenantId, deploymentId);
  const webhook = String(form.get("leadWebhookUrl") ?? "").trim();
  const emails = String(form.get("leadEmails") ?? "")
    .split(/[\s,;]+/)
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  if (webhook && webhookUrlProblem(webhook)) return fail(previous, `Lead webhook: ${webhookUrlProblem(webhook)}`);
  const bad = emails.find((e) => !EMAIL.test(e));
  if (bad) return fail(previous, `"${bad}" isn't an email address.`);
  if (emails.length > 10) return fail(previous, "Send leads to at most 10 addresses.");
  await saveLeadDelivery(deploymentId, webhook || null, emails, await actorId());
  refresh(tenantId, deploymentId);
  return done(previous);
}
