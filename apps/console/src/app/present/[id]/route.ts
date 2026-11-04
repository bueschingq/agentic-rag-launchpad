// Presenter mode, for screen-sharing on a client call: the console shows only this customer's
// pages (no fleet, costs, settings or other customers) until "Stop presenting". proxy.ts
// enforces it from the cookie.

import { NextResponse } from "next/server";
import { publicBaseUrl } from "@/lib/env.ts";

const PRESENTER_COOKIE = "lp_presenting";

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Params) {
  const { id } = await params;
  if (id === "stop") {
    const response = NextResponse.redirect(new URL("/", publicBaseUrl()));
    response.cookies.delete(PRESENTER_COOKIE);
    return response;
  }
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.redirect(new URL("/", publicBaseUrl()));
  const response = NextResponse.redirect(new URL(`/customers/${id}`, publicBaseUrl()));
  response.cookies.set(PRESENTER_COOKIE, id, { httpOnly: true, sameSite: "lax", path: "/", maxAge: 8 * 3600 });
  return response;
}
