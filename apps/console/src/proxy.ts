// Interim gate until partner sign-in (OIDC) lands in M1: HTTP Basic auth on everything
// except the public widget surface. Without LAUNCHPAD_ADMIN_PASSWORD the console refuses
// all admin requests rather than run open.

import { type NextRequest, NextResponse } from "next/server";

const PUBLIC = [/^\/api\/public\//, /^\/api\/health$/, /^\/arag-chat\.js$/];

export function proxy(request: NextRequest) {
  if (PUBLIC.some((p) => p.test(request.nextUrl.pathname))) return NextResponse.next();

  const password = process.env.LAUNCHPAD_ADMIN_PASSWORD;
  if (!password) return new NextResponse("Set LAUNCHPAD_ADMIN_PASSWORD to use the console.", { status: 503 });

  const header = request.headers.get("authorization") ?? "";
  const [scheme, encoded] = header.split(" ");
  const supplied = scheme === "Basic" && encoded ? atob(encoded).split(":").slice(1).join(":") : "";
  if (constantTimeEqual(supplied, password)) return NextResponse.next();

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
