"use server";

// The validation panel's own actions: generate the test questions, check a flagged answer, fix
// a No answer (the site's pages that may answer it, Add these pages, The site doesn't cover
// this), and choose starter questions in the picker, each asked before it's ticked. (The run
// itself streams its progress from validation/run/route.ts.) Each checks the deployment belongs
// to the customer in the address, and every decision records the person (named sign-in, or a
// typed name in setup mode).

import { revalidatePath } from "next/cache";
import { currentUser } from "@/lib/auth.ts";
import { loadDeployment } from "@/lib/provisioning.ts";
import {
  acknowledgeFlag,
  addPagesByHand,
  addPagesFor,
  askStarter,
  askStartersBatch,
  chosenStarters,
  confirmationBy,
  type KeepAsk,
  MAX_STARTER_LENGTH,
  markNotCovered,
  needsCheck,
  type PageCandidate,
  pageCandidates,
  prepareQuestions,
  prepareStarters,
  type RunQuestion,
  runAgainNow,
  type StarterNeed,
  saveStarters,
  starterProblem,
  starterStatus,
} from "@/lib/validation.ts";

const page = (tenantId: string, deploymentId: string) => `/customers/${tenantId}/deployments/${deploymentId}`;

async function owned(tenantId: string, deploymentId: string) {
  const row = typeof tenantId === "string" && typeof deploymentId === "string" ? await loadDeployment(tenantId, deploymentId) : undefined;
  if (!row) throw new Error("This deployment no longer exists.");
  return row.deployment;
}

const text = (value: unknown, max: number) => (typeof value === "string" ? value.trim().slice(0, max) : "");

// Who is acting (in setup mode the panel asks for a typed name) and the widget's starters. How
// much is answerable now comes with the page, not from here: this is read once, on load.
export async function panelContext(tenantId: string, deploymentId: string) {
  const d = await owned(tenantId, deploymentId);
  const user = await currentUser();
  return {
    setupMode: user.setupMode,
    name: user.setupMode ? null : user.name,
    starters: d.widgetSettings.starters ?? [],
    // Every language's, which every run asks.
    allStarters: chosenStarters(d.widgetSettings),
    starterStatus: starterStatus(d),
  };
}

export async function generateTestQuestions(tenantId: string, deploymentId: string) {
  await owned(tenantId, deploymentId);
  return prepareQuestions(deploymentId);
}

type Done = { error?: string; needsName?: boolean; needsReason?: KeepAsk[] };

// The person, or the error that asks for their name.
async function who(typedName: unknown) {
  return confirmationBy(await currentUser(), text(typedName, 80));
}

export async function acknowledgeAnswer(
  tenantId: string,
  deploymentId: string,
  index: number,
  question: string,
  typedName?: string,
  foundAt?: string,
  // A held answer kept: why it's right (round 5).
  reason?: string,
): Promise<Done> {
  await owned(tenantId, deploymentId);
  const by = await who(typedName);
  if ("error" in by) return { error: by.error, needsName: true };
  const result = await acknowledgeFlag(
    deploymentId,
    Number(index),
    text(question, 300),
    by,
    text(foundAt, 500) || undefined,
    text(reason, 300) || undefined,
  );
  revalidatePath(page(tenantId, deploymentId));
  return "error" in result ? { error: result.error } : {};
}

// "Pages on the site that may answer this", under a No answer.
export async function answeringPages(
  tenantId: string,
  deploymentId: string,
  question: string,
): Promise<{ pages: PageCandidate[]; note?: string } | { error: string }> {
  await owned(tenantId, deploymentId);
  return pageCandidates(deploymentId, text(question, 300));
}

// "Add these pages". A page that trips a date or stale-price rule comes back in needsReason, not
// added, until it's sent again with a reason (`keep`): "Keep it anyway?".
export async function addPages(
  tenantId: string,
  deploymentId: string,
  index: number,
  question: string,
  urls: string[],
  typedName?: string,
  keep?: string,
): Promise<Done> {
  await owned(tenantId, deploymentId);
  const by = await who(typedName);
  if ("error" in by) return { error: by.error, needsName: true };
  const pages = (Array.isArray(urls) ? urls : []).slice(0, 5).map((u) => text(u, 2000));
  const reason = typeof keep === "string" ? text(keep, 300) : undefined;
  const result = await addPagesFor(deploymentId, Number(index), text(question, 300), pages, by, reason);
  revalidatePath(page(tenantId, deploymentId));
  revalidatePath(`${page(tenantId, deploymentId)}/content`);
  if ("error" in result) return { error: result.error, ...(result.needsReason && { needsReason: result.needsReason }) };
  return result.needsReason ? { needsReason: result.needsReason } : {};
}

// The picker's "Add these pages" under a suggestion with no answer: added to the sync (not tied
// to a validation question), with the same Keep it anyway step. The suggestion is asked again by
// hand once they're answerable.
export async function addPagesForStarter(
  tenantId: string,
  deploymentId: string,
  urls: string[],
  typedName?: string,
  keep?: string,
): Promise<Done & { added?: string[] }> {
  await owned(tenantId, deploymentId);
  const by = await who(typedName);
  if ("error" in by) return { error: by.error, needsName: true };
  const pages = (Array.isArray(urls) ? urls : []).slice(0, 5).map((u) => text(u, 2000));
  const result = await addPagesByHand(deploymentId, pages, by, typeof keep === "string" ? text(keep, 300) : undefined);
  revalidatePath(`${page(tenantId, deploymentId)}/content`);
  if ("error" in result) return { error: result.error };
  return { added: result.added, ...(result.needsReason.length && { needsReason: result.needsReason }) };
}

