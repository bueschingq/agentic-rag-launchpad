// The account's Knowledge Box allowance: every deployment is one KB, and an account at its
// limit can't provision another (Agentic RAG answers 402). The count comes from the NUA key; the
// limit needs a PAT, an admin entering it in Settings, or is learned the first time provisioning
// is refused at a given count.

import { deployments, settings } from "@launchpad/db";
import { AccountClient } from "@launchpad/par-client";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "./db.ts";
import { env } from "./env.ts";
import { partnerAccount, zoneClient } from "./par.ts";

export interface KbAllowance {
  used: number;
  limit?: number;
  left?: number;
  // Where the limit came from: the account (PAT), an admin, a refusal at that count, or not known.
  source: "pat" | "entered" | "refused" | "unknown";
}

// At or below this many left, or at 90% of the limit, the console warns.
export const LOW_ALLOWANCE = 3;
export const WARN_SHARE = 0.9;

let cached: { at: number; value: KbAllowance } | undefined;
const CACHE_MS = 60_000;

// undefined when the console isn't connected to an account, or the count can't be read.
export async function kbAllowance(opts: { fresh?: boolean } = {}): Promise<KbAllowance | undefined> {
  if (!opts.fresh && cached && Date.now() - cached.at < CACHE_MS) return cached.value;
  if (!env().nuaKey) return undefined;
  try {
    const used = (await (await zoneClient()).listKbs()).length;
    const value = allowanceFrom(used, await knownLimit());
    cached = { at: Date.now(), value };
    return value;
  } catch {
    return undefined;
  }
}

type KnownLimit = { limit: number; source: "pat" | "entered" | "refused" };

async function knownLimit(): Promise<KnownLimit | undefined> {
  const pat = env().pat;
  if (pat) {
    try {
      const { accountId } = await partnerAccount();
      return { limit: (await new AccountClient({ pat }).getAccount(accountId)).max_kbs, source: "pat" };
    } catch {
      // Fall back to what a refusal taught us.
    }
  }
  const [row] = await db().select({ limit: settings.kbLimit, source: settings.kbLimitSource }).from(settings).where(eq(settings.id, 1));
  return row?.limit != null ? { limit: row.limit, source: row.source ?? "refused" } : undefined;
}

export function allowanceFrom(used: number, known: KnownLimit | undefined): KbAllowance {
  if (!known) return { used, source: "unknown" };
  return { used, limit: known.limit, left: Math.max(0, known.limit - used), source: known.source };
}

// A 402 at N Knowledge Boxes means the limit is N (until Progress raises it, which a later
// successful provisioning shows: see forgetLimitIfPassed).
export async function learnLimitFromRefusal(): Promise<void> {
  try {
    const used = (await (await zoneClient()).listKbs()).length;
    await db()
      .insert(settings)
      .values({ id: 1, kbLimit: used, kbLimitSource: "refused" })
      .onConflictDoUpdate({ target: settings.id, set: { kbLimit: used, kbLimitSource: "refused" } });
    cached = undefined;
  } catch {
    // The plain message still shows; the count just isn't remembered.
  }
}

// A KB was created past a learned limit: the limit was raised, so stop claiming one.
export async function forgetLimitIfPassed(): Promise<void> {
  cached = undefined;
  const [row] = await db().select({ limit: settings.kbLimit, source: settings.kbLimitSource }).from(settings).where(eq(settings.id, 1));
  if (row?.source !== "refused" || row.limit == null) return;
  const allowance = await kbAllowance({ fresh: true });
  if (allowance && allowance.used > row.limit) {
    await db().update(settings).set({ kbLimit: null, kbLimitSource: null }).where(eq(settings.id, 1));
    cached = undefined;
  }
}

// The limit from the partner's Progress order, entered by an admin; null forgets it.
export async function enterLimit(limit: number | null): Promise<void> {
  const set = { kbLimit: limit, kbLimitSource: limit === null ? null : ("entered" as const) };
  await db()
    .insert(settings)
    .values({ id: 1, ...set })
    .onConflictDoUpdate({ target: settings.id, set });
  cached = undefined;
}

// Deployments in this console that will each need a Knowledge Box: drafts, and failed ones that
// never got one (Retry creates it).
export async function waitingForKb(): Promise<number> {
  const [row] = await db()
    .select({ n: sql<number>`count(*)`.mapWith(Number) })
    .from(deployments)
    .where(and(isNull(deployments.kbId), inArray(deployments.status, ["draft", "provisioning", "failed"])));
  return row?.n ?? 0;
}

// One line for Settings, first-run setup and New deployment: "Knowledge Boxes: 27 of 30 used,
// 3 left", plus what to do. `waiting`: deployments here that still need one.
export function capacityMessage(a: KbAllowance, waiting = 0): { text: string; tone: "good" | "warning" | "critical" } {
  const need = waiting ? ` ${waiting} deployment${waiting === 1 ? "" : "s"} here still need${waiting === 1 ? "s" : ""} one.` : "";
  if (a.limit === undefined) {
    return {
      text: `Check this: the account's Knowledge Box limit isn't known (${a.used} used), so Agentic RAG may refuse the next one mid-call. An admin can enter it in Settings (from the Progress order), or add a PAT so the console reads it.${need}`,
      tone: "warning",
    };
  }
  const left = a.left ?? 0;
  const from = { refused: " (the limit Agentic RAG enforced when it last refused one)", entered: " (the limit entered in Settings)" };
  const base = `Knowledge Boxes: ${a.used} of ${a.limit} used, ${left} left${a.source === "refused" || a.source === "entered" ? from[a.source] : ""}.${need}`;
  if (left === 0) {
    return {
      text: `${base} None left: delete one you no longer use in the Agentic RAG dashboard (the console can't delete them yet), or ask Progress to raise the limit. Each deployment needs one.`,
      tone: "critical",
    };
  }
  if (a.used >= a.limit * WARN_SHARE || left <= LOW_ALLOWANCE || left < waiting) {
    return { text: `${base} Nearly full: ask Progress to raise the limit before the next client.`, tone: "warning" };
  }
  return { text: base, tone: "good" };
}
