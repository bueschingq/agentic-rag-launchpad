// Ends the console session (POST, from the Sign out button).

import { NextResponse } from "next/server";
import { publicBaseUrl } from "@/lib/env.ts";
import { endSession, SESSION_COOKIE } from "@/lib/session.ts";

export async function POST(request: Request) {
  const token = request.headers.get("cookie")?.match(new RegExp(`${SESSION_COOKIE}=([^;]+)`))?.[1];
  if (token) await endSession(token);
  const response = NextResponse.redirect(new URL("/auth/signed-out", publicBaseUrl()), 303);
  response.cookies.delete(SESSION_COOKIE);
  return response;
}
