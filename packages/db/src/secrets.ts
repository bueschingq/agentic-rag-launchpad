// KB keys at rest: AES-256-GCM under the instance master key (LAUNCHPAD_MASTER_KEY, 32 bytes,
// base64). The additional authenticated data binds each ciphertext to where it is stored
// (deployment + role), so a value copied into another row fails to decrypt instead of
// handing one customer's key to another deployment.
//
// Format: v1.<iv>.<tag>.<ciphertext>, each part base64url.

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const VERSION = "v1";

export function parseMasterKey(base64: string | undefined): Buffer {
  const key = Buffer.from(base64 ?? "", "base64");
  if (key.length !== 32) throw new Error("LAUNCHPAD_MASTER_KEY must be 32 random bytes, base64-encoded (openssl rand -base64 32).");
  return key;
}

export function sealSecret(plaintext: string, key: Buffer, context: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(context, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [VERSION, iv, cipher.getAuthTag(), ciphertext].map((p) => (typeof p === "string" ? p : p.toString("base64url"))).join(".");
}

export function openSecret(sealed: string, key: Buffer, context: string): string {
  const [version, iv, tag, ciphertext, ...rest] = sealed.split(".");
  if (version !== VERSION || !iv || !tag || !ciphertext || rest.length) throw new Error("Unrecognised sealed secret.");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
  decipher.setAAD(Buffer.from(context, "utf8"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  try {
    return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    // Wrong key, wrong row, or tampered: never say which.
    throw new Error("Sealed secret could not be opened.");
  }
}

export const credentialContext = (deploymentId: string, role: string): string => `credential:${deploymentId}:${role}`;
