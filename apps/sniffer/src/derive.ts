// Turns scraped styles into proposed theme tokens, each with a confidence and the evidence
// behind it, so the theme editor can highlight what deserves a human look. Contrast repair
// happens afterwards in resolveTheme(). Also proposes a chat name with its sources, avatar
// options, the privacy notice, the contact page and the bottom bar, and lists the site's
// languages and web fonts (siteDetails).

import {
  ensureContrast,
  type Finish,
  type LogoCandidate,
  mix,
  type NameSource,
  parseColor,
  type Rgba,
  relativeLuminance,
  type SiteFont,
  type SiteScanExtras,
  saturationLightness,
  type ThemeInput,
  toHex,
} from "@launchpad/theme";
import type { RawButton, RawIcon, RawSite, RawStyles } from "./extract.ts";

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

interface Paint {
  fill?: Rgba;
  gradientEnd?: Rgba;
  finish: Finish;
}

// How a button is painted. Two distinct opaque stops make a gradient (the first is its fill);
// translucent white over a solid color is a sheen. getComputedStyle reports stops as rgb()/rgba().
export function buttonPaint(b: RawButton): Paint {
  const base = parseColor(b.background);
  const solid = base && base.a >= 0.9 ? base : undefined;
  if (!b.backgroundImage.includes("gradient(")) return { fill: solid, finish: "flat" };
  const stops = [...b.backgroundImage.matchAll(/rgba?\([^)]*\)/g)].flatMap((m) => parseColor(m[0]) ?? []);
  const opaque = stops.filter((c) => c.a >= 0.9);
  const [first, last] = [opaque[0], opaque.at(-1)];
  const distinct = first && last && Math.max(Math.abs(first.r - last.r), Math.abs(first.g - last.g), Math.abs(first.b - last.b)) > 16;
  if (distinct) return { fill: first, gradientEnd: last, finish: "gradient" };
  if (solid && stops.some((c) => c.a < 0.9 && relativeLuminance(c) > 0.8)) return { fill: solid, finish: "gloss" };
  return { fill: solid ?? first, finish: "flat" };
}

// Prefer buttons in a brand color, then the hero's call to action, then big ones above the
// fold over a small "Free trial" in the navigation, then common ones. Repetition counts for
// least: a page repeats its navigation buttons more than its main one.
export function buttonScore(b: RawButton): number {
  const bg = buttonPaint(b).fill;
  if (!bg) return -1;
  const area = b.area ?? b.width * b.height;
  return (isBrandColor(bg) ? 10 : 0) + (b.hero ? 3 : 0) + (b.aboveFold ? 3 : 0) + Math.min(area / 2000, 6) + Math.min(b.count, 3);
}

function primaryButton(buttons: RawButton[]): RawButton | undefined {
  return [...buttons].filter((b) => buttonScore(b) >= 0).sort((a, b) => buttonScore(b) - buttonScore(a))[0];
}

