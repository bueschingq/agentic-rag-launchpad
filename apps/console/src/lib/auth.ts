// Who is using the console. proxy.ts signs every request in (OIDC session, or the shared
// password in setup mode) and passes the person on in request headers it sets itself, after
// removing any a client sent. Pages, actions and route handlers read them from here.

import { headers } from "next/headers";
import type { StaffRole } from "./session.ts";

export const USER_HEADERS = {
  id: "x-launchpad-user-id",
  email: "x-launchpad-user-email",
  name: "x-launchpad-user-name",
  role: "x-launchpad-user-role",
} as const;

export interface ConsoleUser {
  // null in setup mode (shared password): nobody is named.
  id: string | null;
  email: string | null;
  name: string;
  role: StaffRole;
  setupMode: boolean;
}

export function userFromHeaders(h: Headers): ConsoleUser | undefined {
  const role = h.get(USER_HEADERS.role);
  if (role !== "partner_admin" && role !== "partner_member") return undefined;
  const id = h.get(USER_HEADERS.id) || null;
  return {
    id,
    email: h.get(USER_HEADERS.email) || null,
    name: decodeURIComponent(h.get(USER_HEADERS.name) || "") || h.get(USER_HEADERS.email) || "Setup admin",
    role,
    setupMode: !id,
  };
}

export async function currentUser(): Promise<ConsoleUser> {
  const user = userFromHeaders(await headers());
  // Only reachable if a route were left out of the proxy's matcher.
  if (!user) throw new Error("Not signed in.");
  return user;
}

export class ForbiddenError extends Error {
  override name = "ForbiddenError";
}

// Rates, markup, credentials, users and alert destinations are for admins.
export async function requireAdmin(): Promise<ConsoleUser> {
  const user = await currentUser();
  if (user.role !== "partner_admin") throw new ForbiddenError("Only admins can do this.");
  return user;
}

// For audit entries: the person, or null in setup mode.
export async function actorId(): Promise<string | null> {
  return (await currentUser()).id;
}

export const isAdmin = (user: ConsoleUser) => user.role === "partner_admin";
