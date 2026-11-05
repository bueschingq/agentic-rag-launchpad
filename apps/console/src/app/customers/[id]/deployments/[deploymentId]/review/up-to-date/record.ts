// Bring up to date's steps, from the audit log since the sign-off being brought up to date: the
// pages (applyUpToDate's "content.up-to-date"), the key pages (addKeyPages' "content.key-pages"),
// the prompt (a save, or keeping it, recorded here), and validation run again. The content step
// lifts "signed off under older checks" from Review's Content line once the pages are read again.

import { auditLog, users } from "@launchpad/db";
import { and, desc, eq, gt, inArray } from "drizzle-orm";
import { actorId } from "@/lib/auth.ts";
import { db } from "@/lib/db.ts";
import { withSetupName } from "@/lib/setup-name.ts";

export const CONTENT_APPLIED = "content.up-to-date";
export const KEY_PAGES_ADDED = "content.key-pages";
const PROMPT_KEPT = "deployment.up-to-date";

// "Keep the current prompt": a decision with no other trace.
export async function recordPromptKept(deploymentId: string): Promise<void> {
  await db()
    .insert(auditLog)
    .values(
      await withSetupName({
        actorUserId: await actorId(),
        action: PROMPT_KEPT,
        targetType: "deployment",
        targetId: deploymentId,
        detail: { step: "prompt" },
      }),
    );
}

export interface UpToDateRecord {
  at: Date;
  who: string;
  detail: Record<string, unknown>;
}

export interface UpToDateSteps {
  content?: UpToDateRecord;
  keyPages?: UpToDateRecord;
  prompt?: UpToDateRecord & { saved: boolean };
  validation?: UpToDateRecord;
}

// The latest record of each step since `since`; validation counts only after the pages were
// applied, and only a run a person started.
export async function upToDateSteps(deploymentId: string, since: string): Promise<UpToDateSteps> {
  const rows = await db()
    .select({ action: auditLog.action, at: auditLog.at, detail: auditLog.detail, name: users.name, email: users.email })
    .from(auditLog)
    .leftJoin(users, eq(users.id, auditLog.actorUserId))
    .where(
      and(
        eq(auditLog.targetId, deploymentId),
        inArray(auditLog.action, [CONTENT_APPLIED, KEY_PAGES_ADDED, "deployment.prompt", PROMPT_KEPT, "deployment.validate"]),
        gt(auditLog.at, new Date(since)),
      ),
    )
    .orderBy(desc(auditLog.at));
  const record = (r: (typeof rows)[number]): UpToDateRecord => {
    const detail = (r.detail ?? {}) as Record<string, unknown>;
    // In setup mode, the name typed with the step, marked as not verified once.
    const typed = typeof detail.name === "string" && detail.name.trim() ? detail.name.trim() : undefined;
    return {
      at: r.at,
      who: r.name ?? r.email ?? (typed ? (/not verified/.test(typed) ? typed : `${typed} (not verified)`) : "Someone in setup mode"),
      detail,
    };
  };
  const steps: UpToDateSteps = {};
  for (const r of rows) {
    if (r.action === CONTENT_APPLIED) steps.content ??= record(r);
    else if (r.action === KEY_PAGES_ADDED) steps.keyPages ??= record(r);
    else if (r.action === "deployment.prompt" || r.action === PROMPT_KEPT)
      steps.prompt ??= { ...record(r), saved: r.action === "deployment.prompt" };
  }
  // A run a person started: the automatic re-run asks the last list again, without the intent
  // questions Bring up to date adds.
  const validated = rows.find(
    (r) => r.action === "deployment.validate" && steps.content && r.at > steps.content.at && !(r.detail as { auto?: unknown } | null)?.auto,
  );
  if (validated) steps.validation = record(validated);
  return steps;
}
