"use server";

// The Content page's own action: Always include, for a page found by searching the sitemap or
// left out by the sync. It's kept whatever the budget and the plan's rules, and loaded ahead of
// every waiting page. A page that trips a date or stale-price rule asks first ("This page
// states a price and was published 11 Oct 2016. Keep it anyway?"), and is kept only with a
// reason and a name (typed, in setup mode).

import type { Confirmation } from "@launchpad/db";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth.ts";
import { excludePage, type PageCandidate, pinPages, reextractNow, sitemapCandidates } from "@/lib/content.ts";
import { loadDeployment } from "@/lib/provisioning.ts";

export interface FindState {
  // The words searched, and what they found (matches first, then near misses).
  q?: string;
  pages?: PageCandidate[];
  error?: string;
}

// Find a page, wherever it's shown (Content, and the pages panel under a question with no
// answer, filled in with the question's words): every page in the sitemap by its address and
// title, every synced page by its text, each word on its own, with near misses.
export async function findPages(tenantId: string, deploymentId: string, _previous: FindState, form: FormData): Promise<FindState> {
  const row = await loadDeployment(tenantId, deploymentId);
  if (!row) redirect(`/customers/${tenantId}`);
  const q = field(form, "q", 200);
  if (!q) return { error: "Type a word or two from the page you're looking for." };
  try {
    const pages = await sitemapCandidates(deploymentId, q, 10);
    return { q, pages };
  } catch {
    return { q, error: "The site's pages couldn't be read just now. Try again shortly." };
  }
}

export interface IncludeState {
  added?: boolean;
  // The rule it trips, asked before keeping it.
  keep?: { url: string; rule: string; title?: string };
  error?: string;
  // The error asks for the name field.
  needsName?: boolean;
}

const field = (form: FormData, name: string, max: number) =>
  String(form.get(name) ?? "")
    .trim()
    .slice(0, max);

export async function alwaysInclude(
  tenantId: string,
  deploymentId: string,
  url: string,
  _previous: IncludeState,
  form: FormData,
): Promise<IncludeState> {
  const row = await loadDeployment(tenantId, deploymentId);
  if (!row) redirect(`/customers/${tenantId}`);
  const user = await currentUser();
  const asked =
    form.get("keep") === "1" ? { url, rule: field(form, "rule", 300), title: field(form, "title", 300) || undefined } : undefined;
  let keep: { reason: string; who: Confirmation } | undefined;
  if (asked) {
    const reason = field(form, "reason", 300);
    if (reason.length < 3) return { keep: asked, error: "Say in a line why it should be kept, for the person who signs off." };
    const at = new Date().toISOString();
    const typed = field(form, "name", 80);
    if (user.setupMode && !typed)
      return { keep: asked, error: "Type your name: in setup mode the console doesn't know who you are.", needsName: true };
    const who: Confirmation = user.setupMode
      ? { by: null, name: typed, at, verified: false }
      : { by: user.id, name: user.name, at, verified: true };
    keep = { reason, who };
  }
  const result = await pinPages(deploymentId, [url], user.id, keep);
  revalidatePath(`/customers/${tenantId}/deployments/${deploymentId}/content`);
  if (result.added.length) return { added: true };
  const needs = result.needsReason[0];
  if (needs) return { keep: { url: needs.url, rule: needs.rule, ...(needs.title && { title: needs.title }) } };
  return { error: result.refused[0]?.reason ?? "Not added." };
}

// Leave out, from a Content row: the page leaves the chat now (the worker takes it out of the
// Knowledge Box within a minute, even while another sync runs) and its path joins Leave out. The
// row's control keeps focus on its result (leave-out.tsx).
export async function leaveOut(tenantId: string, deploymentId: string, url: string): Promise<{ done?: boolean; error?: string }> {
  const row = await loadDeployment(tenantId, deploymentId);
  if (!row) redirect(`/customers/${tenantId}`);
  const user = await currentUser();
  try {
    await excludePage(deploymentId, url, user.id);
  } catch {
    return { error: "It couldn't be left out just now. Try again in a minute." };
  }
  revalidatePath(`/customers/${tenantId}/deployments/${deploymentId}/content`);
  revalidatePath(`/customers/${tenantId}/deployments/${deploymentId}`);
  return { done: true };
}

// Read the pages again: pages read under an older extractor or rules are read now, staying in the
// chat meanwhile. The page comes back with the result, which takes focus.
export async function readPagesAgain(tenantId: string, deploymentId: string): Promise<void> {
  const row = await loadDeployment(tenantId, deploymentId);
  if (!row) redirect(`/customers/${tenantId}`);
  const n = await reextractNow(deploymentId, (await currentUser()).id);
  revalidatePath(`/customers/${tenantId}/deployments/${deploymentId}/content`);
  redirect(`/customers/${tenantId}/deployments/${deploymentId}/content?reread=${n}#summary`);
}
