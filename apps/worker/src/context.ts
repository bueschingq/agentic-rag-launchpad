import { createDb, type Db, deployments, loadKey, parseMasterKey } from "@launchpad/db";
import { KbClient } from "@launchpad/par-client";
import { and, inArray, isNotNull } from "drizzle-orm";

export interface JobContext {
  db: Db;
  masterKey: Buffer;
  log: (message: string) => void;
}

export function createContext(): JobContext & { close: () => Promise<void> } {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set.");
  const { db, close } = createDb(url, { max: 4 });
  return {
    db,
    close,
    masterKey: parseMasterKey(process.env.LAUNCHPAD_MASTER_KEY),
    log: (message) => console.log(`[worker] ${new Date().toISOString()} ${message}`),
  };
}

// Deployments with a KB that can still receive traffic (paused ones still report history).
export function activeDeployments(ctx: JobContext) {
  return ctx.db
    .select({ id: deployments.id, zone: deployments.zone, kbId: deployments.kbId })
    .from(deployments)
    .where(and(inArray(deployments.status, ["live", "paused"]), isNotNull(deployments.kbId)));
}

// Analytics need the KB's manager key; NUA keys get 403 on activity and REMi (M0).
export async function managerClient(ctx: JobContext, d: { id: string; zone: string; kbId: string | null }) {
  if (!d.kbId) return undefined;
  const key = await loadKey(ctx.db, ctx.masterKey, d.id, "manager");
  return key ? new KbClient({ zone: d.zone, kbId: d.kbId, credential: { kind: "key", token: key } }) : undefined;
}
