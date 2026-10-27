// Server-side configuration, read once and validated.

import { parseMasterKey } from "@launchpad/db/secrets";
import { classifyToken, nuaAllowsKbManagement } from "@launchpad/par-client";

export interface ConsoleEnv {
  databaseUrl: string;
  masterKey: Buffer;
  nuaKey: string;
  pat: string | undefined;
  accountOverride: string | undefined;
  zoneOverride: string | undefined;
  publicBaseUrl: string;
  snifferUrl: string | undefined;
  snifferToken: string | undefined;
  adminPassword: string | undefined;
}

let cached: ConsoleEnv | undefined;

export function env(): ConsoleEnv {
  if (cached) return cached;
  const e = process.env;
  const value = (name: string) => e[name]?.trim() || undefined;

  // NUA keys get pasted into PAR_PAT often enough (it happened in the M0 spike) that we accept it.
  let nuaKey = value("PAR_NUA_KEY");
  let pat = value("PAR_PAT");
  if (pat && classifyToken(pat) === "nua") {
    nuaKey ??= pat;
    pat = undefined;
  }
  if (!nuaKey) throw new Error("PAR_NUA_KEY is not set.");
  if (classifyToken(nuaKey) !== "nua") throw new Error("PAR_NUA_KEY is not a NUA key.");
  if (!nuaAllowsKbManagement(nuaKey)) throw new Error("PAR_NUA_KEY needs KB management enabled to provision deployments.");

  const databaseUrl = value("DATABASE_URL");
  if (!databaseUrl) throw new Error("DATABASE_URL is not set.");

  cached = {
    databaseUrl,
    masterKey: parseMasterKey(value("LAUNCHPAD_MASTER_KEY")),
    nuaKey,
    pat,
    accountOverride: value("PAR_ACCOUNT"),
    zoneOverride: value("PAR_ZONE"),
    publicBaseUrl: (value("PUBLIC_BASE_URL") ?? "http://localhost:3000").replace(/\/$/, ""),
    snifferUrl: value("SNIFFER_URL"),
    snifferToken: value("SNIFFER_TOKEN"),
    adminPassword: value("LAUNCHPAD_ADMIN_PASSWORD"),
  };
  return cached;
}
