// The widget configurator's draft and its validation. Pure, so it runs in the browser (live
// preview, contrast notes) and under node:test. Everything here ends up on customers' pages:
// links are limited to web pages, email and phone, and custom CSS can't pull in stylesheets.

import {
  type BottomBar,
  COPY_KEYS,
  type CopyOverrides,
  HANDOFF_PLACES,
  type HandoffContact,
  type HandoffPlace,
  isLanguage,
  type Language,
  type LanguageSetting,
  LEAD_FIELDS,
  type LocalizedCopy,
  type LogoCandidate,
  type NameSource,
  parseColor,
  preferredAvatar,
  type Repair,
  relativeLuminance,
  resolveTheme,
  type SiteFont,
  type ThemeInput,
  type ThemeTokens,
  WIDGET_MODES,
  type WidgetCta,
  type WidgetLead,
  type WidgetSettings,
} from "@launchpad/theme";
// Types only: customer-form.ts reads @launchpad/db, which can't go into the browser bundle.
import type { FormErrors } from "./customer-form.ts";

// Every theme token (resolved, so each control has a value) and the widget settings.
export interface WidgetDraft {
  theme: ThemeTokens;
  settings: WidgetSettings;
}

export interface WidgetValue {
  theme: ThemeInput;
  settings: WidgetSettings;
}

export const LIMITS = {
  nickname: 60,
  welcome: 500,
  placeholder: 120,
  disclosure: 300,
  offlineMessage: 500,
  starters: 4,
  starter: 120,
  handoffMessage: 200,
  contacts: 3,
  label: 40,
  ctas: 6,
  keywords: 10,
  copy: 200,
  leadText: 300,
  exclude: 30,
  pattern: 200,
  customCss: 10_000,
} as const;

// Shown as the partner types, not only on Save.
export function tooManyKeywords(keywords: readonly string[]): string | undefined {
  const n = new Set(keywords.map((k) => k.trim()).filter(Boolean)).size;
  return n > LIMITS.keywords ? `Use at most ${LIMITS.keywords} keywords (${n} now).` : undefined;
}