// "Run it now", while a run waits for half the pages: the last run's questions, asked now.
export async function runItNow(tenantId: string, deploymentId: string): Promise<Done> {
  await owned(tenantId, deploymentId);
  const result = await runAgainNow(deploymentId, (await currentUser()).id);
  revalidatePath(page(tenantId, deploymentId));
  revalidatePath(`${page(tenantId, deploymentId)}/review`);
  return "error" in result ? { error: result.error } : {};
}

export async function siteDoesntCover(
  tenantId: string,
  deploymentId: string,
  index: number,
  question: string,
  reason: string,
  typedName?: string,
): Promise<Done> {
  await owned(tenantId, deploymentId);
  const by = await who(typedName);
  if ("error" in by) return { error: by.error, needsName: true };
  const result = await markNotCovered(deploymentId, Number(index), text(question, 300), text(reason, 300), by);
  revalidatePath(page(tenantId, deploymentId));
  return "error" in result ? { error: result.error } : {};
}

export interface StarterChoice {
  text: string;
  // Generated from the site's content for the picker, or a question that passed validation.
  from: "suggested" | "validation" | "current";
  // Its answer in the latest validation run, when the run asked it with this wording.
  answer?: RunQuestion;
}

// What the picker offers: the starters the widget has now, questions that passed validation
// (first, as they're known to answer), and suggestions generated from the site. The suggestions
// stay the same each time the picker opens; `fresh` asks for new ones (one partner-test ask).
// Never a "What can you tell me about …" question, whatever its source: those are listed in
// `leftOut`. Nothing is saved here.
export async function starterChoices(
  tenantId: string,
  deploymentId: string,
  fresh = false,
): Promise<{
  choices: StarterChoice[];
  current: string[];
  confirmed: boolean;
  primary?: string;
  suggestedAt?: string;
  leftOut: string[];
  error?: string;
}> {
  const d = await owned(tenantId, deploymentId);
  const current = d.widgetSettings.starters ?? [];
  const run = (d.validation?.questions ?? []) as RunQuestion[];
  // Only what the picker can tick (round 6: it showed "Passed validation" on held rows).
  const passing = run.filter((q) => q.answered && !q.failure && !needsCheck(q)).map((q) => q.question);
  const generated = await prepareStarters(deploymentId, { fresh: fresh === true, actor: (await currentUser()).id });
  const seen = new Set<string>();
  const choices: StarterChoice[] = [];
  const leftOut: string[] = [];
  const add = (list: string[], from: StarterChoice["from"]) => {
    for (const q of list) {
      const key = q.trim().toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const answer = run.find((r) => r.question.trim().toLowerCase() === key);
      if (starterProblem(q)) leftOut.push(q.trim());
      else choices.push({ text: q.trim(), from, ...(answer && { answer }) });
    }
  };
  add(current, "current");
  add(passing, "validation");
  add("suggestions" in generated ? generated.suggestions : [], "suggested");
  return {
    choices,
    current,
    confirmed: Boolean(d.confirmations.starters),
    primary: d.theme.color?.primary,
    leftOut,
    ...("at" in generated && generated.at && { suggestedAt: generated.at }),
    ...("error" in generated && { error: generated.error }),
  };
}

// One suggestion asked as visitors will ask it, with the run's checks, before it can be ticked.
// A partner test: never billed. Nothing is saved.
export async function askStarterQuestion(
  tenantId: string,
  deploymentId: string,
  question: string,
): Promise<{ answer: RunQuestion } | { error: string }> {
  await owned(tenantId, deploymentId);
  return askStarter(deploymentId, text(question, MAX_STARTER_LENGTH));
}

// Several suggestions asked together on the server, a few at a time (server actions from one page
// run one after another, so the picker asks them in one call). Partner tests; nothing is saved.
export async function askStarterQuestions(
  tenantId: string,
  deploymentId: string,
  questions: string[],
): Promise<{ answers: { question: string; answer: RunQuestion }[] } | { error: string }> {
  await owned(tenantId, deploymentId);
  return askStartersBatch(
    deploymentId,
    (Array.isArray(questions) ? questions : []).slice(0, 30).map((q) => text(q, MAX_STARTER_LENGTH)),
  );
}

// `checked`: the Check this suggestions the person said "I checked it" to.
export async function chooseStarters(
  tenantId: string,
  deploymentId: string,
  chosen: string[],
  typedName?: string,
  checked: string[] = [],
  // Held suggestions kept, each with why it's right (round 5).
  decided: { question: string; reason: string }[] = [],
  // Where a figure no synced page states was found, per question (round 6).
  foundAt: { question: string; url: string }[] = [],
): Promise<{
  error?: string;
  needsName?: boolean;
  starters?: string[];
  asked?: number;
  // Each row Use these refused, what it needs, and its answer as asked this time.
  blocked?: { question: string; need: StarterNeed; why: string; answer: RunQuestion }[];
}> {
  await owned(tenantId, deploymentId);
  const by = await who(typedName);
  if ("error" in by) return { error: by.error, needsName: true };
  const result = await saveStarters(
    deploymentId,
    (Array.isArray(chosen) ? chosen : []).slice(0, 20).map((q) => text(q, 200)),
    by,
    (Array.isArray(checked) ? checked : []).slice(0, 20).map((q) => text(q, 200)),
    (Array.isArray(decided) ? decided : []).slice(0, 20).map((x) => ({ question: text(x?.question, 200), reason: text(x?.reason, 300) })),
    (Array.isArray(foundAt) ? foundAt : []).slice(0, 20).map((x) => ({ question: text(x?.question, 200), url: text(x?.url, 500) })),
  );
  revalidatePath(page(tenantId, deploymentId));
  revalidatePath(`${page(tenantId, deploymentId)}/widget`);
  revalidatePath(`${page(tenantId, deploymentId)}/review`);
  return result;
}
