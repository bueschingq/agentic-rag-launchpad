// Rules for a deployment's allowed domains. Pure, so the edit form uses them in the browser
// (the www/apex suggestion) and node:test covers them.

import { normaliseOrigin } from "./origin.ts";

export const MAX_DOMAINS = 10;

// www.example.com ↔ example.com: the other spelling people reach the site by.
export function twinOrigin(origin: string): string | undefined {
  const u = new URL(origin);
  if (u.hostname === "localhost" || /^\d+\.\d+\.\d+\.\d+$/.test(u.hostname)) return undefined;
  const parts = u.hostname.split(".");
  if (u.hostname.startsWith("www.")) u.hostname = u.hostname.slice(4);
  else if (parts.length === 2) u.hostname = `www.${u.hostname}`;
  else return undefined;
  return u.origin;
}

// Twins of the given origins that aren't allowed yet.
export function missingTwins(origins: readonly string[]): string[] {
  const set = new Set(origins);
  return [...new Set(origins.flatMap((o) => twinOrigin(o) ?? []))].filter((t) => !set.has(t));
}

// A page on this machine is never a client's production site, marked or not.
const LOOPBACK = /^(?:localhost|127(?:\.\d+){3}|\[::1\])$|\.localhost$/;

// Staging or test: marked as such on the deployment (deployments.stagingDomains), or a loopback
// address. Questions from these are test traffic, and answering only there is "Live on staging".
export function isStagingOrigin(origin: string, staging: readonly string[]): boolean {
  if (staging.includes(origin)) return true;
  try {
    return LOOPBACK.test(new URL(origin).hostname);
  } catch {
    return false;
  }
}

// On a new deployment, every domain beyond the site's own (and its www/apex twin) starts as staging.
export function defaultStagingDomains(siteUrl: string, domains: readonly string[]): string[] {
  let site: string;
  try {
    site = new URL(siteUrl).origin;
  } catch {
    return [];
  }
  const production = new Set([site, twinOrigin(site)].filter(Boolean));
  return domains.filter((d) => !production.has(d));
}

// Where a live deployment answers: production when any origin it answered on isn't staging,
// with the host, else "staging" with the staging hosts.
export function liveWhere(origins: readonly string[], staging: readonly string[]): { staging: boolean; hosts: string[] } | undefined {
  const host = (o: string) => {
    try {
      return new URL(o).host;
    } catch {
      return o;
    }
  };
  const unique = [...new Set(origins)];
  if (!unique.length) return undefined;
  const production = unique.filter((o) => !isStagingOrigin(o, staging));
  return production.length ? { staging: false, hosts: production.map(host) } : { staging: true, hosts: unique.map(host) };
}

export function parseDomains(raw: string): { domains: string[] } | { error: string } {
  const out: string[] = [];
  for (const line of raw.split(/[\s,]+/).filter(Boolean)) {
    const origin = normaliseOrigin(line.includes("://") ? line : `https://${line}`);
    if (!origin || !(new URL(origin).hostname.includes(".") || new URL(origin).hostname === "localhost")) {
      return { error: `"${line}" isn't a web address.` };
    }
    if (!out.includes(origin)) out.push(origin);
  }
  if (!out.length) return { error: "Allow at least one domain: the site's own." };
  if (out.length > MAX_DOMAINS) return { error: `Allow at most ${MAX_DOMAINS} domains.` };
  return { domains: out };
}