// Pages a widget is usually kept off: sign-in, payment and account pages.
export const SUGGESTED_EXCLUDES = ["/login", "/checkout/*", "/account/*"];

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MEASUREMENT_ID = /^G-[A-Z0-9]{4,16}$/;
const PHONE = /^\+?[0-9]{4,20}$/;
const PATTERN = /^[/*][^\s]*$/;

export function draftFor(theme: ThemeInput, settings: WidgetSettings): WidgetDraft {
  // Language belongs to the deployment (it also sets the answer language), not the widget page.
  const { language: _, ...rest } = settings;
  return { theme: resolveTheme(theme).theme, settings: rest };
}

// ---- contact links: the configurator edits a type and a value, the widget gets a URL ----

export type ContactKind = "page" | "phone" | "email";

export function contactParts(url: string): { type: ContactKind; value: string } {
  if (url.startsWith("tel:")) return { type: "phone", value: url.slice(4) };
  if (url.startsWith("mailto:")) return { type: "email", value: url.slice(7) };
  return { type: "page", value: url };
}

// Handoff contacts the partner can add with one click: the site's contact page (linked from its
// header or footer, as the scan found it, else from the pages synced into the KB) and the
// customer's primary contact. Never added without the partner.
export interface ContactSuggestion {
  contact: HandoffContact;
  why: string;
  from: "scan" | "pages" | "primary";
}

const CONTACT_PAGE =
  /^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?(?:contact|contact-us|contactus|get-in-touch|kontakt|contacto|contactez-nous|contatti|contato)\/?$/i;

export function handoffSuggestions(
  pages: { url: string }[],
  primary: { name: string; email: string; phone: string | null } | undefined,
): ContactSuggestion[] {
  const found = pages
    .flatMap((p) => {
      try {
        const u = new URL(p.url);
        return u.protocol === "https:" && CONTACT_PAGE.test(u.pathname) ? [u.href] : [];
      } catch {
        return [];
      }
    })
    .sort((a, b) => a.length - b.length)[0];
  return [
    ...(found ? [{ contact: { kind: "link" as const, url: found }, why: "The site's contact page", from: "pages" as const }] : []),
    ...(primary?.phone
      ? [
          {
            contact: { kind: "link" as const, url: `tel:${primary.phone.trim()}` },
            why: `${primary.name}'s phone (the customer's primary contact)`,
            from: "primary" as const,
          },
        ]
      : []),
    ...(primary
      ? [
          {
            contact: { kind: "link" as const, url: `mailto:${primary.email}` },
            why: `${primary.name}'s email (the customer's primary contact)`,
            from: "primary" as const,
          },
        ]
      : []),
  ];
}

// The contact page the scan found in the site's header or footer goes first, ahead of the
// primary contact, and in place of one guessed from the synced pages' addresses.
export function withContactPage(suggestions: ContactSuggestion[], scanned: string | undefined): ContactSuggestion[] {
  const url = scanned ? httpsUrl(scanned) : undefined;
  if (!url) return suggestions;
  return [
    { contact: { kind: "link", url }, why: "The site's contact page, linked from its header or footer", from: "scan" },
    ...suggestions.filter((s) => s.from !== "pages" && s.contact.url !== url),
  ];
}

// An empty phone or email row keeps its scheme, so the row remembers its type.
export function contactUrl(type: ContactKind, value: string): string {
  const v = value.trim();
  if (type === "phone") return `tel:${v}`;
  if (type === "email") return `mailto:${v}`;
  return v;
}

// https pages, email and phone. Returns the normalised URL, or undefined.
export function safeLink(raw: string): string | undefined {
  const value = raw.trim();
  if (value.startsWith("tel:")) {
    // Digits only, after an optional +: the separators people type are only for reading.
    const number = value.slice(4).replace(/[\s().-]/g, "");
    return PHONE.test(number) ? `tel:${number}` : undefined;
  }
  if (value.startsWith("mailto:")) return EMAIL.test(value.slice(7)) ? value : undefined;
  return httpsUrl(value);
}

// The page the sniffer scans: any http(s) address with a real host; a bare host means https.
// The sniffer itself refuses private and local addresses.
export function scanTarget(raw: string): string | undefined {
  const value = raw.trim();
  try {
    const url = new URL(value.includes("://") ? value : `https://${value}`);
    return (url.protocol === "https:" || url.protocol === "http:") && url.hostname.includes(".") ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function httpsUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname.includes(".") ? url.href : undefined;
  } catch {
    return undefined;
  }
}

// ---- presets: what Essentials and Fine-tune offer before the raw values ----

export const CORNER_PRESETS = {
  square: { label: "Square", values: { radius: "4px", bubbleRadius: "4px", buttonRadius: "4px", inputRadius: "4px" } },
  rounded: { label: "Rounded", values: { radius: "12px", bubbleRadius: "10px", buttonRadius: "8px", inputRadius: "8px" } },
  pill: { label: "Pill", values: { radius: "16px", bubbleRadius: "18px", buttonRadius: "999px", inputRadius: "999px" } },
} as const;

export const SHADOW_PRESETS = {
  none: { label: "None", value: "none" },
  soft: { label: "Soft", value: "0 12px 32px rgba(0, 0, 0, 0.18)" },
  strong: { label: "Strong", value: "0 18px 48px rgba(0, 0, 0, 0.32)" },
} as const;

export type CornerPreset = keyof typeof CORNER_PRESETS;
export type ShadowPreset = keyof typeof SHADOW_PRESETS;

// The preset the theme's values match, or undefined when they've been set by hand.
export function cornerPreset(shape: ThemeTokens["shape"]): CornerPreset | undefined {
  return (Object.keys(CORNER_PRESETS) as CornerPreset[]).find((name) =>
    Object.entries(CORNER_PRESETS[name].values).every(([key, value]) => shape[key as keyof ThemeTokens["shape"]] === value),
  );
}

export const shadowPreset = (shadow: string): ShadowPreset | undefined =>
  (Object.keys(SHADOW_PRESETS) as ShadowPreset[]).find((name) => SHADOW_PRESETS[name].value === shadow.trim());

// "24px" ↔ 24, for the chat button's distances, which are entered as numbers.
export const pixels = (length: string): number | undefined => {
  const match = /^(-?\d*\.?\d+)px$/.exec(length.trim());
  return match ? Number(match[1]) : undefined;
};

// ---- plain words for what the scan and the contrast checks did ----

// A color's everyday name: "yellow", "dark green", "light grey".
export function colorName(color: string): string {
  const c = parseColor(color);
  if (!c) return color;
  const [r, g, b] = [c.r / 255, c.g / 255, c.b / 255];
  const [max, min] = [Math.max(r, g, b), Math.min(r, g, b)];
  const l = (max + min) / 2;
  const d = max - min;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  if (l < 0.1) return "black";
  if (l > 0.93) return "white";
  const shade = (name: string) => (l < 0.3 ? `dark ${name}` : l > 0.75 ? `light ${name}` : name);
  if (s < 0.15) return shade("grey");
  const h = (max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4) * 60;
  const hue =
    h < 15
      ? "red"
      : h < 42
        ? "orange"
        : h < 70
          ? "yellow"
          : h < 160
            ? "green"
            : h < 195
              ? "teal"
              : h < 255
                ? "blue"
                : h < 290
                  ? "purple"
                  : h < 340
                    ? "pink"
                    : "red";
  return shade(hue);
}

const SOURCES: [RegExp, (m: RegExpExecArray) => string][] = [
  [/^button "(.*)" ×(\d+)$/, (m) => `Taken from the site's “${m[1]}” button${Number(m[2]) > 1 ? `, used ${m[2]} times` : ""}`],
  [/^button "(.*)" text$/, (m) => `The text color of the site's “${m[1]}” button`],
  [/^button "(.*)" background$/, (m) => `From the background of the site's “${m[1]}” button`],
  [/^button "(.*)" gradient$/, (m) => `From the gradient on the site's “${m[1]}” button`],
  [/^button "(.*)" corners$/, (m) => `From the corners of the site's “${m[1]}” button`],
  [/^button corners$/, () => "Matched to the site's button corners"],
  [/^(--[\w-]+)$/, (m) => `From the site's brand color setting (${m[1]})`],
  [/link color$/, () => "From the color of the site's links"],
  [/^body background$/, () => "From the page's background"],
  [/^body text$/, () => "From the page's text color"],
  [/^body background, slightly shaded$/, () => "A shade of the page's background"],
  [/^body text, softened$/, () => "A lighter shade of the page's text"],
  [/^body colors$/, () => "Mixed from the page's colors"],
  [/^primary color$/, () => "Same as the primary color"],
  [/^body font$/, () => "From the font of the page's text"],
  [/^first heading$/, () => "From the font of the page's main heading"],
  [/^body font size$/, () => "From the size of the page's text"],
  [/^body line height$/, () => "From the page's line spacing"],
  [/^first text input$/, () => "From the site's first text box"],
  [/^not found/, () => "Not found on the site, so this is the default"],
  [/^name (.+)$/, (m) => `From ${NAME_SOURCE_WORDS[m[1] as NameSource["source"]] ?? m[1]}`],
  [/^site name$/, () => "The site's own name"],
  [/^customer display name$/, () => "The customer's “Name visitors see”"],
  [/^logo header-home$/, () => "The logo in the page header, which links to home"],
  [/^logo header-home wide$/, () => "The logo in the page header, the only option found: it's wide, so hard to read at the chat's size"],
  [/^logo apple-touch-icon$/, () => "The site's home-screen icon, square and sharp at the chat's size"],
  [/^logo icon$/, () => "The site's browser-tab icon, square and sharp at the chat's size"],
  [/^logo (icon|apple-touch-icon) unsized$/, (m) => `${LOGO_SOURCE_WORDS[m[1] as "icon"]}: its size isn't known, so check it looks sharp`],
  [/^footer privacy link$/, () => "Linked from the site's footer"],
  [/^bottom bar (.+)$/, (m) => `The page has a ${m[1]} along the bottom of the window`],
];

// Where a scanned value came from, as the sniffer records it, in words a junior can check.
export function plainSource(source: string): string {
  for (const [pattern, words] of SOURCES) {
    const match = pattern.exec(source);
    if (match) return words(match);
  }
  return `From ${source}`;
}

// What a contrast repair did and why, e.g. "Button text changed to black so it's readable on yellow."
export function plainRepair(repair: Repair, theme: ThemeTokens): string {
  const [from, to] = [parseColor(repair.from), parseColor(repair.to)];
  const moved = from && to && relativeLuminance(to) < relativeLuminance(from) ? "darkened" : "lightened";
  const onAnswers = repair.against === "color.surfaceAlt";
  switch (repair.path) {
    case "color.onPrimary":
      return `Button text changed to ${colorName(repair.to)} so it's readable on ${colorName(theme.color.primary)}.`;
    case "color.text":
      return `Text ${moved} so it's readable ${onAnswers ? "in the header and answers" : "on the background"}.`;
    case "color.textMuted":
      return `Secondary text ${moved} so it's readable ${onAnswers ? "in answers" : "on the background"}.`;
    case "color.link":
      return `Links ${moved} so they're readable ${onAnswers ? "in answers" : "on the background"}.`;
    case "color.border":
      return `Borders ${moved} so the question box and buttons stand out from the background.`;
    case "color.focus":
      return `The keyboard focus ring ${moved} so it stands out.`;
    case "finish.gradientEnd":
      return "The gradient's end color adjusted so button text stays readable all the way across.";
    case "launcher.outline":
      return `The chat button gets a ${colorName(repair.to)} outline so it stands out on a ${colorName(theme.color.surface)} page.`;
    default:
      return `${repair.path} adjusted for ${repair.min}:1 contrast.`;
  }
}

// ---- the scan's suggestions: nothing is applied without a person ----

// What the console keeps of a scan (SiteScanResult), as far as suggestions go.
export interface ScanFindings {
  contactUrl?: string;
  theme: ThemeTokens;
  confidence: Record<string, number>;
  sources: Record<string, string>;
  siteName?: string;
  nameSources?: NameSource[];
  nameCheck?: boolean;
  logo?: string;
  logoCandidates?: LogoCandidate[];
  icons?: string[];
  privacyUrl?: string;
  bottomBar?: BottomBar;
}

// Everything Apply all sets: the theme's colors, finish, fonts and corners, the chat name, the
// avatar, the privacy notice and the lift above a cookie bar. The chat button's own position
// and size are the partner's, and stay.
export type SuggestionKey = `${"color" | "finish" | "font" | "shape"}.${string}` | "nickname" | "avatar" | "privacyUrl" | "liftAboveBars";

export interface Suggestion {
  key: SuggestionKey;
  value: string | boolean;
  // Where it came from, as the sniffer says (plainSource() words it).
  source: string;
  // Below 0.6 confidence, a name the sources disagree on, or a logo the scan wasn't sure of.
  low: boolean;
}

const SUGGESTED_GROUPS = ["color", "finish", "font", "shape"] as const;

// What the console knows of the customer that the widget can use: the name visitors see.
export interface CustomerFindings {
  displayName?: string | null;
}

// The chat name from the customer's own record: what it calls itself to visitors is a better
// chat name than the scan's guess at the site's name, which stays an alternative.
function nameSuggestion(scan: ScanFindings | undefined, customer: CustomerFindings | undefined): Suggestion | undefined {
  const shown = customer?.displayName?.trim();
  if (shown) return { key: "nickname", value: shown.slice(0, LIMITS.nickname), source: "customer display name", low: false };
  if (!scan?.siteName) return undefined;
  const from = scan.nameSources?.[0]?.source;
  return { key: "nickname", value: scan.siteName, source: from ? `name ${from}` : "site name", low: scan.nameCheck === true };
}

// Before any scan: only the customer's name visitors see.
export function customerSuggestions(customer: CustomerFindings | undefined): Suggestion[] {
  const name = nameSuggestion(undefined, customer);
  return name ? [name] : [];
}

// The scan's proposals, one per value it actually found (a token it fell back to the default
// for is no proposal). The avatar is the option that reads best at the chat's size
// (preferredAvatar): a header logo that isn't a wide wordmark, else the site's square icons,
// else a wide logo marked "Check this". og:image never. Scans from before logo candidates
// existed propose none.
export function scanSuggestions(scan: ScanFindings, customer?: CustomerFindings): Suggestion[] {
  const out: Suggestion[] = [];
  for (const group of SUGGESTED_GROUPS) {
    for (const [key, value] of Object.entries(scan.theme[group])) {
      const path = `${group}.${key}`;
      const confidence = scan.confidence[path];
      const source = scan.sources[path] ?? "";
      if (confidence === undefined || source.startsWith("not found")) continue;
      out.push({ key: path as SuggestionKey, value: String(value), source, low: confidence < 0.6 });
    }
  }
  const name = nameSuggestion(scan, customer);
  if (name) out.push(name);
  const logo = preferredAvatar(scan.logoCandidates ?? []);
  if (logo) {
    const { candidate, check } = logo;
    const doubt = check ? (candidate.source === "header-home" ? " wide" : " unsized") : "";
    out.push({ key: "avatar", value: candidate.url, source: `logo ${candidate.source}${doubt}`, low: check });
  }
  if (scan.privacyUrl) out.push({ key: "privacyUrl", value: scan.privacyUrl, source: "footer privacy link", low: false });
  if (scan.bottomBar) out.push({ key: "liftAboveBars", value: true, source: `bottom bar ${scan.bottomBar.label}`, low: false });
  return out;
}

export function draftValue(draft: WidgetDraft, key: SuggestionKey): string | boolean | undefined {
  if (key === "liftAboveBars") return draft.settings.liftAboveBars !== false;
  if (key === "nickname" || key === "avatar" || key === "privacyUrl") return draft.settings[key];
  const [group, token] = key.split(".") as [(typeof SUGGESTED_GROUPS)[number], string];
  return (draft.theme[group] as Record<string, string>)[token];
}

// The proposals the draft doesn't have yet.
export const unapplied = (draft: WidgetDraft, suggestions: Suggestion[]): Suggestion[] =>
  suggestions.filter((s) => draftValue(draft, s.key) !== s.value);

// The draft with these proposals applied; nothing is saved until the partner saves.
export function applySuggestions(draft: WidgetDraft, suggestions: Suggestion[]): WidgetDraft {
  const theme = { ...draft.theme };
  const settings = { ...draft.settings };
  for (const s of suggestions) {
    if (s.key === "liftAboveBars") settings.liftAboveBars = s.value === true ? undefined : false;
    else if (s.key === "nickname" || s.key === "avatar" || s.key === "privacyUrl") settings[s.key] = String(s.value);
    else {
      const [group, token] = s.key.split(".") as [(typeof SUGGESTED_GROUPS)[number], string];
      theme[group] = { ...theme[group], [token]: String(s.value) } as never;
    }
  }
  return { theme, settings };
}

// In words, for the banner: "colors, fonts, the chat name and the logo".
export function suggestionTopics(suggestions: Suggestion[]): string[] {
  const has = (test: (s: Suggestion) => boolean) => suggestions.some(test);
  return [
    ...(has((s) => s.key.startsWith("color.") || s.key.startsWith("finish.")) ? ["colors"] : []),
    ...(has((s) => s.key.startsWith("font.")) ? ["fonts"] : []),
    ...(has((s) => s.key.startsWith("shape.")) ? ["corners"] : []),
    ...(has((s) => s.key === "nickname") ? ["the chat name"] : []),
    ...(has((s) => s.key === "avatar") ? ["the logo"] : []),
    ...(has((s) => s.key === "privacyUrl") ? ["the privacy notice"] : []),
    ...(has((s) => s.key === "liftAboveBars") ? ["the lift above the cookie bar"] : []),
  ];
}

// Where a name or a logo came from, in words.
export const NAME_SOURCE_WORDS: Record<NameSource["source"], string> = {
  title: "the page title",
  "logo-alt": "the header logo's alt text",
  "og:site_name": "og:site_name (the name for social sharing)",
  "structured-data": "the page's structured data",
  domain: "the domain",
};

export const LOGO_SOURCE_WORDS: Record<LogoCandidate["source"], string> = {
  "header-home": "Logo in the page header, links to home",
  "apple-touch-icon": "The site's home-screen icon (apple-touch-icon)",
  icon: "The site's browser-tab icon",
  "og:image": "The page's social sharing image (og:image): often a banner, not a logo",
};

// Font services whose stylesheets the console's previews may load. Faces from the site's own
// CSS are loaded with the FontFace API, which only fetches the font file.
const FONT_HOSTS = new Set(["fonts.googleapis.com", "use.typekit.net", "fonts.bunny.net", "fast.fonts.net", "cloud.typography.com"]);

// The scan's web fonts that a preview may load, so the widget is drawn in the site's own type:
// https only, stylesheets from font services, faces with a plain family name.
export function previewFonts(result: object | undefined): SiteFont[] {
  const fonts = (result as { fonts?: SiteFont[] } | undefined)?.fonts ?? [];
  return fonts.flatMap((f): SiteFont[] => {
    const url = httpsUrl(String(f.url));
    if (!url) return [];
    if (f.kind === "stylesheet") return FONT_HOSTS.has(new URL(url).hostname) ? [{ kind: f.kind, url }] : [];
    return /^[\w\s.-]{1,80}$/.test(f.family) ? [{ kind: f.kind, url, family: f.family, weight: f.weight, style: f.style }] : [];
  });
}

// The served languages whose contact form shows the widget's generic consent wording, because
// the partner wrote none for them. The main language's is lead.consentText; the others' are in
// translations. A deployment with one language serves just that one.
export function consentGaps(settings: WidgetSettings, language: LanguageSetting): Language[] {
  if (!settings.lead?.enabled) return [];
  const served: Language[] = language === "auto" ? (settings.languages?.length ? settings.languages : ["en"]) : [language];
  return served.filter((l, i) => (i === 0 ? !settings.lead?.consentText?.trim() : !settings.translations?.[l]?.leadConsent?.trim()));
}

// An avatar: an https image, or an inline SVG logo the scan found (percent-encoded, as the
// sniffer writes it) or another small image as a data: URL. Inside an <img>, an SVG can't run
// anything.
export function avatarUrl(raw: string): string | undefined {
  const value = raw.trim();
  if (/^data:image\/svg\+xml,[A-Za-z0-9%\-_.!~*'()]+$/.test(value)) return value.length <= 40_000 ? value : undefined;
  if (/^data:image\/(png|jpeg|webp|gif|svg\+xml);base64,[A-Za-z0-9+/]+=*$/.test(value)) return value.length <= 20_000 ? value : undefined;
  const url = httpsUrl(value);
  return url && url.length <= 1000 ? url : undefined;
}

// ---- validation ----

type Raw = Record<string, unknown>;
const isObject = (v: unknown): v is Raw => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

const THEME_KEYS: { [K in keyof ThemeTokens]: (keyof ThemeTokens[K])[] } = {
  color: ["primary", "onPrimary", "surface", "surfaceAlt", "text", "textMuted", "border", "link", "focus"],
  font: ["family", "headingFamily", "size", "lineHeight"],
  shape: ["radius", "bubbleRadius", "buttonRadius", "inputRadius", "shadow"],
  launcher: ["position", "offset", "bottom", "size"],
  finish: ["style", "gradientEnd"],
};

// Known tokens only, as typed. They're resolved (and contrast-repaired) when served.
function pickTheme(raw: unknown): ThemeInput {
  const theme: Record<string, Record<string, string>> = {};
  if (!isObject(raw)) return theme;
  for (const [group, keys] of Object.entries(THEME_KEYS)) {
    const values = raw[group];
    if (!isObject(values)) continue;
    for (const key of keys as string[]) {
      const value = str(values[key]);
      if (value) theme[group] = { ...theme[group], [key]: value };
    }
  }
  return theme as ThemeInput;
}

type Err = (key: string, message: string) => void;

export function parseWidgetDraft(json: string): { value: WidgetValue } | { errors: FormErrors } {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return { errors: { _form: "The configuration didn't arrive intact. Reload the page and try again." } };
  }
  if (!isObject(raw) || !isObject(raw.theme) || !isObject(raw.settings)) {
    return { errors: { _form: "The configuration didn't arrive intact. Reload the page and try again." } };
  }

  const errors: FormErrors = {};
  const theme = pickTheme(raw.theme);
  for (const warning of resolveTheme(theme).warnings) {
    const [path, problem] = warning.split(": ");
    if (path && problem?.startsWith("ignored invalid color")) errors[`theme.${path}`] = "Enter a color like #1a4d8f.";
    else if (path && problem?.startsWith("ignored invalid")) errors[`theme.${path}`] = "This value isn't allowed here.";
  }

  const s = raw.settings;
  const settings: WidgetSettings = {};
  const err: Err = (key, message) => {
    errors[`settings.${key}`] = message;
  };

  if (s.mode !== undefined) {
    if ((WIDGET_MODES as readonly unknown[]).includes(s.mode)) settings.mode = s.mode as WidgetSettings["mode"];
    else err("mode", "Choose a layout.");
  }

  for (const key of ["nickname", "welcome", "placeholder", "disclosure", "offlineMessage"] as const) {
    const value = str(s[key]);
    if (value.length > LIMITS[key]) err(key, `Keep this under ${LIMITS[key]} characters.`);
    else if (value) settings[key] = value;
  }

  const starters = parseStarters(s.starters, "starters", err);
  if (starters) settings.starters = starters;

  const copy = parseCopy(s.copy, "copy", err);
  if (copy) settings.copy = copy;

  settings.showSources = s.showSources !== false;
  settings.poweredBy = s.poweredBy === true;
  if (typeof s.feedback === "boolean") settings.feedback = s.feedback;

  const avatar = str(s.avatar);
  if (avatar) {
    const url = avatarUrl(avatar);
    if (!url) err("avatar", "Use an https image address.");
    else settings.avatar = url;
  }

  const lead = parseLead(s.lead, err);
  if (lead) settings.lead = lead;

  const handoff = parseHandoff(s.handoff, Boolean(lead?.enabled), err);
  if (handoff) settings.handoff = handoff;

  const ctas = parseCtas(s.ctas, Boolean(lead?.enabled), err);
  if (ctas.length) settings.ctas = ctas;

  if (isObject(s.analytics)) {
    const googleAnalytics = s.analytics.googleAnalytics === true;
    const measurementId = str(s.analytics.measurementId).toUpperCase();
    if (measurementId && !MEASUREMENT_ID.test(measurementId))
      err("analytics.measurementId", "A GA4 measurement ID looks like G-1A2B3C4D5E.");
    else if (googleAnalytics || measurementId) settings.analytics = { googleAnalytics, ...(measurementId && { measurementId }) };
  }

  const privacyUrl = str(s.privacyUrl);
  if (privacyUrl) {
    const url = httpsUrl(privacyUrl);
    if (!url || url.length > 1000) err("privacyUrl", "Enter the https address of the client's privacy notice.");
    else settings.privacyUrl = url;
  }

  if (s.liftAboveBars === false) settings.liftAboveBars = false;

  const exclude = [...new Set(list(s.exclude).map(str).filter(Boolean))];
  if (exclude.length > LIMITS.exclude) err("exclude", `Use at most ${LIMITS.exclude} patterns.`);
  else if (exclude.some((p) => !PATTERN.test(p) || p.length > LIMITS.pattern)) {
    err("exclude", "Start each pattern with / or *, without spaces, e.g. /login or /checkout/*.");
  } else if (exclude.length) settings.exclude = exclude;

  const languages = [...new Set(list(s.languages).filter(isLanguage))];
  if (languages.length) settings.languages = languages;
  const translations = parseTranslations(s.translations, languages, ctas, handoff?.contacts ?? [], err);
  if (translations) settings.translations = translations;

  const css = typeof s.customCss === "string" ? s.customCss.trim() : "";
  if (css.length > LIMITS.customCss) err("customCss", `Keep custom CSS under ${LIMITS.customCss.toLocaleString("en")} characters.`);
  else if (/@import/i.test(css)) err("customCss", "@import isn't allowed: the widget loads no stylesheets from other places.");
  else if (css) settings.customCss = css;

  return Object.keys(errors).length ? { errors } : { value: { theme, settings } };
}

function parseStarters(raw: unknown, key: string, err: Err): string[] | undefined {
  const starters = list(raw).map(str).filter(Boolean);
  if (starters.length > LIMITS.starters) err(key, `Use at most ${LIMITS.starters} starter questions.`);
  else if (starters.some((q) => q.length > LIMITS.starter)) err(key, `Keep each question under ${LIMITS.starter} characters.`);
  else if (starters.length) return starters;
  return undefined;
}

// The widget's own text the partner reworded; blanks mean "the default".
function parseCopy(raw: unknown, key: string, err: Err): CopyOverrides | undefined {
  if (!isObject(raw)) return undefined;
  const copy: CopyOverrides = {};
  for (const name of COPY_KEYS) {
    const value = str(raw[name]);
    if (value.length > LIMITS.copy) err(`${key}.${name}`, `Keep this under ${LIMITS.copy} characters.`);
    else if (value) copy[name] = value;
  }
  return Object.keys(copy).length ? copy : undefined;
}

function parseLead(raw: unknown, err: Err): WidgetLead | undefined {
  if (!isObject(raw)) return undefined;
  const fields = LEAD_FIELDS.filter((f) => list(raw.fields).includes(f));
  const requiredFields = fields.filter((f) => list(raw.requiredFields).includes(f));
  const lead: WidgetLead = { enabled: raw.enabled === true, fields, requiredFields };
  for (const key of ["intro", "consentText"] as const) {
    const value = str(raw[key]);
    if (value.length > LIMITS.leadText) err(`lead.${key}`, `Keep this under ${LIMITS.leadText} characters.`);
    else if (value) lead[key] = value;
  }
  if (raw.transcript === false) lead.transcript = false;
  if (lead.enabled && !fields.includes("email") && !fields.includes("phone")) {
    err("lead.fields", "Ask for an email address or a phone number, so the team can reply.");
  }
  return lead.enabled || lead.intro || lead.consentText ? lead : undefined;
}

function parseHandoff(raw: unknown, leadForm: boolean, err: Err): WidgetSettings["handoff"] {
  if (!isObject(raw)) return undefined;
  const contacts: HandoffContact[] = [];
  const rows = list(raw.contacts);
  rows.forEach((row, i) => {
    if (!isObject(row)) return;
    const [rawUrl, label] = [str(row.url), str(row.label)];
    if (!contactParts(rawUrl).value.trim() && !label) return; // a blank row
    const url = safeLink(rawUrl);
    if (!url) err(`handoff.contacts.${i}.url`, "Enter an https web page, a phone number or an email address.");
    if (label.length > LIMITS.label) err(`handoff.contacts.${i}.label`, `Keep the label under ${LIMITS.label} characters.`);
    if (url) contacts.push({ kind: "link", url, ...(label && { label }) });
  });
  if (contacts.length > LIMITS.contacts) err("handoff.contacts", `Use at most ${LIMITS.contacts} contacts.`);

  const show = list(raw.show).filter((p): p is HandoffPlace => (HANDOFF_PLACES as readonly unknown[]).includes(p));
  const message = str(raw.message);
  if (message.length > LIMITS.handoffMessage) err("handoff.message", `Keep the message under ${LIMITS.handoffMessage} characters.`);
  // The contact form is a way to reach someone too.
  if (show.length && !contacts.length && !leadForm && !rows.some((r) => isObject(r) && contactParts(str(r.url)).value.trim())) {
    err("handoff.show", "Add a contact or turn on the contact form first, or untick where it appears.");
  }
  if (!contacts.length && !show.length && !message) return undefined;
  return { contacts, show: [...new Set(show)], ...(message && { message }) };
}

function parseKeywords(raw: unknown, key: string, err: Err, required: boolean): string[] {
  const keywords = [...new Set(list(raw).map(str).filter(Boolean))];
  if (!keywords.length) {
    if (required) err(key, "Add at least one keyword that should bring up this button.");
  } else if (keywords.length > LIMITS.keywords) err(key, `Use at most ${LIMITS.keywords} keywords.`);
  else if (keywords.some((k) => k.length < 2 || k.length > 40)) err(key, "Keywords are 2 to 40 characters each.");
  return keywords;
}

function parseCtas(raw: unknown, leadForm: boolean, err: Err): WidgetCta[] {
  const ctas: WidgetCta[] = [];
  list(raw).forEach((row, i) => {
    if (!isObject(row)) return;
    const label = str(row.label);
    const rawUrl = str(row.url);
    const opensForm = row.action === "lead";
    const keywordsRaw = list(row.keywords).map(str).filter(Boolean);
    if (!label && !rawUrl && !keywordsRaw.length) return; // a blank row
    const f = (field: string) => `ctas.${i}.${field}`;
    if (!label) err(f("label"), "Give the button a label.");
    else if (label.length > LIMITS.label) err(f("label"), `Keep the label under ${LIMITS.label} characters.`);
    const url = opensForm ? "" : safeLink(rawUrl);
    if (opensForm && !leadForm) err(f("action"), "Turn on the contact form, or have this button open a link.");
    if (url === undefined) err(f("url"), "Enter an https web page, or a tel: or mailto: link.");
    const keywords = parseKeywords(row.keywords, f("keywords"), err, true);
    if (label && url !== undefined && keywords.length) {
      ctas.push({ label, url, keywords, ...(row.match === "contains" && { match: "contains" }), ...(opensForm && { action: "lead" }) });
    }
  });
  if (ctas.length > LIMITS.ctas) err("ctas", `Use at most ${LIMITS.ctas} buttons.`);
  return ctas;
}

// The copy for each language after the first. Each button, and each handoff contact, pairs by
// position with the main ones, and may link to the language's own page.
function parseTranslations(
  raw: unknown,
  languages: Language[],
  ctas: WidgetCta[],
  contacts: HandoffContact[],
  err: Err,
): WidgetSettings["translations"] {
  if (!isObject(raw)) return undefined;
  const out: NonNullable<WidgetSettings["translations"]> = {};
  for (const language of languages.slice(1)) {
    const t = raw[language];
    if (!isObject(t)) continue;
    const key = (field: string) => `translations.${language}.${field}`;
    const copy: LocalizedCopy = {};
    const texts = [
      ["nickname", LIMITS.nickname],
      ["welcome", LIMITS.welcome],
      ["placeholder", LIMITS.placeholder],
      ["disclosure", LIMITS.disclosure],
      ["offlineMessage", LIMITS.offlineMessage],
      ["handoffMessage", LIMITS.handoffMessage],
      ["leadIntro", LIMITS.leadText],
      ["leadConsent", LIMITS.leadText],
    ] as const;
    for (const [field, limit] of texts) {
      const value = str(t[field]);
      if (value.length > limit) err(key(field), `Keep this under ${limit} characters.`);
      else if (value) copy[field] = value;
    }
    const starters = parseStarters(t.starters, key("starters"), err);
    if (starters) copy.starters = starters;
    const overrides = parseCopy(t.copy, key("copy"), err);
    if (overrides) copy.copy = overrides;
    const rows = list(t.ctas).slice(0, ctas.length);
    const localCtas = rows.map((row, i) => {
      if (!isObject(row)) return {};
      const label = str(row.label);
      if (label.length > LIMITS.label) err(key(`ctas.${i}.label`), `Keep the label under ${LIMITS.label} characters.`);
      // Optional: the main keywords match in every language too.
      const keywords = parseKeywords(row.keywords, key(`ctas.${i}.keywords`), err, false);
      // A button that opens the contact form has no link to translate.
      const rawUrl = ctas[i]?.action === "lead" ? "" : str(row.url);
      const url = rawUrl ? safeLink(rawUrl) : undefined;
      if (rawUrl && !url) err(key(`ctas.${i}.url`), "Enter an https web page, or a tel: or mailto: link.");
      return { ...(label && { label }), ...(keywords.length && { keywords }), ...(url && { url }) };
    });
    if (localCtas.some((c) => Object.keys(c).length)) copy.ctas = localCtas;
    const localContacts = list(t.handoffContacts)
      .slice(0, contacts.length)
      .map((row, i) => {
        if (!isObject(row)) return {};
        const [rawUrl, label] = [str(row.url), str(row.label)];
        const url = rawUrl ? safeLink(rawUrl) : undefined;
        if (rawUrl && !url) err(key(`handoffContacts.${i}.url`), "Enter an https web page, a tel: number or a mailto: address.");
        if (label.length > LIMITS.label) err(key(`handoffContacts.${i}.label`), `Keep the label under ${LIMITS.label} characters.`);
        return { ...(url && { url }), ...(label && { label }) };
      });
    if (localContacts.some((c) => Object.keys(c).length)) copy.handoffContacts = localContacts;
    if (Object.keys(copy).length) out[language] = copy;
  }
  return Object.keys(out).length ? out : undefined;
}
