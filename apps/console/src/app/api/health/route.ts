// Liveness for Docker and uptime checks: database reachable, NUA key accepted.

import { sql } from "drizzle-orm";
import { db } from "@/lib/db.ts";
import { partnerAccount } from "@/lib/par.ts";

export const dynamic = "force-dynamic";

export async function GET() {
  // Each check starts inside an async function, so a missing setting (which throws synchronously)
  // reports as a failed check instead of failing the whole request.
  const [database, agenticRag] = await Promise.allSettled([
    (async () => db().execute(sql`select 1`))(),
    (async () => partnerAccount())(),
  ]);
  const ok = database.status === "fulfilled" && agenticRag.status === "fulfilled";
  return Response.json(
    {
      ok,
      database: database.status === "fulfilled" ? "ok" : "unreachable",
      agenticRag:
        agenticRag.status === "fulfilled"
          ? { zone: agenticRag.value.zone, accountType: agenticRag.value.accountType }
          : "NUA key rejected or zone unreachable",
    },
    { status: ok ? 200 : 503, headers: { "Cache-Control": "no-store" } },
  );
}
