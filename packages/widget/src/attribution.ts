// Where the visit came from, for leads: the first page of the visit, the page that sent the
// visitor there, and the campaign tags in its address. Captured once per tab into sessionStorage
// (no cookies), so a lead sent from a later page still carries them. Only the allow-listed keys
// are kept, and only page addresses without their query string; nothing else in the address
// ever leaves the page. It leaves at all only inside a lead the visitor sent, with consent.

import type { StorageLike } from "./store.ts";

export const ATTRIBUTION_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "gclid"] as const;
export type AttributionKey = (typeof ATTRIBUTION_KEYS)[number];

export type Attribution = { landingPage: string; referrer?: string } & Partial<Record<AttributionKey, string>>;

const KEY = "arag-chat:attribution";
const MAX_VALUE = 200;

// An address without its query or fragment, which can carry personal details.
const bare = (href: string): string | undefined => {
  try {
    const u = new URL(href);
    return u.protocol === "https:" || u.protocol === "http:" ? `${u.origin}${u.pathname}` : undefined;
  } catch {
    return undefined;
  }
};

// What this page says about the visit. A tag that looks like an email address is dropped: it
// would be personal data, whatever key it came in.
export function readAttribution(href: string, referrer: string): Attribution | undefined {
  const landingPage = bare(href);
  if (!landingPage) return undefined;
  const params = new URL(href).searchParams;
  const out: Attribution = { landingPage };
  const from = referrer ? bare(referrer) : undefined;
  if (from) out.referrer = from;
  for (const key of ATTRIBUTION_KEYS) {
    const value = params.get(key)?.trim().slice(0, MAX_VALUE);
    if (value && !value.includes("@")) out[key] = value;
  }
  return out;
}

const session = (): StorageLike | undefined => {
  try {
    return globalThis.sessionStorage;
  } catch {
    return undefined;
  }
};

// The visit's attribution: what the first page of the visit recorded, or this page's when it is
// the first. Storage can be blocked; then each page speaks for itself.
export function captureAttribution(href: string, referrer: string, storage: StorageLike | undefined = session()): Attribution | undefined {
  try {
    const saved = JSON.parse(storage?.getItem(KEY) ?? "null") as Attribution | null;
    if (saved && typeof saved.landingPage === "string") return saved;
  } catch {
    // Unreadable: start again from this page.
  }
  const now = readAttribution(href, referrer);
  try {
    if (now) storage?.setItem(KEY, JSON.stringify(now));
  } catch {
    // Full or blocked.
  }
  return now;
}
