// The widget's design tokens. Values arrive from the style sniffer (scraped from a customer
// site) or the theme editor, and end up inside a <style> on that customer's page, so every
// value is normalised or checked against an allow-list before it is used.

import { bestOn, contrastRatio, ensureContrast, flatten, mix, parseColor, type Rgba, rotateHue, toHex } from "./color.ts";

// Surface treatment of the launcher, buttons, user messages and header.
export const FINISHES = ["flat", "gloss", "gradient"] as const;
export type Finish = (typeof FINISHES)[number];

export interface ThemeTokens {
  color: {
    primary: string; // launcher, send button, user messages
    onPrimary: string;
    surface: string; // panel background
    surfaceAlt: string; // header, assistant messages
    text: string;
    textMuted: string;
    // Outlines controls (the question box, starter questions), so 3:1 on surface.
    border: string;
    link: string;
    focus: string;
  };
  font: {
    family: string;
    headingFamily: string;
    size: string;
    lineHeight: string;
  };
  shape: {
    radius: string; // panel
    bubbleRadius: string;
    buttonRadius: string;
    inputRadius: string;
    shadow: string;
  };
  launcher: {
    position: "bottom-right" | "bottom-left";
    // From the side of the window.
    offset: string;
    // From the bottom, e.g. to clear a cookie bar. Follows offset when an input leaves it out.
    bottom: string;
    size: string;
  };
  finish: {
    style: Finish;
    // The gradient finish runs from color.primary to this. Derived from the primary color
    // whenever an input changes primary without naming one.
    gradientEnd: string;
  };
}

export type ThemeInput = { [K in keyof ThemeTokens]?: Partial<ThemeTokens[K]> };

const DEFAULT_PRIMARY = "#1f2937";
const DEFAULT_ON_PRIMARY = "#ffffff";

// White-label by default: neutral, and AA-compliant as shipped.
export const defaultTheme: ThemeTokens = {
  color: {
    primary: DEFAULT_PRIMARY,
    onPrimary: DEFAULT_ON_PRIMARY,
    surface: "#ffffff",
    surfaceAlt: "#f3f4f6",
    text: "#111827",
    textMuted: "#4b5563",
    border: "#868b93",
    link: "#1d4ed8",
    focus: "#2563eb",
  },
  font: {
    family: 'system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif',
    headingFamily: "inherit",
    size: "15px",
    lineHeight: "1.5",
  },
  shape: {
    radius: "12px",
    bubbleRadius: "10px",
    buttonRadius: "8px",
    inputRadius: "8px",
    shadow: "0 12px 32px rgba(0, 0, 0, 0.18)",
  },
  launcher: {
    position: "bottom-right",
    offset: "24px",
    bottom: "24px",
    size: "56px",
  },
  finish: {
    style: "flat",
    gradientEnd: toHex(gradientPartner(parseColor(DEFAULT_PRIMARY)!, parseColor(DEFAULT_ON_PRIMARY)!)),
  },
};

