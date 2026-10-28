// Turns scraped styles into proposed theme tokens, each with a confidence and the evidence
// behind it, so the theme editor can highlight what deserves a human look. Contrast repair
// happens afterwards in resolveTheme().

import { mix, parseColor, type Rgba, saturationLightness, type ThemeInput, toHex } from "@launchpad/theme";
import type { RawButton, RawStyles } from "./extract.ts";

export interface DerivedTheme {
  input: ThemeInput;
  // 0–1 per token path, e.g. { "color.primary": 0.9 }.
  confidence: Record<string, number>;
  // Where each value came from, e.g. { "color.primary": "button \"Shop now\" ×12" }.
  sources: Record<string, string>;
}

const isBrandColor = (c: Rgba) => {
  const { s, l } = saturationLightness(c);
  return s >= 0.25 && l > 0.12 && l < 0.9;
};

// Prefer buttons that are common, large enough to be primary CTAs, and in a brand color.
function primaryButton(buttons: RawButton[]): RawButton | undefined {
  const score = (b: RawButton) => {
    const bg = parseColor(b.background);
    if (!bg || bg.a < 0.9) return -1;
    return Math.min(b.count, 10) + (isBrandColor(bg) ? 10 : 0) + (b.height >= 36 ? 2 : 0);
  };
  return [...buttons].filter((b) => score(b) >= 0).sort((a, b) => score(b) - score(a))[0];
}

// --brand-primary, --color-primary, --bs-primary, --primary… (values must be colors).
function brandVar(vars: Record<string, string>): [string, Rgba] | undefined {
  const names = Object.keys(vars).filter(
    (n) => /(^|-)(brand|primary)(-|$)/i.test(n) && !/(text|on|contrast|rgb|hover|light|dark)/i.test(n),
  );
  for (const name of names.sort((a, b) => a.length - b.length)) {
    const c = parseColor(vars[name]!);
    if (c && isBrandColor(c)) return [name, c];
  }
  return undefined;
}

function px(value: string | undefined): number | undefined {
  const n = value ? Number.parseFloat(value) : Number.NaN;
  return Number.isFinite(n) ? n : undefined;
}

const firstFamily = (stack: string) => stack.split(",")[0]?.trim().replace(/["']/g, "") ?? "";

export function deriveTheme(raw: RawStyles): DerivedTheme {
  const input: ThemeInput = { color: {}, font: {}, shape: {} };
  const confidence: Record<string, number> = {};
  const sources: Record<string, string> = {};
  const set = <K extends "color" | "font" | "shape">(
    group: K,
    key: keyof NonNullable<ThemeInput[K]>,
    value: string,
    conf: number,
    source: string,
  ) => {
    (input[group] as Record<string, string>)[key as string] = value;
    confidence[`${group}.${String(key)}`] = conf;
    sources[`${group}.${String(key)}`] = source;
  };

  // Surface and text: the page body.
  const surface = parseColor(raw.body.background) ?? { r: 255, g: 255, b: 255, a: 1 };
  const text = parseColor(raw.body.color) ?? { r: 17, g: 24, b: 39, a: 1 };
  set("color", "surface", toHex(surface), 0.8, "body background");
  set("color", "text", toHex(text), 0.8, "body text");
  set("color", "surfaceAlt", toHex(mix(surface, text, 0.05)), 0.5, "body background, slightly shaded");
  set("color", "textMuted", toHex(mix(text, surface, 0.3)), 0.5, "body text, softened");
  set("color", "border", toHex(mix(surface, text, 0.18)), 0.4, "body colors");

  // Primary: the dominant CTA button, else a brand custom property, else the link color.
  const button = primaryButton(raw.buttons);
  const fromVar = brandVar(raw.rootVars);
  const link = raw.linkColor ? parseColor(raw.linkColor) : undefined;
  if (button && isBrandColor(parseColor(button.background)!)) {
    set(
      "color",
      "primary",
      toHex(parseColor(button.background)!),
      button.count >= 3 ? 0.9 : 0.7,
      `button "${button.text}" ×${button.count}`,
    );
    const on = parseColor(button.color);
    if (on) set("color", "onPrimary", toHex(on), 0.8, `button "${button.text}" text`);
  } else if (fromVar) {
    set("color", "primary", toHex(fromVar[1]), 0.8, fromVar[0]);
  } else if (link && isBrandColor(link)) {
    set("color", "primary", toHex(link), 0.5, "link color");
  }
  if (link) set("color", "link", toHex(link), 0.7, "most common body link color");
  const primary = input.color?.primary;
  if (primary) set("color", "focus", primary, 0.6, "primary color");

  // Typography: the stack as the site declares it. The family must actually have loaded, or
  // the visitor would see a fallback (the widget uses fonts already on the page; it loads none).
  const bodyFamily = firstFamily(raw.body.fontFamily);
  const loaded = raw.loadedFonts.map((f) => f.toLowerCase());
  const generic = /^(serif|sans-serif|system-ui|-apple-system|monospace|arial|helvetica|georgia|times new roman)$/i.test(bodyFamily);
  if (bodyFamily && (generic || loaded.includes(bodyFamily.toLowerCase()))) {
    set("font", "family", raw.body.fontFamily, generic ? 0.6 : 0.9, "body font");
  }
  if (raw.heading && firstFamily(raw.heading.fontFamily) !== bodyFamily)
    set("font", "headingFamily", raw.heading.fontFamily, 0.7, "first heading");
  const size = px(raw.body.fontSize);
  if (size && size >= 13 && size <= 19) set("font", "size", `${size}px`, 0.8, "body font size");
  const lh = px(raw.body.lineHeight);
  if (size && lh) set("font", "lineHeight", (lh / size).toFixed(2), 0.7, "body line height");

  // Shape: follow the button's corners; pills stay pills on buttons, panels get a sane radius.
  const radius = px(button?.borderRadius);
  if (button && radius !== undefined) {
    const pill = radius >= button.height / 2;
    set("shape", "buttonRadius", pill ? "999px" : `${radius}px`, 0.8, `button "${button.text}" corners`);
    set("shape", "bubbleRadius", `${Math.min(pill ? 18 : radius * 1.5, 18)}px`, 0.5, "button corners");
    set("shape", "radius", `${Math.min(Math.max(pill ? 16 : radius * 2, 4), 20)}px`, 0.5, "button corners");
  }
  const inputRadius = px(raw.input?.borderRadius);
  if (inputRadius !== undefined) set("shape", "inputRadius", `${Math.min(inputRadius, 999)}px`, 0.7, "first text input");

  return { input, confidence, sources };
}
