// The widget's design tokens. Values arrive from the style sniffer (scraped from a customer
// site) or the theme editor, and end up inside a <style> on that customer's page, so every
// value is normalised or checked against an allow-list before it is used.

import { bestOn, contrastRatio, ensureContrast, parseColor, toHex } from "./color.ts";

export interface ThemeTokens {
  color: {
    primary: string; // launcher, send button, user messages
    onPrimary: string;
    surface: string; // panel background
    surfaceAlt: string; // header, assistant messages
    text: string;
    textMuted: string;
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
    offset: string;
    size: string;
  };
}

export type ThemeInput = { [K in keyof ThemeTokens]?: Partial<ThemeTokens[K]> };

// White-label by default: neutral, and AA-compliant as shipped.
export const defaultTheme: ThemeTokens = {
  color: {
    primary: "#1f2937",
    onPrimary: "#ffffff",
    surface: "#ffffff",
    surfaceAlt: "#f3f4f6",
    text: "#111827",
    textMuted: "#4b5563",
    border: "#d1d5db",
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
    size: "56px",
  },
};

const LENGTH = /^(0|-?\d*\.?\d+(px|rem|em|%))$/;
const UNITLESS = /^\d*\.?\d+$/;
const FONT_STACK = /^[\w\s,"'.-]{1,200}$/;
const SHADOW = /^(none|[\w\s.,()#%-]{1,160})$/;

export interface ResolvedTheme {
  theme: ThemeTokens;
  // Values dropped or adjusted, for the theme editor to show.
  warnings: string[];
}

export function resolveTheme(input: ThemeInput = {}, base: ThemeTokens = defaultTheme): ResolvedTheme {
  const warnings: string[] = [];
  const pick = <T extends string>(path: string, value: unknown, fallback: T, valid: (v: string) => boolean): T => {
    if (value === undefined) return fallback;
    if (typeof value === "string" && valid(value.trim())) return value.trim() as T;
    warnings.push(`${path}: ignored invalid value ${JSON.stringify(value)}`);
    return fallback;
  };
  const color = (key: keyof ThemeTokens["color"]) => {
    const raw = input.color?.[key];
    if (raw === undefined) return base.color[key];
    const parsed = typeof raw === "string" ? parseColor(raw) : undefined;
    if (!parsed) {
      warnings.push(`color.${key}: ignored invalid color ${JSON.stringify(raw)}`);
      return base.color[key];
    }
    return toHex(parsed);
  };

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
      family: pick("font.family", input.font?.family, base.font.family, (v) => FONT_STACK.test(v)),
      headingFamily: pick("font.headingFamily", input.font?.headingFamily, base.font.headingFamily, (v) => FONT_STACK.test(v)),
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
      position: pick("launcher.position", input.launcher?.position, base.launcher.position, (v) => v === "bottom-right" || v === "bottom-left"),
      offset: pick("launcher.offset", input.launcher?.offset, base.launcher.offset, (v) => LENGTH.test(v)),
      size: pick("launcher.size", input.launcher?.size, base.launcher.size, (v) => LENGTH.test(v)),
    },
  };

  enforceContrast(theme, warnings);
  return { theme, warnings };
}

// WCAG AA: 4.5:1 for text, 3:1 for the focus ring and borders that identify controls.
function enforceContrast(theme: ThemeTokens, warnings: string[]) {
  const c = theme.color;
  const fix = (key: keyof ThemeTokens["color"], against: keyof ThemeTokens["color"], min: number) => {
    const fg = parseColor(c[key])!;
    const bg = parseColor(c[against])!;
    if (contrastRatio(fg, bg) >= min) return;
    const fixed = toHex(ensureContrast(fg, bg, min));
    warnings.push(`color.${key}: ${c[key]} → ${fixed} for ${min}:1 contrast on color.${against}`);
    c[key] = fixed;
  };

  // onPrimary is usually a guess (sniffed buttons often use white); pick black/white if it fails.
  const primary = parseColor(c.primary)!;
  if (contrastRatio(parseColor(c.onPrimary)!, primary) < 4.5) {
    const fixed = toHex(bestOn(primary));
    warnings.push(`color.onPrimary: ${c.onPrimary} → ${fixed} for 4.5:1 contrast on color.primary`);
    c.onPrimary = fixed;
  }
  fix("text", "surface", 4.5);
  fix("text", "surfaceAlt", 4.5);
  fix("textMuted", "surface", 4.5);
  fix("link", "surface", 4.5);
  fix("focus", "surface", 3);
}

// CSS custom properties consumed by the widget's shadow-DOM stylesheet.
export function toCssVariables(theme: ThemeTokens, selector = ":host"): string {
  const vars: [string, string][] = [
    ["color-primary", theme.color.primary],
    ["color-on-primary", theme.color.onPrimary],
    ["color-surface", theme.color.surface],
    ["color-surface-alt", theme.color.surfaceAlt],
    ["color-text", theme.color.text],
    ["color-text-muted", theme.color.textMuted],
    ["color-border", theme.color.border],
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
    ["launcher-size", theme.launcher.size],
  ];
  return `${selector} {\n${vars.map(([name, value]) => `  --arag-chat-${name}: ${value};`).join("\n")}\n}`;
}
