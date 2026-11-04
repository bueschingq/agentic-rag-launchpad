// Read-only links for people outside the console: a deployment's install guide (for the
// client's web team) and a customer's report (for the client's marketing team). Tokens are
// random; only their hash is stored. Links expire, can be revoked, and are audited.

import { createHash } from "node:crypto";
import { auditLog, shareLinks } from "@launchpad/db";
import { and, desc, eq, gt, isNull } from "drizzle-orm";
import { db } from "./db.ts";
import { publicBaseUrl } from "./env.ts";
import { randomToken } from "./oidc.ts";
import { withSetupName } from "./setup-name.ts";

export type ShareKind = "install" | "report";

const hash = (token: string) => createHash("sha256").update(token).digest("hex");

export async function createShareLink(
  kind: ShareKind,
  tenantId: string,
  deploymentId: string | null,
  actor: string | null,
  days = 90,
): Promise<string> {
  const token = randomToken(24);
  const expiresAt = new Date(Date.now() + days * 86_400_000);
  const [link] = await db()
    .insert(shareLinks)
    .values({ kind, tenantId, deploymentId, tokenHash: hash(token), expiresAt, actorUserId: actor })
    .returning({ id: shareLinks.id });
  await db()
    .insert(auditLog)
    .values(
      await withSetupName({
        actorUserId: actor,
        action: `share.${kind}`,
        targetType: "share",
        targetId: link!.id,
        detail: { tenantId, deploymentId, expiresAt },
      }),
    );
  return `${publicBaseUrl()}/share/${kind}/${token}`;
}

export async function resolveShareLink(kind: ShareKind, token: string) {
  if (!/^[\w-]{20,64}$/.test(token)) return undefined;
  const [link] = await db()
    .select()
    .from(shareLinks)
    .where(
      and(
        eq(shareLinks.kind, kind),
        eq(shareLinks.tokenHash, hash(token)),
        isNull(shareLinks.revokedAt),
        gt(shareLinks.expiresAt, new Date()),
      ),
    );
  return link;
}

export function activeShareLinks(kind: ShareKind, tenantId: string, deploymentId?: string) {
  return db()
    .select({ id: shareLinks.id, createdAt: shareLinks.createdAt, expiresAt: shareLinks.expiresAt })
    .from(shareLinks)
    .where(
      and(
        eq(shareLinks.kind, kind),
        eq(shareLinks.tenantId, tenantId),
        deploymentId ? eq(shareLinks.deploymentId, deploymentId) : undefined,
        isNull(shareLinks.revokedAt),
        gt(shareLinks.expiresAt, new Date()),
      ),
    )
    .orderBy(desc(shareLinks.createdAt));
}

export async function revokeShareLink(id: string, tenantId: string, actor: string | null): Promise<void> {
  await db()
    .update(shareLinks)
    .set({ revokedAt: new Date() })
    .where(and(eq(shareLinks.id, id), eq(shareLinks.tenantId, tenantId)));
  await db()
    .insert(auditLog)
    .values(await withSetupName({ actorUserId: actor, action: "share.revoke", targetType: "share", targetId: id, detail: {} }));
}
