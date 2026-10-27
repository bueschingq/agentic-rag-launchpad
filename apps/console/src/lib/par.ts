// The partner's Agentic RAG account, resolved once from the NUA key.

import { type NuaKeyInfo, resolveNuaKey, ZoneClient } from "@launchpad/par-client";
import { env } from "./env.ts";

let account: Promise<NuaKeyInfo> | undefined;

export function partnerAccount(): Promise<NuaKeyInfo> {
  account ??= resolveNuaKey(env().nuaKey)
    .then((info) => ({
      ...info,
      accountId: env().accountOverride ?? info.accountId,
      zone: env().zoneOverride ?? info.zone,
    }))
    .catch((err: unknown) => {
      account = undefined; // retry on the next call
      throw err;
    });
  return account;
}

export async function zoneClient(): Promise<ZoneClient> {
  const { zone, accountId } = await partnerAccount();
  return new ZoneClient({ zone, accountId, credential: { kind: "nua", token: env().nuaKey } });
}
