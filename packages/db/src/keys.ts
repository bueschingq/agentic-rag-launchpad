// Store and load a deployment's Agentic RAG keys, sealed at rest (see secrets.ts).

import { and, desc, eq, isNull } from "drizzle-orm";
import type { Db } from "./client.ts";
import { credentials, type keyRole } from "./schema.ts";
import { credentialContext, openSecret, sealSecret } from "./secrets.ts";

export type KeyRoleName = (typeof keyRole.enumValues)[number];

export async function storeKey(
  db: Db,
  masterKey: Buffer,
  input: { deploymentId: string; role: KeyRoleName; serviceAccountId: string; keyId: string; token: string; expiresAt: Date },
): Promise<void> {
  await db.insert(credentials).values({
    deploymentId: input.deploymentId,
    role: input.role,
    serviceAccountId: input.serviceAccountId,
    keyId: input.keyId,
    secret: sealSecret(input.token, masterKey, credentialContext(input.deploymentId, input.role)),
    expiresAt: input.expiresAt,
  });
}

// The newest unrevoked key for the role, decrypted; undefined if none.
export async function loadKey(db: Db, masterKey: Buffer, deploymentId: string, role: KeyRoleName): Promise<string | undefined> {
  const [row] = await db
    .select({ secret: credentials.secret })
    .from(credentials)
    .where(and(eq(credentials.deploymentId, deploymentId), eq(credentials.role, role), isNull(credentials.revokedAt)))
    .orderBy(desc(credentials.createdAt))
    .limit(1);
  return row && openSecret(row.secret, masterKey, credentialContext(deploymentId, role));
}