// One button is never proof of a brand color; several of the same look, more so.
const buttonConfidence = (count: number) => (count >= 3 ? 0.9 : count === 2 ? 0.7 : 0.5);

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
  const input: ThemeInput = { color: {}, font: {}, shape: {}, finish: {} };
  const confidence: Record<string, number> = {};
  const sources: Record<string, string> = {};
  const set = <K extends "color" | "font" | "shape" | "finish">(
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
  // Borders outline the question box, so 3:1 on the background from the start.
  set("color", "border", toHex(ensureContrast(mix(surface, text, 0.3), surface, 3)), 0.4, "body colors");

  // Primary: the dominant CTA button, else a brand custom property, else the link color.
  const button = primaryButton(raw.buttons);
  const paint = button && buttonPaint(button);
  const fromVar = brandVar(raw.rootVars);
  const link = raw.linkColor ? parseColor(raw.linkColor) : undefined;
  if (button && paint?.fill && isBrandColor(paint.fill)) {
    set("color", "primary", toHex(paint.fill), buttonConfidence(button.count), `button "${button.text}" ×${button.count}`);
    const on = parseColor(button.color);
    if (on) set("color", "onPrimary", toHex(on), 0.8, `button "${button.text}" text`);
    // Finish: whatever the CTA's background implies. A plain fill is only weak evidence of flat.
    set("finish", "style", paint.finish, paint.finish === "flat" ? 0.6 : 0.8, `button "${button.text}" background`);
    if (paint.gradientEnd) set("finish", "gradientEnd", toHex(paint.gradientEnd), 0.8, `button "${button.text}" gradient`);
  } else if (fromVar) {
    set("color", "primary", toHex(fromVar[1]), 0.8, fromVar[0]);
  } else if (link && isBrandColor(link)) {
    set("color", "primary", toHex(link), 0.5, "link color");
  } else {
    // Nothing qualified: the default stays, flagged like any other guess.
    confidence["color.primary"] = 0.2;
    sources["color.primary"] = "not found: the default";
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
  } else {
    confidence["font.family"] = 0.2;
    sources["font.family"] = "not found: the default";
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

const GENERIC_NAMES = /^(home|homepage|home page|welcome|index|official site|official website|website|site|untitled)$/i;
const fold = (text: string) =>
  text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");

const okName = (name: string | undefined): name is string =>
  Boolean(name && name.length >= 2 && name.length <= 40 && !GENERIC_NAMES.test(name) && !/^https?:/.test(name));
const clean = (name: string | undefined) => name?.replace(/\s+/g, " ").trim();
// "Telerik.com" reads better as "Telerik".
const undomain = (name: string | undefined) => (name && /^[\w-]+(\.[a-z]{2,})+$/i.test(name) ? name.split(".")[0] : name);
const SEPARATORS = /\s+[-–—·•|]\s+|\s*\|\s*|:\s+/;
// A logo's alt text without the words around the name ("Progress logo", "Go to the home page"),
// and before any tagline ("WhatsUp Gold - a Progress Software Company").
const fromAlt = (alt: string | undefined) =>
  clean(
    alt
      ?.split(SEPARATORS)[0]
      ?.replace(/\b(logo(type)?|home ?page|home|go to|back to|return to|link to|the|startseite|accueil|inicio)\b/gi, " ")
      .replace(/^[\s\-–—|:,.]+|[\s\-–—|:,.]+$/g, ""),
  );
// The same name, maybe spelled differently: "What's Up Gold" and "WhatsUp Gold", or one inside
// the other ("Progress" and "Progress Software").
const related = (a: string, b: string) => {
  const [x, y] = [fold(a), fold(b)];
  return Boolean(x && y && (x.includes(y) || y.includes(x)));
};
// The same name spelled differently ("What's Up Gold", "WhatsUp Gold"). Case only counts when
// neither is all one case: "CRAYOLA" is styling.
const respelled = (a: string, b: string) => {
  if (a === b || fold(a) !== fold(b)) return false;
  const styled = (s: string) => s === s.toUpperCase() || s === s.toLowerCase();
  return a.toLowerCase() !== b.toLowerCase() || (!styled(a) && !styled(b));
};

export interface ProposedName {
  name?: string;
  // Each source's version of the name, the one proposed first.
  sources: NameSource[];
  // The sources disagree, or only the domain backs the name: a person should pick.
  check: boolean;
}

// The site's own name, for the chat's. Compares the page title (the part that names the site:
// "Crayola | Official Site" → "Crayola"), the header logo's alt text, og:site_name, structured
// data and the domain. The name most of them give wins ("Progress" over the title's "Progress
// Software"), spelled as the title, then the logo, has it. og:site_name is often a social label
// ("What's Up Gold" on whatsupgold.com, whose title says "WhatsUp Gold"), so a source that
// spells the name differently, or names something else, flags it with every source.
export function proposeName(site: RawSite | undefined, host: string): ProposedName {
  const label = host.replace(/^www\./, "").split(".")[0] ?? "";
  const domain = label.length >= 2 ? label.charAt(0).toUpperCase() + label.slice(1) : undefined;
  const og = undomain(clean(site?.ogSiteName));
  const alt = fromAlt(site?.logoAlt);
  const segments = (site?.title ?? "").split(SEPARATORS).map(clean);
  // The shortest segment naming the site: "Telerik", not "Telerik: UI and reporting tools".
  const naming = (other: string | undefined) =>
    other ? segments.filter((s): s is string => okName(s) && related(s, other)).sort((a, b) => a.length - b.length)[0] : undefined;
  const title = naming(label) ?? naming(alt) ?? naming(og);
  const structured = [...(site?.jsonLdNames ?? []), site?.applicationName].map(clean).map(undomain).find(okName);

  const found: NameSource[] = [
    ...(okName(title) ? [{ source: "title" as const, value: title }] : []),
    ...(okName(alt) ? [{ source: "logo-alt" as const, value: alt }] : []),
    ...(okName(og) ? [{ source: "og:site_name" as const, value: og }] : []),
    ...(structured ? [{ source: "structured-data" as const, value: structured }] : []),
    ...(domain ? [{ source: "domain" as const, value: domain }] : []),
  ];
  const named = found.filter((s) => s.source !== "domain");
  // A vote per source for each name, in found's order (title, logo, og:site_name, structured
  // data); the domain only breaks ties.
  const votes = (value: string) => found.reduce((n, s) => n + (fold(s.value) === fold(value) ? (s.source === "domain" ? 0.5 : 1) : 0), 0);
  const pick = named.reduce<string | undefined>((best, s) => (!best || votes(s.value) > votes(best) ? s.value : best), undefined) ?? domain;
  if (!pick) return { sources: [], check: true };
  const compared = named.filter((s) => s.source !== "structured-data");
  const check =
    !named.length ||
    compared.some((s) => !related(s.value, pick) || respelled(s.value, pick)) ||
    (named.length === 1 && domain !== undefined && !related(pick, domain));
  const first = found.find((s) => s.value === pick);
  return { name: pick, sources: [...(first ? [first] : []), ...found.filter((s) => s !== first)], check };
}

// The chat name alone (proposeName has the evidence).
export const siteName = (site: RawSite | undefined, host: string): string | undefined => proposeName(site, host).name;

// Avatar options: header logos linking home, then the home-screen icon and the larger
// browser-tab icons, each with its size, then og:image for a person to check. Which one reads
// best at the chat's size is the console's call (preferredAvatar).
export function logoCandidates(raw: RawStyles): LogoCandidate[] {
  const out: LogoCandidate[] = [];
  const add = (c: LogoCandidate) => {
    if (!out.some((o) => o.url === c.url)) out.push(c);
  };
  for (const l of raw.logos ?? [])
    add({ url: l.url, source: "header-home", width: l.width, height: l.height, ...(l.alt && { alt: l.alt }) });
  // Its size as loaded, else as declared.
  const sized = (i: RawIcon) =>
    i.width && i.height ? { width: i.width, height: i.height } : i.size ? { width: i.size, height: i.size } : {};
  const icons = [...(raw.iconLinks ?? [])].sort(
    (a, b) => Number(b.rel === "apple-touch-icon") - Number(a.rel === "apple-touch-icon") || (sized(b).width ?? 0) - (sized(a).width ?? 0),
  );
  for (const i of icons.slice(0, 3)) add({ url: i.url, source: i.rel, ...sized(i) });
  const og = raw.site?.ogImage;
  if (og?.startsWith("https:")) add({ url: og, source: "og:image", check: true });
  return out.slice(0, 6);
}

// The scan's suggestions beyond the theme: a chat name and where it came from, avatar options,
// the privacy notice, the contact page, a bar along the bottom of the window, the page's
// languages, and its web fonts over https.
export function siteDetails(raw: RawStyles, finalUrl: string): SiteScanExtras {
  const proposed = proposeName(raw.site, new URL(finalUrl).hostname);
  const fonts = (raw.fonts ?? []).filter((f): f is SiteFont => f.url.startsWith("https:"));
  const privacy = raw.privacy?.url.startsWith("https:") ? raw.privacy.url : undefined;
  const contact = raw.contact?.url.startsWith("https:") ? raw.contact.url : undefined;
  return {
    ...(proposed.name && { siteName: proposed.name }),
    nameSources: proposed.sources,
    nameCheck: proposed.check,
    logoCandidates: logoCandidates(raw),
    ...(privacy && { privacyUrl: privacy }),
    ...(contact && { contactUrl: contact }),
    ...(raw.bottomBar && { bottomBar: raw.bottomBar }),
    ...(raw.lang && { pageLanguage: raw.lang }),
    languages: raw.hreflang ?? [],
    fonts,
  };
}
