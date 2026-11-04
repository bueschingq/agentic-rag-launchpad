// The hash a sign-off records: everything visitors see (the theme, the widget's settings and
// text, and the prompt and language answers come from), so a later change shows "Changed since
// sign-off". Here rather than in the console so the demo seed signs off the same way.

import { createHash } from "node:crypto";
import type { ThemeInput, WidgetSettings } from "@launchpad/theme";

export function visitorSettingsHash(d: {
  theme: ThemeInput;
  widgetSettings: WidgetSettings;
  systemPrompt: string;
  language: string;
}): string {
  return createHash("sha256")
    .update(stableJson([d.theme, d.widgetSettings, d.systemPrompt, d.language]))
    .digest("hex")
    .slice(0, 32);
}

// JSON with sorted keys and undefined left out, so equal settings always hash the same.
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .filter((k) => o[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