const LENGTH = /^(0|-?\d*\.?\d+(px|rem|em|%))$/;
const UNITLESS = /^\d*\.?\d+$/;
const FONT_STACK = /^[\w\s,"'.-]{1,200}$/;
const SHADOW = /^(none|[\w\s.,()#%-]{1,160})$/;

// A color the theme changed so text or a control stays readable: `path` went from `from`
// to `to` to reach `min`:1 against `against`. launcher.outline is drawn around the chat
// button when the primary color alone doesn't stand out from the page.
export interface Repair {
  path: string;
  from: string;
  to: string;
  against: string;
  min: number;
}

export interface ResolvedTheme {
  theme: ThemeTokens;
  // Values dropped or adjusted, for the theme editor to show.
  warnings: string[];
  // The adjusted ones, structured, for the editor to put in plain words.
  repairs: Repair[];
}

export function resolveTheme(input: ThemeInput = {}, base: ThemeTokens = defaultTheme): ResolvedTheme {
  const warnings: string[] = [];
  const repairs: Repair[] = [];
  const pick = <T extends string>(path: string, value: unknown, fallback: T, valid: (v: string) => boolean): T => {
    if (value === undefined) return fallback;
    if (typeof value === "string" && valid(value.trim())) return value.trim() as T;
    warnings.push(`${path}: ignored invalid value ${JSON.stringify(value)}`);
    return fallback;
  };
  const hex = (path: string, raw: unknown): string | undefined => {
    const parsed = typeof raw === "string" ? parseColor(raw) : undefined;
    if (!parsed) warnings.push(`${path}: ignored invalid color ${JSON.stringify(raw)}`);
    return parsed && toHex(parsed);
  };
  const color = (key: keyof ThemeTokens["color"]) => {
    const raw = input.color?.[key];
    return (raw !== undefined && hex(`color.${key}`, raw)) || base.color[key];
  };
  // undefined: derive it once onPrimary is final (enforceContrast).
  const endInput = input.finish?.gradientEnd;
  const gradientEnd =
    (endInput !== undefined && hex("finish.gradientEnd", endInput)) ||
    (input.color?.primary === undefined ? base.finish.gradientEnd : undefined);

  const theme: ThemeTokens = {
    color: {
      primary: color("primary"),
      onPrimary: color("onPrimary"),
      surface: color("surface"),
      surfaceAlt: color("surfaceAlt"),
      text: color("text"),
      textMuted: color("textMuted"),
      border: color("border"),
      link: color("link"),
      focus: color("focus"),
    },
    font: {
      family: withFallback(pick("font.family", input.font?.family, base.font.family, (v) => FONT_STACK.test(v))),
      headingFamily: withFallback(
        pick("font.headingFamily", input.font?.headingFamily, base.font.headingFamily, (v) => FONT_STACK.test(v)),
      ),
      size: pick("font.size", input.font?.size, base.font.size, (v) => LENGTH.test(v)),
      lineHeight: pick("font.lineHeight", input.font?.lineHeight, base.font.lineHeight, (v) => UNITLESS.test(v) || LENGTH.test(v)),
    },
    shape: {
      radius: pick("shape.radius", input.shape?.radius, base.shape.radius, (v) => LENGTH.test(v)),
      bubbleRadius: pick("shape.bubbleRadius", input.shape?.bubbleRadius, base.shape.bubbleRadius, (v) => LENGTH.test(v)),
      buttonRadius: pick("shape.buttonRadius", input.shape?.buttonRadius, base.shape.buttonRadius, (v) => LENGTH.test(v)),
      inputRadius: pick("shape.inputRadius", input.shape?.inputRadius, base.shape.inputRadius, (v) => LENGTH.test(v)),
      shadow: pick("shape.shadow", input.shape?.shadow, base.shape.shadow, (v) => SHADOW.test(v)),
    },
    launcher: {
      position: pick(
        "launcher.position",
        input.launcher?.position,
        base.launcher.position,
        (v) => v === "bottom-right" || v === "bottom-left",
      ),
      offset: pick("launcher.offset", input.launcher?.offset, base.launcher.offset, (v) => LENGTH.test(v)),
      bottom: "",
      size: pick("launcher.size", input.launcher?.size, base.launcher.size, (v) => LENGTH.test(v)),
    },
    finish: {
      style: pick("finish.style", input.finish?.style, base.finish.style, (v) => (FINISHES as readonly string[]).includes(v)),
      gradientEnd: gradientEnd ?? "",
    },
  };

  // Themes saved before the vertical offset existed keep their chat button where it was.
  const sideways = input.launcher?.offset === undefined ? base.launcher.bottom : theme.launcher.offset;
  theme.launcher.bottom = pick("launcher.bottom", input.launcher?.bottom, sideways, (v) => LENGTH.test(v));

  enforceContrast(theme, warnings, repairs);
  return { theme, warnings, repairs };
}

// WCAG 2.2 AA: 4.5:1 for text; 3:1 for the focus ring, the borders that identify controls
// (1.4.11) and the chat button. Secondary text and links sit on the panel and inside answers,
// so they're checked against both.
function enforceContrast(theme: ThemeTokens, warnings: string[], repairs: Repair[]) {
  const c = theme.color;
  const record = (path: string, from: string, to: string, against: string, min: number) => {
    warnings.push(`${path}: ${from} → ${to} for ${min}:1 contrast on ${against}`);
    repairs.push({ path, from, to, against, min });
  };
  const fix = (key: keyof ThemeTokens["color"], against: keyof ThemeTokens["color"], min: number) => {
    const fg = parseColor(c[key])!;
    const bg = parseColor(c[against])!;
    if (contrastRatio(fg, bg) >= min) return;
    const fixed = toHex(ensureContrast(fg, bg, min));
    record(`color.${key}`, c[key], fixed, `color.${against}`, min);
    c[key] = fixed;
  };

  // onPrimary is usually a guess (sniffed buttons often use white); pick black/white if it fails.
  const primary = parseColor(c.primary)!;
  if (contrastRatio(parseColor(c.onPrimary)!, primary) < 4.5) {
    const fixed = toHex(bestOn(primary));
    record("color.onPrimary", c.onPrimary, fixed, "color.primary", 4.5);
    c.onPrimary = fixed;
  }
  fix("text", "surface", 4.5);
  fix("text", "surfaceAlt", 4.5);
  fix("textMuted", "surface", 4.5);
  fix("textMuted", "surfaceAlt", 4.5);
  fix("link", "surface", 4.5);
  fix("link", "surfaceAlt", 4.5);
  fix("border", "surface", 3);
  fix("focus", "surface", 3);
  fix("focus", "surfaceAlt", 3);

  const outline = launcherOutline(theme);
  if (outline) record("launcher.outline", "none", outline, "color.surface", 3);

  // Gradient finish: onPrimary text can sit anywhere between the two stops.
  const on = parseColor(c.onPrimary)!;
  const end = parseColor(theme.finish.gradientEnd);
  if (!end) {
    theme.finish.gradientEnd = toHex(gradientPartner(parseColor(c.primary)!, on));
  } else {
    const fitted = toHex(fitGradient(parseColor(c.primary)!, end, on));
    if (fitted !== theme.finish.gradientEnd) {
      warnings.push(`finish.gradientEnd: ${theme.finish.gradientEnd} → ${fitted} for 4.5:1 contrast with color.onPrimary`);
      theme.finish.gradientEnd = fitted;
    }
  }
}

// A neighbouring hue, so gradients read as the brand color rather than a second brand.
function gradientPartner(primary: Rgba, onPrimary: Rgba): Rgba {
  return fitGradient(primary, rotateHue(primary, 30), onPrimary);
}

// Moves `end` away from `text` until the text passes everywhere along start → end. Mixing in
// sRGB can dip below both stops' luminance mid-way, hence the samples. `start` must pass.
function fitGradient(start: Rgba, end: Rgba, text: Rgba, min = 4.5): Rgba {
  const passes = (e: Rgba) => [0, 0.25, 0.5, 0.75, 1].every((t) => contrastRatio(text, mix(start, e, t)) >= min);
  if (passes(end)) return end;
  const away = bestOn(text);
  for (let step = 1; step <= 10; step++) {
    const candidate = mix(end, away, step / 10);
    if (passes(candidate)) return candidate;
  }
  return away;
}

// The chat button's fill must stand out 3:1 from the page, which the panel's background stands
// in for. A light brand color (yellow on white) keeps its fill and gets an outline that does.
export function launcherOutline(theme: ThemeTokens): string | undefined {
  const [primary, surface] = [parseColor(theme.color.primary)!, parseColor(theme.color.surface)!];
  if (contrastRatio(primary, surface) >= 3) return undefined;
  const candidates = [theme.color.text, theme.color.onPrimary, toHex(bestOn(surface))];
  return candidates.find((color) => contrastRatio(parseColor(color)!, surface) >= 3);
}

// Peak opacity of the gloss finish's white sheen; styles.ts draws it from this variable.
export const GLOSS_SHEEN = 0.2;
const WHITE: Rgba = { r: 255, g: 255, b: 255, a: 1 };

// Gloss finish: the fill under the sheen. Where the sheen would leave `text` short of 4.5:1
// (white text on mid-tone brand colors), the fill is deepened just enough to carry it.
export function glossBase(fill: Rgba, text: Rgba, min = 4.5): Rgba {
  const passes = (base: Rgba) => contrastRatio(text, flatten({ ...WHITE, a: GLOSS_SHEEN }, base)) >= min;
  const away = bestOn(text);
  for (let step = 0; step <= 20; step++) {
    const base = mix(fill, away, step / 20);
    if (passes(base)) return base;
  }
  return away;
}

// CSS custom properties consumed by the widget's shadow-DOM stylesheet.
// The scan's family, with something to fall back on: a page that doesn't load the client's web font
// otherwise shows the chat in the browser's default serif (round 7: "Noto Sans" alone). In the resolved
// theme, so the widget's config, the preview and the snippet's theme all have it.
const withFallback = <T extends string | undefined>(family: T): T =>
  (family && !/serif|monospace|system-ui|inherit/i.test(family)
    ? `${family}, system-ui, -apple-system, "Segoe UI", sans-serif`
    : family) as T;

export function toCssVariables(theme: ThemeTokens, selector = ":host"): string {
  const vars: [string, string][] = [
    ["color-primary", theme.color.primary],
    ["color-on-primary", theme.color.onPrimary],
    ["color-surface", theme.color.surface],
    ["color-surface-alt", theme.color.surfaceAlt],
    ["color-text", theme.color.text],
    ["color-text-muted", theme.color.textMuted],
    ["color-border", theme.color.border],
    // Lines that separate rather than identify (the header's edge, the handoff card), softer.
    ["color-divider", toHex(mix(parseColor(theme.color.border)!, parseColor(theme.color.surface)!, 0.5))],
    ["color-link", theme.color.link],
    ["color-focus", theme.color.focus],
    ["font-family", theme.font.family],
    ["font-heading-family", theme.font.headingFamily],
    ["font-size", theme.font.size],
    ["line-height", theme.font.lineHeight],
    ["radius", theme.shape.radius],
    ["bubble-radius", theme.shape.bubbleRadius],
    ["button-radius", theme.shape.buttonRadius],
    ["input-radius", theme.shape.inputRadius],
    ["shadow", theme.shape.shadow],
    ["launcher-offset", theme.launcher.offset],
    ["launcher-bottom", theme.launcher.bottom],
    ["launcher-outline", launcherOutline(theme) ?? "transparent"],
    ["launcher-size", theme.launcher.size],
    ["gradient-end", theme.finish.gradientEnd],
    ["gloss-sheen", String(GLOSS_SHEEN)],
    ["gloss-base", toHex(glossBase(parseColor(theme.color.primary)!, parseColor(theme.color.onPrimary)!))],
    ["gloss-header-base", toHex(glossBase(parseColor(theme.color.surfaceAlt)!, parseColor(theme.color.text)!))],
  ];
  return `${selector} {\n${vars.map(([name, value]) => `  --arag-chat-${name}: ${value};`).join("\n")}\n}`;
}
