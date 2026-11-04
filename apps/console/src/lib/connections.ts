// What the console is connected to, for Settings and for the New deployment notice. Problems
// are worded for the person who can fix them: admins see the setting to change.

import { smtpConfigured } from "@launchpad/notify";
import { publicBaseUrl } from "./env.ts";
import { oidcConfig } from "./oidc.ts";
import { partnerAccount } from "./par.ts";
import { snifferSettings } from "./sniffer.ts";

export interface Connections {
  agenticRag: { ok: true; accountId: string; zone: string } | { ok: false; problem: string };
  sniffer: { ok: boolean; problem?: string };
  email: boolean;
  signIn: "oidc" | "password";
  publicUrl: { url: string; ok: boolean };
}

export async function agenticRagConnection(): Promise<Connections["agenticRag"]> {
  try {
    const account = await partnerAccount();
    return { ok: true, accountId: account.accountId, zone: account.zone };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      problem: /PAR_NUA_KEY/.test(message)
        ? "No Agentic RAG account key is set up yet (PAR_NUA_KEY)."
        : `Agentic RAG didn't accept the account key: ${message}`,
    };
  }
}

export async function connections(): Promise<Connections> {
  const sniffer = snifferSettings();
  const snifferCheck = sniffer
    ? await fetch(`${sniffer.url}/health`, { signal: AbortSignal.timeout(2_000) })
        .then((r) => (r.ok ? { ok: true } : { ok: false, problem: `The site scanner answered ${r.status}.` }))
        .catch(() => ({ ok: false, problem: `The site scanner isn't reachable at ${sniffer.url}.` }))
    : { ok: false, problem: "The site scanner isn't set up (SNIFFER_URL, SNIFFER_TOKEN)." };
  const url = publicBaseUrl();
  return {
    agenticRag: await agenticRagConnection(),
    sniffer: snifferCheck,
    email: smtpConfigured(),
    signIn: oidcConfig() ? "oidc" : "password",
    publicUrl: { url, ok: url.startsWith("https://") && !/localhost|127\.0\.0\.1/.test(url) },
  };
}
