// What the style sniffer returns for a site (POST {sniffer}/scan). The console stores it and
// the widget configurator proposes its theme, highlighting the values it is least sure of.
// Nothing here is applied to a widget until a person applies or confirms it. Also which of the
// scan's avatar options reads best at the chat's size (preferredAvatar).

import type { ThemeTokens } from "./tokens.ts";

export interface SitePlatform {
  platform: "sitefinity" | "wordpress" | "drupal" | "sitecore" | "unknown";
  version?: string;
  evidence: string[];
}

export interface SiteScan {
  url: string;
  // After redirects.
  finalUrl: string;
  status: number;
  platform: SitePlatform;
  sitemaps: string[];
  sitemapPages: number;
  sitemapTruncated: boolean;
  // Proposed and already contrast-repaired; tokens the scan found nothing for are defaults.
  theme: ThemeTokens;
  // 0–1 per token path, e.g. { "color.primary": 0.9 }. Paths missing here are defaults.
  confidence: Record<string, number>;
  // Where each value came from, e.g. { "color.primary": "button \"Shop now\" ×12" }.
  sources: Record<string, string>;
  warnings: string[];
  // The avatar the scan is confident of: the header's logo linking home. Missing when it isn't
  // sure; logoCandidates lists every option it found.
  logo?: string;
  icons: string[];
  // data:image/jpeg;base64,… of the page at 1366×900, with cookie walls and chat widgets hidden.
  screenshot: string;
  // A proposed chat name: the form the page title and the header logo's alt text use.
  siteName?: string;
  // The page's <html lang>, and the hreflang alternates it links to (lower case, no x-default).
  pageLanguage?: string;
  languages?: string[];
  // Web fonts the page loaded, so the console's preview can load them too where their host allows.
  fonts?: SiteFont[];
  // Avatar options, the confident one first. Never content images.
  logoCandidates?: LogoCandidate[];
  // Where the proposed name came from, and the other spellings the site uses.
  nameSources?: NameSource[];
  // The sources spell or name the site differently: a person should pick.
  nameCheck?: boolean;
  // The client's privacy notice, from a link in the page's footer.
  privacyUrl?: string;
  // The site's contact page, from a link in its header, navigation or footer: the handoff's
  // first suggestion.
  contactUrl?: string;
  // A fixed or sticky element along the bottom of the window (usually a cookie bar), measured
  // before the screenshot hid it. The chat button should sit above it.
  bottomBar?: BottomBar;
}

// A font stylesheet from a font service (Google Fonts, Adobe Fonts…), or an @font-face rule
// read from the site's own stylesheets.
export type SiteFont = { kind: "stylesheet"; url: string } | { kind: "face"; family: string; url: string; weight?: string; style?: string };

// Where an avatar option was found:
// - header-home: an image or inline SVG in the page header (or first navigation) linking home
// - apple-touch-icon, icon: the site's home-screen and browser-tab icons
// - og:image: the page's social-sharing image, often a banner rather than a logo
export type LogoSource = "header-home" | "apple-touch-icon" | "icon" | "og:image";

export interface LogoCandidate {
  // https, or a percent-encoded data:image/svg+xml URL for an inline SVG.
  url: string;
  source: LogoSource;
  // Its size on the page (header logos), or the icon's own size in pixels, as loaded or as
  // declared. Older scans give icons only their declared size.
  width?: number;
  height?: number;
  // The image's alt text, or the inline SVG's title.
  alt?: string;
  // Offered only for a person to check, never preselected (og:image).
  check?: boolean;
}

export type NameSourceKind = "title" | "logo-alt" | "og:site_name" | "domain" | "structured-data";

export interface NameSource {
  source: NameSourceKind;
  value: string;
}

export interface BottomBar {
  // CSS pixels from the bottom of the window to the bar's top edge.
  height: number;
  // What it is, as far as the page says: "OneTrust cookie banner", "#cookie-notice".
  label: string;
}

// The scan's suggestions beyond the theme, which the console stores with the scan.
export type SiteScanExtras = Pick<
  SiteScan,
  | "siteName"
  | "pageLanguage"
  | "languages"
  | "fonts"
  | "logoCandidates"
  | "nameSources"
  | "nameCheck"
  | "privacyUrl"
  | "contactUrl"
  | "bottomBar"
>;

// How an avatar option reads where the chat shows it: 28 px tall beside the chat's name, at most
// 96 px wide.
// - square: about as wide as tall (an icon, a round or square mark): the best fit
// - fits: up to twice as wide as tall, still legible
// - wide: a wordmark or lockup (or a tall stack), whose lettering ends up a few pixels tall
//   (whatsupgold.com's 232×26 header logo, telerik.com's 147×60)
// - small: an icon under 32 px, blurry when enlarged
// - unknown: no size known (older scans, or an icon that didn't load)
export type AvatarFit = "square" | "fits" | "wide" | "small" | "unknown";

export function avatarFit(c: Pick<LogoCandidate, "url" | "source" | "width" | "height">): AvatarFit {
  const { width: w, height: h } = c;
  if (!w || !h) return "unknown";
  const aspect = w / h;
  if (aspect > 2 || aspect < 0.5) return "wide";
  // Header logos are measured as shown on the page, and SVGs scale: only icon files can be small.
  const vector = /^data:image\/svg\+xml|\.svg(\?|#|$)/i.test(c.url);
  if (c.source !== "header-home" && !vector && Math.max(w, h) < 32) return "small";
  return aspect <= 1.6 ? "square" : "fits";
}

// How much each kind of option is worth as the avatar. The site's own header logo, when it
// reads at chat size; then its home-screen icon and its larger browser-tab icons; then an icon
// of unknown size; a wide logo only when nothing else is there. og:image is never chosen.
function avatarRank(c: LogoCandidate): number {
  if (c.check || c.source === "og:image") return -1;
  const fit = avatarFit(c);
  if (c.source === "header-home") return fit === "square" ? 5 : fit === "fits" ? 4 : fit === "unknown" ? 2 : 0;
  if (fit === "small" || fit === "wide") return -1;
  if (c.source === "apple-touch-icon") return 3;
  return fit === "unknown" ? 1 : 3;
}

// The avatar to preselect from a scan's options, if any, and whether a person should look at
// it first: a wide logo (nothing better was found) or an icon of unknown size. Ties go to the
// option listed first.
export function preferredAvatar(candidates: readonly LogoCandidate[]): { candidate: LogoCandidate; check: boolean } | undefined {
  let best: LogoCandidate | undefined;
  for (const c of candidates) if (avatarRank(c) >= 0 && (!best || avatarRank(c) > avatarRank(best))) best = c;
  if (!best) return undefined;
  const fit = avatarFit(best);
  return { candidate: best, check: fit === "wide" || fit === "unknown" };
}
