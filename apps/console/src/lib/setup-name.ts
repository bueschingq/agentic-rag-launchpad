// The name typed in setup mode, on every audit entry setup mode writes (round 5, 7d). Setup mode
// can't tell who is at the keyboard, so the name is typed once per session: the first name field
// (components/typed-name.ts) keeps it in a session cookie, and so does any confirmation that came
// with a typed name. An entry written without a name of its own (Sync now, Add, Read the pages
// again, a saved widget) then records the session's, marked like a typed one ({ name, verified:
// false }), so History, Review, Bring up to date and alerts name the person instead of "Someone
// in setup mode". Signed-in people are named by their account, and the worker's own runs aren't
// anyone's.

export const SETUP_NAME_COOKIE = "launchpad-setup-name";

// Entries whose `name` is the thing created (a customer's or a deployment's name): the typed
// name goes in `typedBy` instead.
const NAMES_A_THING = new Set(["customer.create", "deployment.create"]);
// Setup mode's own placeholder (lib/auth.ts) is nobody's name.
const SETUP_PLACEHOLDER = "Setup admin";

// A name as typed, from a value that may have been percent-encoded once or more: round 6's
// release check saw "H2%20Verifier" grow to "H2%25252520Verifier", one encoding per save (the
// server encoded the cookie value itself, and Next's cookies() encodes it again). Decoded until it
// stops changing, so names already stored that way heal. Pure.
export function decodeSetupName(raw: string): string {
  let name = raw;
  for (let i = 0; i < 8 && /%[0-9a-f]{2}/i.test(name); i++) {
    try {
      const next = decodeURIComponent(name);
      if (next === name) break;
      name = next;
    } catch {
      break;
    }
  }
  return name;
}

// A typed name as stored: decoded, the marker some confirmations add taken off, trimmed and bounded.
export function cleanSetupName(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const name = decodeSetupName(raw)
    .replace(/\s*\((?:setup mode, )?not verified\)/g, "")
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what's removed
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, 80);
  return name && name !== SETUP_PLACEHOLDER ? name : undefined;
}

type Detail = Record<string, unknown>;

// What an entry adds to its detail, given the session's typed name. Pure: the cookie is read by
// withSetupName. Undefined when the entry already says who it was, or isn't a person's.
export function setupNameDetail(
  row: { actorUserId?: string | null; action: string; detail?: unknown },
  session?: string,
): Detail | undefined {
  if (row.actorUserId) return undefined;
  const detail = (row.detail ?? {}) as Detail;
  if (detail.auto || detail.via === "share" || detail.recheck) return undefined;
  const name = cleanSetupName(session);
  if (!name) return undefined;
  if (NAMES_A_THING.has(row.action)) return typeof detail.typedBy === "string" ? undefined : { typedBy: name };
  if (cleanSetupName(detail.name)) return undefined;
  return { name, verified: false };
}

// The name an entry was confirmed with in setup mode, for the session to keep.
const typedWith = (row: { actorUserId?: string | null; action: string; detail?: unknown }): string | undefined => {
  if (row.actorUserId || NAMES_A_THING.has(row.action)) return undefined;
  const detail = (row.detail ?? {}) as Detail;
  return detail.auto ? undefined : cleanSetupName(detail.name);
};

type CookieStore = {
  get(name: string): { value: string } | undefined;
  set(name: string, value: string, options: Record<string, unknown>): unknown;
};
type HeadersModule = { cookies(): Promise<unknown> };
let headersModule: Promise<HeadersModule | undefined> | undefined;
async function cookieStore(): Promise<CookieStore | undefined> {
  // Outside the console (the worker, scripts) next/headers may not load at all; outside a request
  // cookies() throws. Either way nobody typed anything. The worker imports this file through
  // validation.ts and answers.ts and has no Next types, hence the ignore.
  // @ts-ignore: next/headers resolves in the console only
  headersModule ??= (import("next/headers") as Promise<HeadersModule>).catch(() => undefined);
  const mod = await headersModule;
  if (!mod) return undefined;
  try {
    return (await mod.cookies()) as unknown as CookieStore;
  } catch {
    return undefined;
  }
}

// An audit row as setup mode should write it: with the session's typed name when it has none of
// its own. A row confirmed with a typed name keeps that name for the rest of the session. Rows by
// a signed-in person, the worker or the install guide link go through unchanged.
export async function withSetupName<R extends { actorUserId?: string | null; action: string; detail?: unknown }>(row: R): Promise<R> {
  if (row.actorUserId) return row;
  const store = await cookieStore();
  if (!store) return row;
  const typed = typedWith(row);
  if (typed) {
    try {
      // Only actions and route handlers may set cookies; a page render can't, and needn't. The
      // value as it is: Next's cookies() percent-encodes it, as typed-name.ts does in the browser.
      store.set(SETUP_NAME_COOKIE, typed, { path: "/", sameSite: "lax" });
    } catch {}
    return row;
  }
  // Already decoded by cookies(); cleanSetupName undoes any older extra encoding.
  const session = store.get(SETUP_NAME_COOKIE)?.value || undefined;
  const add = setupNameDetail(row, session);
  return add ? { ...row, detail: { ...((row.detail ?? {}) as Detail), ...add } } : row;
}
