// Signs in every console request. With OIDC configured (OIDC_ISSUER, OIDC_CLIENT_ID), staff
// sign in with their own work account and a session cookie; without it, the console runs in
// setup mode behind HTTP Basic auth and the shared LAUNCHPAD_ADMIN_PASSWORD. Either way the
// person is passed on in request headers this proxy sets itself (lib/auth.ts).
//
// Public: the widget's routes, the health check, share links and the sign-in routes.

import { type NextRequest, NextResponse } from "next/server";
import { USER_HEADERS } from "@/lib/auth.ts";
import { oidcConfig } from "@/lib/oidc.ts";
import { SESSION_COOKIE, sessionUser } from "@/lib/session.ts";

const PUBLIC = [/^\/api\/public\//, /^\/api\/health$/, /^\/arag-chat\.js$/, /^\/share\//, /^\/auth\//];

export async function proxy(request: NextRequest) {
  // Nobody outside this proxy decides who the user is.
  const forwarded = new Headers(request.headers);
  for (const name of Object.values(USER_HEADERS)) forwarded.delete(name);
  const pass = (user?: { id: string; email: string; name: string; role: string }) => {
    if (user) {
      forwarded.set(USER_HEADERS.id, user.id);
      forwarded.set(USER_HEADERS.email, user.email);
      forwarded.set(USER_HEADERS.name, encodeURIComponent(user.name));
      forwarded.set(USER_HEADERS.role, user.role);
    }
    return NextResponse.next({ request: { headers: forwarded } });
  };

  const path = request.nextUrl.pathname;
  if (PUBLIC.some((p) => p.test(path))) return pass();

  // Presenter mode (screen-sharing with one client): only that customer's pages.
  const presenting = request.cookies.get("lp_presenting")?.value;
  if (presenting && !path.startsWith(`/customers/${presenting}`) && !path.startsWith("/present/") && request.method === "GET") {
    return NextResponse.redirect(new URL(`/customers/${presenting}`, request.url));
  }

  if (oidcConfig()) {
    const token = request.cookies.get(SESSION_COOKIE)?.value;
    const user = token ? await sessionUser(token) : undefined;
    if (user) return pass({ ...user, name: user.name ?? user.email });
    if (request.method === "GET" || request.method === "HEAD") {
      const login = new URL("/auth/login", request.url);
      login.searchParams.set("next", `${path}${request.nextUrl.search}`);
      return NextResponse.redirect(login);
    }
    return new NextResponse("Sign in again.", { status: 401 });
  }

  // Setup mode: one shared password, nobody named.
  const password = process.env.LAUNCHPAD_ADMIN_PASSWORD;
  if (!password) return new NextResponse("Set LAUNCHPAD_ADMIN_PASSWORD, or configure OIDC sign-in, to use the console.", { status: 503 });

  const header = request.headers.get("authorization") ?? "";
  const [scheme, encoded] = header.split(" ");
  const supplied = scheme === "Basic" && encoded ? atob(encoded).split(":").slice(1).join(":") : "";
  if (constantTimeEqual(supplied, password)) return pass({ id: "", email: "", name: "Setup admin", role: "partner_admin" });

  return new NextResponse("Authentication required.", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="Launchpad", charset="UTF-8"' },
  });
}

function constantTimeEqual(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
