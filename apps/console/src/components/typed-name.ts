"use client";

// Setup mode can't tell who's at the keyboard, so each confirmation asks for a name. It's typed
// once per session: every name field (validation, starters, brand, review and sign-off) starts
// from the name typed this session, else the last one typed in this browser.

import { useEffect, useState } from "react";

const NAME_KEY = "launchpad:setup-name";
// The name typed this session, for the audit entries that have no name field of their own
// (lib/setup-name.ts reads it): a session cookie, so a name from another day never signs a
// change. The last name typed, in localStorage, only fills the fields in.
const SESSION_COOKIE = "launchpad-setup-name";

// A value encoded once or more (round 6: "H2%25252520Verifier" from an extra encoding per save),
// decoded until it stops changing: lib/setup-name.ts decodeSetupName, kept here so the browser
// bundle doesn't take that server file.
function decoded(raw: string): string {
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

function sessionName(): string | undefined {
  const raw = document.cookie
    .split("; ")
    .find((c) => c.startsWith(`${SESSION_COOKIE}=`))
    ?.slice(SESSION_COOKIE.length + 1);
  return raw ? decoded(raw) || undefined : undefined;
}

export function useTypedName(): [string, (name: string) => void] {
  const [name, setName] = useState("");
  useEffect(() => {
    try {
      const session = sessionName();
      const raw = localStorage.getItem(NAME_KEY);
      if (session) setName(session);
      else if (raw) setName(decoded(JSON.parse(raw) as string));
    } catch {
      // Private windows and blocked storage: the field starts empty.
    }
  }, []);
  const remember = (next: string) => {
    setName(next);
    // biome-ignore lint/suspicious/noDocumentCookie: a session cookie the server reads, nothing more
    document.cookie = next.trim()
      ? `${SESSION_COOKIE}=${encodeURIComponent(next.trim().slice(0, 80))}; path=/; SameSite=Lax`
      : `${SESSION_COOKIE}=; path=/; max-age=0; SameSite=Lax`;
    try {
      if (next.trim()) localStorage.setItem(NAME_KEY, JSON.stringify(next));
      else localStorage.removeItem(NAME_KEY);
    } catch {
      // Not kept; the name still goes with this confirmation.
    }
  };
  return [name, remember];
}
