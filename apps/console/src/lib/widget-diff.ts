// What a widget save changed, judged by what visitors get: the theme as resolved (contrast
// repairs and all) and the settings with the widget's defaults filled in, compared by value, not
// by the order the JSON happens to come back in (the database sorts an object's keys, the form
// doesn't), and with empty lists and blank text the same as none. The audit log records the
// changed keys and a short hash of each one's value before and after, never the values, so
// Review can list only what still differs from the signed-off version, and the partner channel's
// post names the field. Pure, so the worker uses it too and it runs under node:test.

import { createHash } from "node:crypto";
import { defaultWidgetSettings, resolveTheme, type ThemeInput, type WidgetSettings } from "@launchpad/theme";

export interface WidgetDiff {
  // "settings.welcome", "theme.color.primary"…, sorted.
  changed: string[];
  // Each changed key's value before and after, as a short hash.
  hashes: Record<string, [string, string]>;
}

// Blank text, empty lists and objects with nothing in them show visitors nothing: the same as no value.
function prune(value: unknown): unknown {
  if (value === null || value === undefined || value === "") return undefined;
  if (Array.isArray(value)) return value.length ? value.map((v) => prune(v) ?? null) : undefined;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .map(([k, v]) => [k, prune(v)] as const)
      .filter(([, v]) => v !== undefined);
    return entries.length ? Object.fromEntries(entries) : undefined;
  }
  return value;
}

// JSON with sorted keys: equal values always read the same.
function stableJson(value: unknown): string {
  if (value === undefined) return "";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

const short = (json: string) => createHash("sha256").update(json).digest("hex").slice(0, 12);

// Every value visitors meet, by key, as stable JSON.
function visible(theme: ThemeInput, settings: WidgetSettings): Map<string, string> {
  const out = new Map<string, string>();
  const resolved = resolveTheme(theme).theme;
  for (const [group, tokens] of Object.entries(resolved)) {
    for (const [token, value] of Object.entries(tokens)) {
      // "#1A4D8F" is "#1a4d8f".
      out.set(`theme.${group}.${token}`, stableJson(prune(group === "color" ? String(value).toLowerCase() : value)));
    }
  }
  // The gradient's second stop shows only with the gradient finish; it follows the primary otherwise.
  if (resolved.finish.style !== "gradient") out.delete("theme.finish.gradientEnd");
  // The language belongs to the deployment (it sets the answer language too), not the widget page.
  const { language: _, ...rest } = { ...defaultWidgetSettings, ...settings };
  for (const [key, value] of Object.entries(rest)) out.set(`settings.${key}`, stableJson(prune(value)));
  return out;
}

export function widgetDiff(
  before: { theme: ThemeInput; settings: WidgetSettings },
  after: { theme: ThemeInput; settings: WidgetSettings },
): WidgetDiff {
  const a = visible(before.theme, before.settings);
  const b = visible(after.theme, after.settings);
  const changed = [...new Set([...a.keys(), ...b.keys()])].filter((k) => (a.get(k) ?? "") !== (b.get(k) ?? "")).sort();
  return { changed, hashes: Object.fromEntries(changed.map((k) => [k, [short(a.get(k) ?? ""), short(b.get(k) ?? "")]])) };
}

// Since the sign-off: the keys whose value now differs from the signed-off one, from the widget
// saves' audit details, oldest first. A field changed and changed back drops out. Saves recorded
// before the hashes were count as changed.
export function changedSinceSignOff(details: readonly unknown[]): Set<string> {
  const first = new Map<string, string | undefined>();
  const last = new Map<string, string | undefined>();
  for (const detail of details) {
    const d = (detail ?? {}) as { changed?: unknown; hashes?: Record<string, unknown> };
    if (!Array.isArray(d.changed)) continue;
    for (const key of d.changed) {
      if (typeof key !== "string") continue;
      const pair = d.hashes?.[key];
      const [was, now] = Array.isArray(pair) && pair.length === 2 ? (pair as [string, string]) : [undefined, undefined];
      if (!first.has(key)) first.set(key, was);
      last.set(key, now);
    }
  }
  return new Set([...last.keys()].filter((k) => first.get(k) === undefined || last.get(k) === undefined || first.get(k) !== last.get(k)));
}

// The fields' names in a partner's words. A theme token not named here is its group.
const FIELD_WORDS: Record<string, string> = {
  "settings.nickname": "the chat name",
  "settings.avatar": "the avatar",
  "theme.color.primary": "the primary color",
  // The text on the primary color, which follows it for contrast.
  "theme.color.onPrimary": "the primary color",
  "settings.welcome": "the welcome message",
  "settings.starters": "the starter questions",
  "settings.placeholder": "the question box's hint",
  "settings.disclosure": "the AI disclosure line",
  "settings.offlineMessage": "the offline message",
  "settings.copy": "the chat's own wording",
  "settings.handoff": "the handoff",
  "settings.lead": "the contact form",
  "settings.ctas": "the buttons",
  "settings.privacyUrl": "the privacy link",
  "settings.mode": "the layout",
  "settings.languages": "the languages",
  "settings.translations": "the translations",
  "settings.showSources": "the source links",
  "settings.feedback": "the thumbs",
  "settings.poweredBy": "the Powered by line",
  "settings.exclude": "the pages it stays off",
  "settings.analytics": "Google Analytics",
  "settings.liftAboveBars": "the lift above cookie bars",
  "settings.customCss": "the custom CSS",
};
const GROUP_WORDS: Record<string, string> = {
  color: "the colors",
  font: "the font",
  shape: "the corners and shadow",
  launcher: "the chat button",
  finish: "the finish",
};

// "the chat name", "the welcome message and the buttons"…: what a save changed, in words.
export function fieldWords(keys: readonly string[]): string {
  const words = keys.map((k) => {
    if (FIELD_WORDS[k]) return FIELD_WORDS[k];
    const [kind, group, token] = k.split(".");
    // Saves recorded before tokens were told apart name the group: "theme.color".
    if (kind === "theme") return (token && GROUP_WORDS[group ?? ""]) || "the theme";
    return group ?? k;
  });
  const parts = [...new Set(words)];
  if (!parts.length) return "the widget";
  return parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : parts[0]!;
}
