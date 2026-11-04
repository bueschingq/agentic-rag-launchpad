// Finishes an OIDC sign-in. Only people an admin invited (Settings › Users) get in; the
// addresses in LAUNCHPAD_ADMIN_EMAILS become admins on their first sign-in, so a new console
// has someone who can invite the rest.

import { auditLog, users } from "@launchpad/db";
import { sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/lib/db.ts";
import { publicBaseUrl } from "@/lib/env.ts";
import { completeSignIn, OidcError, oidcConfig } from "@/lib/oidc.ts";
import { createSession, readSigned, SESSION_COOKIE, SESSION_HOURS, SIGN_IN_COOKIE } from "@/lib/session.ts";

export const dynamic = "force-dynamic";

interface SignIn {
  state: string;
  nonce: string;
  verifier: string;
  next: string;
  at: number;
}

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const page = (title: string, message: string, status: number) =>
  new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title} · Launchpad</title><style>body{font:16px/1.6 system-ui,sans-serif;max-width:560px;margin:15vh auto;padding:0 16px;color:#111}a{color:#2b2bb2}</style></head><body><h1>${title}</h1><p>${escapeHtml(message)}</p><p><a href="/auth/login">Try again</a></p></body></html>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } },
  );

export async function GET(request: Request) {
  const config = oidcConfig(process.env, publicBaseUrl());
  if (!config) return NextResponse.redirect(new URL("/", request.url));
  const url = new URL(request.url);
  const saved = readSigned<SignIn>(request.headers.get("cookie")?.match(new RegExp(`${SIGN_IN_COOKIE}=([^;]+)`))?.[1]);
  const code = url.searchParams.get("code");
  if (url.searchParams.get("error")) return page("Sign-in cancelled", "The identity provider didn't complete the sign-in.", 400);
  if (!saved || !code || saved.state !== url.searchParams.get("state") || Date.now() - saved.at > 600_000) {
    return page("Sign-in expired", "That sign-in link is no longer valid. Start again.", 400);
  }

  let identity: Awaited<ReturnType<typeof completeSignIn>>;
  try {
    identity = await completeSignIn(config, code, { nonce: saved.nonce, verifier: saved.verifier });
  } catch (err) {
    const message = err instanceof OidcError ? err.message : "The identity provider couldn't be reached.";
    return page("Sign-in failed", message, 400);
  }

  const admins = (process.env.LAUNCHPAD_ADMIN_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  let [user] = await db().select({ id: users.id, role: users.role }).from(users).where(sql`lower(${users.email}) = ${identity.email}`);
  if (!user && admins.includes(identity.email)) {
    [user] = await db()
      .insert(users)
      .values({ email: identity.email, name: identity.name ?? null, role: "partner_admin" })
      .returning({ id: users.id, role: users.role });
  }
  if (!user || user.role === "customer_viewer") {
    return page(
      "Not invited",
      `${identity.email} hasn't been invited to this console. Ask an admin to add you under Settings › Users.`,
      403,
    );
  }

  const session = await createSession(user.id);
  await db().insert(auditLog).values({ actorUserId: user.id, action: "user.sign-in", targetType: "user", targetId: user.id, detail: {} });
  const response = NextResponse.redirect(new URL(saved.next, publicBaseUrl()));
  response.cookies.set(SESSION_COOKIE, session.token, {
    httpOnly: true,
    sameSite: "lax",
    secure: publicBaseUrl().startsWith("https://"),
    path: "/",
    maxAge: SESSION_HOURS * 3600,
  });
  response.cookies.delete({ name: SIGN_IN_COOKIE, path: "/auth" });
  return response;
}
