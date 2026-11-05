// Starts an OIDC sign-in: PKCE verifier, state and nonce go in a short-lived signed cookie,
// and the browser goes to the identity provider.

import { NextResponse } from "next/server";
import { publicBaseUrl } from "@/lib/env.ts";
import { authorizationUrl, oidcConfig, randomToken } from "@/lib/oidc.ts";
import { SIGN_IN_COOKIE, signValue } from "@/lib/session.ts";

export const dynamic = "force-dynamic";

// Only paths on this console, so the sign-in can't be used to bounce people elsewhere.
const safeNext = (value: string | null) => (value?.startsWith("/") && !value.startsWith("//") ? value : "/");

export async function GET(request: Request) {
  const config = oidcConfig(process.env, publicBaseUrl());
  if (!config) return NextResponse.redirect(new URL("/", request.url));
  const state = randomToken(16);
  const nonce = randomToken(16);
  const verifier = randomToken(48);
  const next = safeNext(new URL(request.url).searchParams.get("next"));
  const response = NextResponse.redirect(await authorizationUrl(config, state, nonce, verifier));
  response.cookies.set(SIGN_IN_COOKIE, signValue({ state, nonce, verifier, next, at: Date.now() }), {
    httpOnly: true,
    sameSite: "lax",
    secure: publicBaseUrl().startsWith("https://"),
    path: "/auth",
    maxAge: 600,
  });
  return response;
}
