// Small color toolkit: parse what getComputedStyle and partners produce, normalise to hex,
// and measure / repair WCAG 2.x contrast.

export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

const NAMED: Record<string, string> = { white: "#ffffff", black: "#000000", transparent: "#00000000" };

export function parseColor(input: string): Rgba | undefined {
  const s = input.trim().toLowerCase();
  const named = NAMED[s];
  if (named) return parseColor(named);

  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(s)?.[1];
  if (hex) {
    const full = hex.length <= 4 ? [...hex].map((c) => c + c).join("") : hex;
    const n = (i: number) => Number.parseInt(full.slice(i, i + 2), 16);
    return { r: n(0), g: n(2), b: n(4), a: full.length === 8 ? n(6) / 255 : 1 };
  }

  // rgb(1, 2, 3) · rgba(1, 2, 3, 0.5) · rgb(1 2 3 / 50%)
  const fn = /^rgba?\(\s*([^)]+)\)$/.exec(s)?.[1];
  if (fn) {
    const parts = fn.split(/[\s,/]+/).filter(Boolean);
    if (parts.length !== 3 && parts.length !== 4) return undefined;
    const channel = (p: string) => (p.endsWith("%") ? (Number.parseFloat(p) / 100) * 255 : Number.parseFloat(p));
    const alpha = (p: string | undefined) => (p === undefined ? 1 : p.endsWith("%") ? Number.parseFloat(p) / 100 : Number.parseFloat(p));
    const [r, g, b, a] = [channel(parts[0]!), channel(parts[1]!), channel(parts[2]!), alpha(parts[3])];
    if ([r, g, b, a].some((v) => !Number.isFinite(v))) return undefined;
    return { r: clamp(r, 0, 255), g: clamp(g, 0, 255), b: clamp(b, 0, 255), a: clamp(a, 0, 1) };
  }
  return undefined;
}

export function toHex({ r, g, b }: Pick<Rgba, "r" | "g" | "b">): string {
  return `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;
}

// Composite a translucent color over an opaque background.
export function flatten(color: Rgba, background: Rgba): Rgba {
  const mix = (c: number, bg: number) => c * color.a + bg * (1 - color.a);
  return { r: mix(color.r, background.r), g: mix(color.g, background.g), b: mix(color.b, background.b), a: 1 };
}

export function relativeLuminance({ r, g, b }: Pick<Rgba, "r" | "g" | "b">): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

export function contrastRatio(a: Rgba, b: Rgba): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const BLACK: Rgba = { r: 0, g: 0, b: 0, a: 1 };
const WHITE: Rgba = { r: 255, g: 255, b: 255, a: 1 };

// Linear blend: t = 0 gives `a`, t = 1 gives `b`. Used to derive muted text and borders.
export function mix(a: Rgba, b: Rgba, t: number): Rgba {
  return { r: lerp(a.r, b.r, t), g: lerp(a.g, b.g, t), b: lerp(a.b, b.b, t), a: 1 };
}

// Hue-independent saturation and lightness (HSL, 0–1), for telling brand colors from greys.
export function saturationLightness({ r, g, b }: Pick<Rgba, "r" | "g" | "b">): { s: number; l: number } {
  const [max, min] = [Math.max(r, g, b) / 255, Math.min(r, g, b) / 255];
  const l = (max + min) / 2;
  const s = max === min ? 0 : l > 0.5 ? (max - min) / (2 - max - min) : (max - min) / (max + min);
  return { s, l };
}

// Turn the hue `degrees` around the HSL wheel, keeping saturation and lightness. Derives the
// gradient finish's second stop from the primary color.
export function rotateHue(color: Rgba, degrees: number): Rgba {
  const [r, g, b] = [color.r / 255, color.g / 255, color.b / 255];
  const [max, min] = [Math.max(r, g, b), Math.min(r, g, b)];
  const d = max - min;
  if (d === 0) return { ...color };
  const l = (max + min) / 2;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h6 = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  const h = (((h6 * 60 + degrees) % 360) + 360) % 360;
  const amp = s * Math.min(l, 1 - l);
  const channel = (n: number) => {
    const k = (n + h / 30) % 12;
    return (l - amp * Math.max(-1, Math.min(k - 3, 9 - k, 1))) * 255;
  };
  return { r: channel(0), g: channel(8), b: channel(4), a: color.a };
}

// Black or white, whichever reads better on `background`.
export function bestOn(background: Rgba): Rgba {
  return contrastRatio(BLACK, background) >= contrastRatio(WHITE, background) ? BLACK : WHITE;
}

// Nudge `foreground` toward black or white until it reaches `min` against `background`,
// keeping as much of its hue as possible. Returns the original when it already passes.
export function ensureContrast(foreground: Rgba, background: Rgba, min = 4.5): Rgba {
  const fg = flatten(foreground, background);
  if (contrastRatio(fg, background) >= min) return fg;
  const target = bestOn(background);
  for (let t = 0.05; t <= 1; t += 0.05) {
    const mixed = { r: lerp(fg.r, target.r, t), g: lerp(fg.g, target.g, t), b: lerp(fg.b, target.b, t), a: 1 };
    if (contrastRatio(mixed, background) >= min) return mixed;
  }
  return target;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
