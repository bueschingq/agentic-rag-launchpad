// POST: a reader-scoped ephemeral token for one chat session (DESIGN.md §4a). The widget
// sends it to Agentic RAG as ?eph-token= and asks for a new one on 403 or near expiry.

import { loadKey } from "@launchpad/db";
import { KbClient, zoneApi } from "@launchpad/par-client";
import type { PublicTokenResponse } from "@launchpad/theme";
import { noteAccountBlock } from "@/lib/account-block.ts";
import { db } from "@/lib/db.ts";
import { env } from "@/lib/env.ts";
import {
  clientIp,
  corsHeaders,
  findDeployment,
  isAllowedOrigin,
  isOnline,
  json,
  RateLimiter,
  recordFirstSeen,
  recordRefused,
} from "@/lib/public-api.ts";

type Params = { params: Promise<{ id: string }> };

const TOKEN_TTL_SECONDS = 15 * 60;
// Each visitor needs about one token per 15 minutes; 10 a minute leaves room for reloads and tabs.
const limiter = new RateLimiter(10, 60_000);

export async function POST(request: Request, { params }: Params) {
  const { id } = await params;
  const origin = request.headers.get("origin");
  const row = await findDeployment(id);
  const kbId = row?.deployment.kbId;
  if (!row || !kbId) return json({ error: "Not found" }, 404);

  const { deployment } = row;
  // Tokens are only for browsers on the customer's own site.
  if (!isAllowedOrigin(origin, deployment.domains)) {
    await recordRefused(deployment.id, origin);
    return json({ error: "Origin not allowed" }, 403);
  }
  const cors = corsHeaders(origin);

  if (!limiter.allow(`${deployment.id}:${clientIp(request.headers)}`)) {
    return json({ error: "Too many requests" }, 429, { ...cors, "Retry-After": "60" });
  }
  // Not signed off yet is a refusal, not an outage: uptime monitors shouldn't page anyone for it.
  if (!deployment.published) return json({ error: "Not published yet" }, 403, cors);
  if (!(await isOnline(row))) return json({ error: "Unavailable" }, 503, cors);

  const readerKey = await loadKey(db(), env().masterKey, deployment.id, "reader");
  if (!readerKey) return json({ error: "Unavailable" }, 503, cors);

  try {
    const kb = new KbClient({ zone: deployment.zone, kbId, credential: { kind: "key", token: readerKey } });
    const { token, expiresAt } = await kb.mintEphemeralToken(TOKEN_TTL_SECONDS);
    // The widget asks for a token on a visitor's first question: from an allowed domain, that's
    // the deployment going live.
    await recordFirstSeen(deployment.id, origin);
    const body: PublicTokenResponse = {
      token,
      expiresIn: TOKEN_TTL_SECONDS,
      expiresAt: expiresAt.toISOString(),
      askUrl: `${zoneApi(deployment.zone)}/kb/${kbId}/ask`,
    };
    return json(body, 200, cors);
  } catch (err) {
    console.error(`token mint failed for deployment ${deployment.id}:`, err instanceof Error ? err.message : err);
    // The account blocked (for budget): recorded once, for the partner's channel and Fleet; the
    // widget shows its offline message for a 503.
    if (await noteAccountBlock(db(), err, "token")) return json({ error: "Unavailable", blocked: true }, 503, cors);
    return json({ error: "Unavailable" }, 502, cors);
  }
}

export async function OPTIONS(request: Request, { params }: Params) {
  const { id } = await params;
  const origin = request.headers.get("origin");
  const row = await findDeployment(id);
  if (!row || !isAllowedOrigin(origin, row.deployment.domains)) return new Response(null, { status: 403 });
  return new Response(null, { status: 204, headers: corsHeaders(origin) });
}
