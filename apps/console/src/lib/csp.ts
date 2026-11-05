// The Content Security Policy entries a customer site needs for the widget, for sites that
// send a CSP. The widget's styles are constructable stylesheets, so it needs no 'unsafe-inline'.

import { zoneOrigin } from "@launchpad/par-client";

export interface CspNeeds {
  consoleOrigin: string;
  zone: string;
  // The avatar, when the widget shows one: an https image, or an inline SVG logo as a data: URL.
  avatarUrl?: string;
}

// What img-src must allow for an image: its origin, or the data: scheme for an inline one (whose
// URL has no origin of its own: new URL(…).origin is "null").
export function imageSource(url: string): string | undefined {
  if (/^data:/i.test(url)) return "data:";
  try {
    const { protocol, origin } = new URL(url);
    return protocol === "https:" || protocol === "http:" ? origin : undefined;
  } catch {
    return undefined;
  }
}

export function cspDirectives({ consoleOrigin, zone, avatarUrl }: CspNeeds): Record<string, string[]> {
  const avatar = avatarUrl ? imageSource(avatarUrl) : undefined;
  return {
    "script-src": [consoleOrigin],
    // Config, tokens and counts from the console; answers streamed from Agentic RAG's zone.
    "connect-src": [consoleOrigin, zoneOrigin(zone)],
    ...(avatar && avatar !== consoleOrigin ? { "img-src": [avatar] } : {}),
  };
}

// Lines to add to the site's existing directives (not a whole policy to replace it).
export function cspSnippet(needs: CspNeeds): string {
  return Object.entries(cspDirectives(needs))
    .map(([directive, sources]) => `${directive} ${sources.join(" ")}`)
    .join(";\n");
}
