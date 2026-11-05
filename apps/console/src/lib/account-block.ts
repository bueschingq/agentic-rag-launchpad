// The partner's Agentic RAG account blocked for budget (round 6's re-check: every ask answered
// 402 "account … has an active 'AccountBlockingState.BUDGET' blockage", every chat said "Something
// went wrong", and nobody heard). Wherever a call meets the block (the token route, the widget's
// asks as it reports them, the worker's jobs), it's recorded once in the audit log as
// account.blocked; the first answer that works afterwards records account.unblocked. The alerts
// job posts each once to the partner's channel, Fleet shows the block while it lasts, and the
// widget shows its offline message instead of an error. No schema: the audit log holds the state.
// Takes the database as an argument, so the console and the worker share it.

import { auditLog, type Db } from "@launchpad/db";
import { and, desc, eq, inArray } from "drizzle-orm";
import { accountBlockState, blockNotice } from "./ask-refusal.ts";

const TARGET = { targetType: "account", targetId: "agentic-rag" } as const;
export const BLOCKED = "account.blocked";
export const UNBLOCKED = "account.unblocked";

export { accountBlockState };

// The latest account entry: blocked or unblocked, with when and the state named.
export interface AccountEntry {
  id: number;
  action: typeof BLOCKED | typeof UNBLOCKED;
  at: Date;
  state: string;
}

export async function lastAccountEntry(db: Db): Promise<AccountEntry | undefined> {
  const [last] = await db
    .select({ id: auditLog.id, action: auditLog.action, at: auditLog.at, detail: auditLog.detail })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.targetType, TARGET.targetType),
        eq(auditLog.targetId, TARGET.targetId),
        inArray(auditLog.action, [BLOCKED, UNBLOCKED]),
      ),
    )
    .orderBy(desc(auditLog.at), desc(auditLog.id))
    .limit(1);
  if (!last) return undefined;
  const state = typeof last.detail?.state === "string" ? last.detail.state : "BUDGET";
  return { id: last.id, action: last.action as AccountEntry["action"], at: last.at, state };
}

// The account's state as last recorded: blocked (with the state and since when), or not.
export async function accountBlock(db: Db): Promise<{ state: string; since: Date; id: number } | undefined> {
  const last = await lastAccountEntry(db);
  return last?.action === BLOCKED ? { state: last.state, since: last.at, id: last.id } : undefined;
}

// The partner channel's post for the latest account entry, keyed so each goes once: the block,
// and the all-clear within a day of it. Pure.
export function accountAlert(
  last: AccountEntry | undefined,
  now: Date,
  link?: string,
): { key: string; message: { subject: string; text: string; link?: string } } | undefined {
  if (!last) return undefined;
  const at = `${last.at.toISOString().slice(0, 16).replace("T", " ")} UTC`;
  if (last.action === BLOCKED)
    return {
      key: `account-blocked:${last.id}`,
      message: {
        subject: blockedMessage(last.state),
        text: `Since ${at}. ${blockNotice(last.state)} Visitors see each chat's offline message meanwhile.`,
        ...(link && { link }),
      },
    };
  if (now.getTime() - last.at.getTime() > 86_400_000) return undefined;
  return {
    key: `account-unblocked:${last.id}`,
    message: {
      subject: "Agentic RAG account unblocked: chats answer again",
      text: `Answers worked again at ${at}.`,
      ...(link && { link }),
    },
  };
}

// Records the block, once: nothing while it's already recorded. `where` says which call met it.
export async function recordAccountBlock(db: Db, state: string, where: string): Promise<boolean> {
  if (await accountBlock(db)) return false;
  await db.insert(auditLog).values({ actorUserId: null, action: BLOCKED, ...TARGET, detail: { state, where, auto: "account" } });
  return true;
}

// Records that answers work again, when a block is recorded. `askedAt`: when the answer that worked
// was asked. An answer already on its way when the block began says nothing about it being over
// (the asks a run sends together come back either side of the first refusal).
export async function recordAccountClear(db: Db, where: string, askedAt?: Date): Promise<boolean> {
  const block = await accountBlock(db);
  if (!block || (askedAt && askedAt <= block.since)) return false;
  await db.insert(auditLog).values({ actorUserId: null, action: UNBLOCKED, ...TARGET, detail: { where, auto: "account" } });
  return true;
}

// For a call's catch: records the block when the error is one, and says whether it was.
export async function noteAccountBlock(db: Db, err: unknown, where: string): Promise<boolean> {
  const state = accountBlockState(err);
  if (!state) return false;
  await recordAccountBlock(db, state, where).catch(() => false);
  return true;
}

// The partner channel's words. Pure.
export const blockedMessage = (state: string) =>
  state === "BUDGET"
    ? "Agentic RAG account blocked for budget: every chat is down until it's cleared"
    : "Agentic RAG account blocked: every chat is down until it's cleared";
