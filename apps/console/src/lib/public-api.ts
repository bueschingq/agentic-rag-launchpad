// Shared pieces of the only routes customer sites can reach: /api/public/deployments/{id}/*.
// The KB's allowed_origins blocks other sites in browsers but not scripted clients (M0),
// so these routes check Origin themselves and rate-limit (see origin.ts).

import { deployments, tenants } from "@launchpad/db";
import { eq } from "drizzle-orm";
import { db } from "./db.ts";

export { clientIp, corsHeaders, isAllowedOrigin, RateLimiter } from "./origin.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function findDeployment(id: string) {
  if (!UUID.test(id)) return undefined;
  const [row] = await db()
    .select({ deployment: deployments, tenantStatus: tenants.status })
    .from(deployments)
    .innerJoin(tenants, eq(deployments.tenantId, tenants.id))
    .where(eq(deployments.id, id))
    .limit(1);
  return row;
}

export const json = (body: unknown, status: number, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store", ...headers } });
