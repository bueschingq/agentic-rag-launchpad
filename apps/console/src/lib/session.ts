// Console sessions for signed-in partner staff, and the signed cookie that carries an OIDC
// sign-in between the redirect and the callback. Session tokens are random; only their hash
// is stored, so a database leak doesn't hand out live sessions.

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { sessions, users } from "@launchpad/db";
import { parseMasterKey } from "@launchpad/db/secrets";
import { and, eq, gt, inArray } from "drizzle-orm";
import { db } from "./db.ts";
import { randomToken } from "./oidc.ts";

export const SESSION_COOKIE = "lp_session";
export const SIGN_IN_COOKIE = "lp_sign_in";
export const SESSION_HOURS = 12;

export type StaffRole = "partner_admin" | "partner_member";

export interface StaffUser {
  id: string;
  email: string;
  name: string | null;
  role: StaffRole;
}

const hash = (token: string) => createHash("sha256").update(token).digest("hex");

export async function createSession(userId: string, now = new Date()): Promise<{ token: string; expiresAt: Date }> {
  const token = randomToken();
  const expiresAt = new Date(now.getTime() + SESSION_HOURS * 3_600_000);
  await db()
    .insert(sessions)
    .values({ userId, tokenHash: hash(token), expiresAt });
  await db().update(users).set({ lastLoginAt: now }).where(eq(users.id, userId));
  return { token, expiresAt };
}

export async function sessionUser(token: string, now = new Date()): Promise<StaffUser | undefined> {
  const [row] = await db()
    .select({ id: users.id, email: users.email, name: users.name, role: users.role })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.tokenHash, hash(token)), gt(sessions.expiresAt, now), inArray(users.role, ["partner_admin", "partner_member"])))
    .limit(1);
  return row as StaffUser | undefined;
}

export async function endSession(token: string): Promise<void> {
  await db()
    .delete(sessions)
    .where(eq(sessions.tokenHash, hash(token)));
}

// HMAC under a key derived from the master key: the sign-in cookie can't be forged or edited.
function cookieKey(): Buffer {
  return createHash("sha256").update("launchpad-cookie:").update(parseMasterKey(process.env.LAUNCHPAD_MASTER_KEY)).digest();
}

export function signValue(value: object): string {
  const body = Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${body}.${createHmac("sha256", cookieKey()).update(body).digest("base64url")}`;
}

export function readSigned<T>(signed: string | undefined): T | undefined {
  const [body, mac] = signed?.split(".") ?? [];
  if (!body || !mac) return undefined;
  const expected = Buffer.from(createHmac("sha256", cookieKey()).update(body).digest("base64url"));
  const given = Buffer.from(mac);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return undefined;
  return JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as T;
}
