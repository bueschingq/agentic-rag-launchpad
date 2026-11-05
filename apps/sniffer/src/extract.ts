// Runs inside the scanned page (page.evaluate serialises each function), so every function
// here must be self-contained: no imports or outer variables. They only read the page, except
// hideOverlays, which hides cookie walls and chat widgets just before the screenshot, and
// measureIcons, which loads the site's icons as images to learn their size.

export interface RawButton {
  text: string;
  background: string;
  // Gradients and sheens live here, not in background (which is often transparent then).
  backgroundImage: string;
  color: string;
  borderRadius: string;
  fontWeight: string;
  boxShadow: string;
  width: number;
  height: number;
  // How many visible buttons share this exact look.
  count: number;
  // The largest of them, in square pixels, and whether any shows without scrolling.
  area?: number;
  aboveFold?: boolean;
  // The page's first big button outside its header and navigation: the hero's call to action.
  hero?: boolean;
}

// What the page says about the site itself, for a proposed chat name.
export interface RawSite {
  title: string;
  ogSiteName?: string;
  applicationName?: string;
  // Organization and WebSite names from JSON-LD, in page order.
  jsonLdNames: string[];
  jsonLdLogo?: string;
  // The header logo's alt text (or its inline SVG's title, or its link's label).
  logoAlt?: string;
  ogImage?: string;
}

// An image or inline SVG inside a link to the home page, in the page's header, banner or
// first navigation. Inline SVGs come as percent-encoded data:image/svg+xml URLs, colors inlined.
export interface RawLogo {
  url: string;
  width: number;
  height: number;
  alt?: string;
}

export interface RawIcon {
  url: string;
  rel: "apple-touch-icon" | "icon";
  // The largest size the link declares, in pixels.
  size?: number;
  // Its own size as loaded (measureIcons): favicon.ico rarely declares one.
  width?: number;
  height?: number;
}

// A font service's stylesheet, or an @font-face rule from the site's own CSS.
export type RawFont = { kind: "stylesheet"; url: string } | { kind: "face"; family: string; url: string; weight?: string; style?: string };

export interface RawStyles {
  rootVars: Record<string, string>;
  body: { color: string; background: string; fontFamily: string; fontSize: string; lineHeight: string };
  heading?: { fontFamily: string; color: string };
  linkColor?: string;
  buttons: RawButton[];
  input?: { borderColor: string; borderRadius: string };
  header?: { background: string; color: string };
  loadedFonts: string[];
  // The header logo linking home, when there is one; the avatar the scan is sure of.
  logo?: string;
  icons: string[];
  // Optional: scans saved before these existed lack them.
  site?: RawSite;
  // <html lang>, and the hreflang alternates the page links to.
  lang?: string;
  hreflang?: string[];
  fonts?: RawFont[];
  // Every header logo linking home, in page order, and the icons with their declared sizes.
  logos?: RawLogo[];
  iconLinks?: RawIcon[];
  // The privacy notice linked from the footer, and the link's text.
  privacy?: { url: string; text: string };
  // The contact page linked from the header, navigation or footer, and the link's text.
  contact?: { url: string; text: string };
  // A fixed or sticky bar along the bottom of the window, before overlays are hidden.
  bottomBar?: { height: number; label: string };
}

export function extractStyles(): RawStyles {
  const visible = (el: Element) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none" && Number(s.opacity) > 0.1;
  };
  const transparent = (c: string) => c === "transparent" || /rgba\([^)]*,\s*0\)$/.test(c);
  const first = (selector: string) => Array.from(document.querySelectorAll(selector)).find(visible);

  // Custom properties declared on :root / html / body in same-origin stylesheets.
  const rootVars: Record<string, string> = {};
  const rootStyle = getComputedStyle(document.documentElement);
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      continue; // cross-origin stylesheet
    }
    for (const rule of Array.from(rules)) {
      if (!(rule instanceof CSSStyleRule) || !/(^|,)\s*(:root|html|body)\s*(,|$)/.test(rule.selectorText)) continue;
      for (const name of Array.from(rule.style)) {
        if (name.startsWith("--") && Object.keys(rootVars).length < 300) rootVars[name] = rootStyle.getPropertyValue(name).trim();
      }
    }
  }

  const bodyStyle = getComputedStyle(document.body);
  const htmlBg = rootStyle.backgroundColor;
  const body = {
    color: bodyStyle.color,
    background: transparent(bodyStyle.backgroundColor) ? (transparent(htmlBg) ? "rgb(255, 255, 255)" : htmlBg) : bodyStyle.backgroundColor,
    fontFamily: bodyStyle.fontFamily,
    fontSize: bodyStyle.fontSize,
    lineHeight: bodyStyle.lineHeight,
  };

  const h = first("h1") ?? first("h2");
  const heading = h ? { fontFamily: getComputedStyle(h).fontFamily, color: getComputedStyle(h).color } : undefined;

  // Most common color among visible links in the page body (navigation often differs).
  const linkColors = new Map<string, number>();
  for (const a of Array.from(document.querySelectorAll("main a[href], article a[href], p a[href]")).filter(visible).slice(0, 80)) {
    const c = getComputedStyle(a).color;
    linkColors.set(c, (linkColors.get(c) ?? 0) + 1);
  }
  const linkColor = [...linkColors].sort((x, y) => y[1] - x[1])[0]?.[0];

  // Not the site's own buttons: consent banners, third-party chat widgets, and controls of
  // carousels and media players (progress.com's primary once came from a "pause" button).
  const NOT_THE_SITE =
    '#onetrust-consent-sdk, #onetrust-banner-sdk, #CybotCookiebotDialog, #usercentrics-root, #didomi-host, .qc-cmp2-container, #truste-consent-track, .truste_box_overlay, .osano-cm-window, .cky-consent-container, #cmplz-cookiebanner-container, #iubenda-cs-banner, .cc-window, [id*="cookie" i], [class*="cookie" i], [id*="consent" i], [class*="consent" i], [aria-label*="cookie" i], [aria-label*="consent" i], #intercom-container, .intercom-lightweight-app, #hubspot-messages-iframe-container, #drift-widget-container, .crisp-client, #launcher, [class*="carousel" i] [class*="control" i]';
  const CONTROL_WORDS =
    /\b(play|pause|stop|mute|unmute|volume|next|prev|previous|slide \d+|go to slide|carousel|fullscreen|close|dismiss|scroll to top|back to top)\b/i;
  const CONTROL_CLASS =
    /(slick|swiper|carousel|slider|owl|glide|splide|flickity|video|player)[-_]*(arrow|prev|next|dot|button|pagination|nav|control|play|pause)/i;
  const CONSENT_TEXT =
    /^(accept|accept all|accept cookies|allow all|allow cookies|agree|i agree|reject|reject all|decline|deny|cookie settings|manage cookies|got it|ok)$/i;
  const isSiteButton = (el: Element, text: string) => {
    const label = `${el.getAttribute("aria-label") ?? ""} ${el.getAttribute("title") ?? ""} ${text}`.trim();
    return (
      !el.closest(NOT_THE_SITE) &&
      !CONTROL_WORDS.test(label) &&
      !CONTROL_CLASS.test(typeof el.className === "string" ? el.className : "") &&
      !CONSENT_TEXT.test(text)
    );
  };

  // Button-like elements with a filled or gradient background, grouped by look. Class names
  // are matched in any case ("Btn", "button"), and plain links count when padded like buttons.
  const groups = new Map<string, RawButton>();
  let hero: { key: string; top: number; left: number } | undefined;
  const candidates = document.querySelectorAll(
    'button, [class*="btn" i], [class*="button" i], [role="button"], input[type="submit"], input[type="button"], a[class*="cta" i], a[href]',
  );
  for (const el of Array.from(candidates)) {
    if (!visible(el)) continue;
    if (el.matches("a[href]") && !el.matches('[class*="btn" i], [class*="button" i], [class*="cta" i], [role="button"]')) {
      const padded = Number.parseFloat(getComputedStyle(el).paddingLeft) >= 8;
      if (!padded || (el.textContent ?? "").trim().length > 40) continue;
    }
    const text = (el.textContent ?? (el as HTMLInputElement).value ?? "").replace(/\s+/g, " ").trim().slice(0, 40);
    if (!isSiteButton(el, text)) continue;
    const s = getComputedStyle(el);
    const image = s.backgroundImage.includes("gradient(") ? s.backgroundImage.slice(0, 400) : "none";
    if (transparent(s.backgroundColor) && image === "none") continue;
    const r = el.getBoundingClientRect();
    if (r.width < 40 || r.height < 24 || r.height > 120) continue;
    const area = Math.round(r.width * r.height);
    const aboveFold = r.top < innerHeight && r.bottom > 0;
    const key = `${s.backgroundColor}|${image}|${s.color}|${s.borderRadius}`;
    const inChrome = el.closest('header, nav, [role="banner"], [role="navigation"]') !== null;
    if (
      !inChrome &&
      aboveFold &&
      area >= 6000 &&
      (!hero || r.top < hero.top - 4 || (Math.abs(r.top - hero.top) <= 4 && r.left < hero.left))
    ) {
      hero = { key, top: r.top, left: r.left };
    }
    const existing = groups.get(key);
    if (existing) {
      existing.count += 1;
      existing.area = Math.max(existing.area ?? 0, area);
      existing.aboveFold ||= aboveFold;
      if (!existing.text && text) existing.text = text;
    } else
      groups.set(key, {
        text,
        background: s.backgroundColor,
        backgroundImage: image,
        color: s.color,
        borderRadius: s.borderRadius,
        fontWeight: s.fontWeight,
        boxShadow: s.boxShadow,
        width: Math.round(r.width),
        height: Math.round(r.height),
        count: 1,
        area,
        aboveFold,
      });
  }

  const heroGroup = hero && groups.get(hero.key);
  if (heroGroup) heroGroup.hero = true;

  const inputEl = first('input[type="text"], input[type="search"], input[type="email"], input:not([type]), textarea');
  const input = inputEl
    ? { borderColor: getComputedStyle(inputEl).borderTopColor, borderRadius: getComputedStyle(inputEl).borderRadius }
    : undefined;

  const headerEl = first('header, [role="banner"]');
  const header = headerEl ? { background: getComputedStyle(headerEl).backgroundColor, color: getComputedStyle(headerEl).color } : undefined;

  const loadedFonts = [
    ...new Set(
      Array.from(document.fonts)
        .filter((f) => f.status === "loaded")
        .map((f) => f.family.replace(/["']/g, "")),
    ),
  ];

  // The site's name and logo, as it describes itself.
  const meta = (selector: string) => document.querySelector<HTMLMetaElement>(selector)?.content?.trim() || undefined;
  const jsonLdNames: string[] = [];
  let jsonLdLogo: string | undefined;
  const visit = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    const o = node as Record<string, unknown>;
    const types = ([] as unknown[]).concat(o["@type"] ?? []).map(String);
    if (types.some((t) => /^(Organization|Corporation|WebSite|Brand|LocalBusiness|EducationalOrganization)$/.test(t))) {
      if (typeof o.name === "string") jsonLdNames.push(o.name.trim());
      const logo = typeof o.logo === "string" ? o.logo : (o.logo as { url?: unknown } | undefined)?.url;
      if (!jsonLdLogo && typeof logo === "string") jsonLdLogo = logo;
    }
    if (o["@graph"]) visit(o["@graph"]);
  };
  for (const script of Array.from(document.querySelectorAll('script[type="application/ld+json"]')).slice(0, 10)) {
    try {
      visit(JSON.parse(script.textContent ?? ""));
    } catch {
      // Malformed structured data is common; skip it.
    }
  }

  // The site's own logo: an image or inline SVG inside a link to the home page, in the page's
  // header, banner or first navigation. Logos anywhere else are usually its customers' or its
  // authors' (progress.com once offered USA Swimming's), so none is better than those.
  const absolute = (url: string | undefined) => {
    try {
      return url ? new URL(url, location.href).href : undefined;
    } catch {
      return undefined;
    }
  };
  const bare = (host: string) => host.toLowerCase().replace(/^www\./, "");
  const here = bare(location.hostname);
  const linksHome = (a: HTMLAnchorElement) => {
    try {
      const u = new URL(a.href, location.href);
      const host = bare(u.hostname);
      const sameSite = host === here || host.endsWith(`.${here}`) || here.endsWith(`.${host}`);
      // "/", a language's home ("/en", "/de-de/") or an index page.
      return sameSite && /^\/(?:[a-z]{2}(?:[-_][a-z]{2,4})?\/?)?(?:(?:index|default|home)(?:\.\w+)?\/?)?$/i.test(u.pathname);
    } catch {
      return false;
    }
  };
  const OUTSIDE_CHROME = 'main, [role="main"], article, aside, footer, [role="contentinfo"]';
  // The header and banner, and the navigation at the top of the page (sites often keep a
  // hidden or skip-link nav earlier in the document).
  const scopes = [
    ...Array.from(document.querySelectorAll('header, [role="banner"], [id*="header" i], [class*="header" i], [id*="masthead" i]')),
    ...Array.from(document.querySelectorAll('nav, [role="navigation"]')).filter(
      (n) => visible(n) && n.getBoundingClientRect().top + scrollY < 200,
    ),
  ].filter((s) => !s.closest(OUTSIDE_CHROME) && !s.closest(NOT_THE_SITE));
  const inScope = (el: Element) => scopes.some((s) => s.contains(el));

  // Inline SVGs travel as data: URLs. The page's CSS doesn't come along, so each shape's
  // computed paint goes in as attributes, and symbols it <use>s from a sprite are copied in.
  const svgUrl = (svg: SVGSVGElement): string | undefined => {
    const clone = svg.cloneNode(true) as SVGSVGElement;
    const from = [svg, ...Array.from(svg.querySelectorAll("*"))];
    const to = [clone, ...Array.from(clone.querySelectorAll("*"))];
    from.forEach((node, i) => {
      const s = getComputedStyle(node);
      const target = to[i];
      if (!target) return;
      if (/^(path|circle|rect|polygon|polyline|ellipse|line|text|tspan|use|g|svg)$/i.test(node.tagName)) {
        target.setAttribute("fill", s.fill);
        if (s.stroke !== "none") target.setAttribute("stroke", s.stroke);
      }
      if (s.display === "none") target.setAttribute("display", "none");
    });
    const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
    for (const use of Array.from(clone.querySelectorAll("use"))) {
      const ref = use.getAttribute("href") ?? use.getAttribute("xlink:href") ?? "";
      const symbol = ref.startsWith("#") ? document.getElementById(ref.slice(1)) : null;
      if (symbol && !clone.querySelector(`[id="${CSS.escape(ref.slice(1))}"]`)) defs.append(symbol.cloneNode(true));
    }
    if (defs.childNodes.length) clone.prepend(defs);
    // Nothing that runs or loads: an <img> wouldn't run it, but there's no need to carry it.
    for (const node of Array.from(clone.querySelectorAll("script, foreignObject, image"))) node.remove();
    for (const node of [clone, ...Array.from(clone.querySelectorAll("*"))]) {
      for (const attr of Array.from(node.attributes)) if (/^on/i.test(attr.name)) node.removeAttribute(attr.name);
    }
    const r = svg.getBoundingClientRect();
    clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    if (!clone.getAttribute("viewBox") && !clone.getAttribute("width")) clone.setAttribute("viewBox", `0 0 ${r.width} ${r.height}`);
    clone.setAttribute("width", String(Math.round(r.width)));
    clone.setAttribute("height", String(Math.round(r.height)));
    clone.removeAttribute("class");
    clone.removeAttribute("style");
    // Two decimals are plenty at avatar size, and halve a detailed wordmark.
    const markup = new XMLSerializer()
      .serializeToString(clone)
      .replace(/(\d+\.\d\d)\d+/g, "$1")
      .replace(/>\s+</g, "><");
    if (markup.length > 16_000) return undefined; // too big to carry in every page's config
    // Percent-encoded rather than base64: the config is served gzipped, and text compresses.
    return `data:image/svg+xml,${encodeURIComponent(markup)}`;
  };

  const logos: RawLogo[] = [];
  for (const a of Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href]"))) {
    if (!inScope(a) || !linksHome(a)) continue;
    const graphic = Array.from(a.querySelectorAll<HTMLImageElement | SVGSVGElement>("img, svg")).find(
      (g) => visible(g) && !(g instanceof SVGSVGElement && g.parentElement?.closest("svg")),
    );
    if (!graphic) continue;
    const r = graphic.getBoundingClientRect();
    if (r.top + scrollY > 300 || r.width < 16 || r.height < 10) continue;
    const label = (a.getAttribute("aria-label") ?? a.title ?? "").trim();
    let url: string | undefined;
    let alt: string | undefined;
    if (graphic instanceof HTMLImageElement) {
      const src = graphic.currentSrc || graphic.src;
      url = /^https:/.test(src) || /^data:image\/(png|svg\+xml|jpeg|webp|gif)[;,]/.test(src) ? src : undefined;
      if (url?.startsWith("data:") && url.length > 14_000) url = undefined;
      alt = graphic.alt?.trim() || label;
    } else {
      url = svgUrl(graphic);
      alt = (graphic.querySelector("title")?.textContent ?? graphic.getAttribute("aria-label") ?? "").trim() || label;
    }
    if (!url || logos.some((l) => l.url === url)) continue;
    logos.push({ url, width: Math.round(r.width), height: Math.round(r.height), ...(alt && { alt: alt.slice(0, 120) }) });
    if (logos.length === 3) break;
  }

  const iconLinks: RawIcon[] = Array.from(
    document.querySelectorAll<HTMLLinkElement>('link[rel~="icon"], link[rel="apple-touch-icon"], link[rel="apple-touch-icon-precomposed"]'),
  )
    .filter((l) => /^https:/.test(l.href))
    .map((l) => {
      const sizes = (l.getAttribute("sizes") ?? "").match(/\d+/g)?.map(Number) ?? [];
      return {
        url: l.href,
        rel: /apple/i.test(l.rel) ? ("apple-touch-icon" as const) : ("icon" as const),
        ...(sizes.length && { size: Math.max(...sizes) }),
      };
    })
    .slice(0, 8);
  const icons = iconLinks.map((l) => l.url);
  const logo = logos[0]?.url;
  const ogImage = absolute(meta('meta[property="og:image"]') ?? meta('meta[name="og:image"]'));
  const site: RawSite = {
    title: document.title.trim().slice(0, 200),
    ogSiteName: meta('meta[property="og:site_name"]'),
    applicationName: meta('meta[name="application-name"]'),
    jsonLdNames: jsonLdNames.slice(0, 5),
    jsonLdLogo: absolute(jsonLdLogo),
    logoAlt: logos[0]?.alt,
    ...(ogImage?.startsWith("https:") && { ogImage }),
  };

  // The privacy notice, from the footer: the link whose text (or address) says privacy, in
  // the languages the widget speaks and a few more. A cookie policy is second best.
  const PRIVACY =
    /privacy|datenschutz|privacidad|privacidade|confidentialit|données personnelles|donnees-personnelles|vie privée|privatsph|riservatezza|privacybeleid|privacyverklaring|integritet|personvern|privatliv|prywatno|osobních údajů|adatvédel|gizlilik|конфиденциальн|個人情報|プライバシー|개인정보|隐私|隱私/i;
  const footers = Array.from(document.querySelectorAll('footer, [role="contentinfo"], [id*="footer" i], [class*="footer" i]')).filter(
    (f) => !f.closest("article"),
  );
  let privacy: { url: string; text: string; score: number } | undefined;
  for (const a of Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href]"))) {
    const text = (a.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
    let path = "";
    try {
      path = decodeURIComponent(new URL(a.href).pathname);
    } catch {
      continue;
    }
    if (!/^https:/.test(a.href) || !(PRIVACY.test(text) || PRIVACY.test(path))) continue;
    const inFooter = footers.some((f) => f.contains(a));
    const score =
      (PRIVACY.test(text) ? 3 : 0) +
      (PRIVACY.test(path) ? 2 : 0) +
      (inFooter ? 3 : 0) +
      (/polic|notice|statement|erklärung|política|politique|informativa|verklaring|hinweis/i.test(text) ? 1 : 0) -
      (/cookie/i.test(text) ? 3 : 0);
    if (privacy && score <= privacy.score) continue;
    // Without its fragment and campaign tracking ("?hubs_content=…").
    const url = new URL(a.href);
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) if (/^(utm_|hubs_|_hs|gclid|fbclid)/i.test(key)) url.searchParams.delete(key);
    privacy = { url: url.href, text, score };
  }

  // The contact page, for the handoff to a person: a link in the header, navigation or footer
  // whose text (or address) says contact, in about 20 languages, to a page of the site itself.
  // Shorter addresses and plainer labels win: /contact over /contact/sales-form. A page in a
  // section of the site prefers the section's own, even linked from its content:
  // /sitefinity-cms/contact over the company-wide /company/contact in the footer.
  const CONTACT =
    /\bcontact|kontakt|contacto|contáctanos|contato|fale conosco|contatt|get in touch|reach us|nous joindre|neem contact|yhteys|ota yhteyttä|kapcsolat|iletişim|bize ulaşın|liên hệ|hubungi kami|контакт|связаться|επικοινων|צור קשר|اتصل بنا|お問い合わせ|問い合わせ|連絡先|문의|연락처|联系我们|聯絡我們|聯繫我們|ติดต่อ/i;
  const chrome = [
    ...scopes,
    ...footers,
    ...Array.from(document.querySelectorAll('nav, [role="navigation"]')).filter((n) => !n.closest("main, article")),
  ];
  const section = location.pathname.split("/").filter(Boolean)[0]?.toLowerCase();
  let contact: { url: string; text: string; score: number } | undefined;
  for (const a of Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href]"))) {
    const inSection = Boolean(section) && a.pathname.toLowerCase().startsWith(`/${section}/`) && bare(a.hostname) === here;
    if (!(inSection || chrome.some((c) => c.contains(a))) || a.closest(NOT_THE_SITE)) continue;
    const text = (a.textContent ?? a.getAttribute("aria-label") ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
    let url: URL;
    let path = "";
    try {
      url = new URL(a.href);
      path = decodeURIComponent(url.pathname);
    } catch {
      continue;
    }
    const host = bare(url.hostname);
    const onSite = host === here || host.endsWith(`.${here}`) || here.endsWith(`.${host}`);
    if (url.protocol !== "https:" || !onSite || !(CONTACT.test(text) || CONTACT.test(path))) continue;
    const depth = path.split("/").filter(Boolean).length;
    const score =
      (CONTACT.test(text) ? 3 : 0) +
      (CONTACT.test(path) ? 2 : 0) +
      (text.length <= 30 ? 1 : 0) +
      (inSection ? 2 : 0) -
      Math.max(0, depth - 2) -
      (/form|request|demo|quote|partner|press|media|career|job/i.test(`${text} ${path}`) ? 1 : 0);
    if (contact && (score < contact.score || (score === contact.score && url.pathname.length >= new URL(contact.url).pathname.length)))
      continue;
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) if (/^(utm_|hubs_|_hs|gclid|fbclid)/i.test(key)) url.searchParams.delete(key);
    contact = { url: url.href, text, score };
  }

  // A fixed or sticky bar along the bottom of the window (a cookie bar, a bottom menu), as it
  // is before hideOverlays removes it for the screenshot: the chat button should sit above it.
  let bottomBar: { height: number; label: string } | undefined;
  for (const el of Array.from(document.querySelectorAll("body *"))) {
    const s = getComputedStyle(el);
    if ((s.position !== "fixed" && s.position !== "sticky") || !visible(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.bottom < innerHeight - 4 || r.top >= innerHeight - 8 || r.width < innerWidth * 0.25) continue;
    const height = Math.round(innerHeight - r.top);
    if (height > innerHeight * 0.45 || (bottomBar && bottomBar.height >= height)) continue;
    const id = el.id ? `#${el.id}` : "";
    const cls = typeof el.className === "string" ? el.className.trim().split(/\s+/)[0] : "";
    const where = `${id} ${cls} ${el.closest("[id]")?.id ?? ""}`;
    const label = /onetrust/i.test(where)
      ? "OneTrust cookie banner"
      : /cybot|cookiebot/i.test(where)
        ? "Cookiebot cookie banner"
        : /usercentrics/i.test(where)
          ? "Usercentrics cookie banner"
          : /cookie|consent|gdpr/i.test(`${where} ${(el.textContent ?? "").slice(0, 400)}`)
            ? "Cookie bar"
            : id || (cls ? `.${cls}` : el.tagName.toLowerCase());
    bottomBar = { height, label };
  }

  const hreflang = [
    ...new Set(
      Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel="alternate"][hreflang]'))
        .map((l) => l.hreflang.trim().toLowerCase())
        .filter((tag) => tag && tag !== "x-default"),
    ),
  ].slice(0, 50);

  // Web fonts the page's own text uses: font services' stylesheets, and @font-face rules for
  // the body and heading families, so the console's preview can try to load them too.
  const familyOf = (stack: string) => stack.split(",")[0]?.trim().replace(/["']/g, "").toLowerCase() ?? "";
  const wanted = new Set([familyOf(body.fontFamily), ...(heading ? [familyOf(heading.fontFamily)] : [])]);
  const FONT_SERVICES = /^(fonts\.googleapis\.com|use\.typekit\.net|fonts\.bunny\.net|fast\.fonts\.net|cloud\.typography\.com)$/;
  const fonts: RawFont[] = [];
  const readFaces = (sheet: CSSStyleSheet, depth: number) => {
    if (sheet.href && FONT_SERVICES.test(new URL(sheet.href).hostname)) fonts.push({ kind: "stylesheet", url: sheet.href });
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      return; // cross-origin
    }
    for (const rule of Array.from(rules)) {
      if (rule instanceof CSSImportRule && rule.styleSheet && depth < 2) readFaces(rule.styleSheet, depth + 1);
      if (!(rule instanceof CSSFontFaceRule)) continue;
      const family = rule.style.getPropertyValue("font-family").replace(/["']/g, "").trim();
      if (!wanted.has(family.toLowerCase())) continue;
      const urls = [...rule.style.getPropertyValue("src").matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)]
        .map((m) => absolute(new URL(m[1]!, sheet.href ?? location.href).href))
        .filter((u): u is string => Boolean(u?.startsWith("https:")));
      const url = urls.find((u) => /\.woff2(\?|#|$)/i.test(u)) ?? urls[0];
      if (!url) continue;
      const weight = rule.style.getPropertyValue("font-weight").trim() || undefined;
      const style = rule.style.getPropertyValue("font-style").trim() || undefined;
      fonts.push({ kind: "face", family, url, ...(weight && { weight }), ...(style && { style }) });
    }
  };
  for (const sheet of Array.from(document.styleSheets)) readFaces(sheet, 0);

  return {
    rootVars,
    body,
    ...(heading && { heading }),
    ...(linkColor && { linkColor }),
    buttons: [...groups.values()].sort((a, b) => b.count - a.count).slice(0, 20),
    ...(input && { input }),
    ...(header && { header }),
    loadedFonts,
    ...(logo && { logo }),
    icons,
    site,
    ...(document.documentElement.lang && { lang: document.documentElement.lang.trim().toLowerCase() }),
    hreflang,
    fonts: fonts.slice(0, 16),
    logos,
    iconLinks,
    ...(privacy && { privacy: { url: privacy.url, text: privacy.text } }),
    ...(contact && { contact: { url: contact.url, text: contact.text } }),
    ...(bottomBar && { bottomBar }),
  };
}

// The icons' own sizes, loaded as images in the page (a few seconds at most): a 16 px favicon is
// too blurry for the chat's avatar, a 180 px home-screen icon isn't. A page that links no icon
// gets the site's /favicon.ico, which browsers ask for anyway, when it loads.
export async function measureIcons(icons: RawIcon[]): Promise<RawIcon[]> {
  // The scanner's browser never loads an address ending in favicon.ico (Playwright's Chromium
  // drops them); the same file asked for with a query string loads.
  const loadable = (url: string) => (/favicon\.ico$/i.test(url) ? `${url}?size` : url);
  const size = (url: string) =>
    new Promise<{ width: number; height: number } | undefined>((resolve) => {
      const img = new Image();
      const timer = setTimeout(() => resolve(undefined), 3000);
      img.onload = () => {
        clearTimeout(timer);
        resolve(img.naturalWidth > 0 ? { width: img.naturalWidth, height: img.naturalHeight } : undefined);
      };
      img.onerror = () => {
        clearTimeout(timer);
        resolve(undefined);
      };
      img.src = loadable(url);
    });
  if (!icons.length) {
    if (location.protocol !== "https:") return [];
    const url = new URL("/favicon.ico", location.origin).href;
    const found = await size(url);
    return found ? [{ url, rel: "icon", ...found }] : [];
  }
  return Promise.all(icons.map(async (icon) => ({ ...icon, ...(await size(icon.url)) })));
}

// Before the screenshot: hides cookie walls, consent banners and third-party chat widgets, so
// the preview shows the site rather than a dimmed overlay. Through the CSSOM, which the site's
// Content Security Policy allows. Returns how many elements it hid.
export function hideOverlays(): number {
  const KNOWN =
    '#onetrust-consent-sdk, #onetrust-banner-sdk, .onetrust-pc-dark-filter, #CybotCookiebotDialog, #CybotCookiebotDialogBodyUnderlay, #usercentrics-root, #usercentrics-cmp-ui, #didomi-host, .qc-cmp2-container, #truste-consent-track, .truste_overlay, .truste_box_overlay, #consent_blackbar, .osano-cm-window, .cky-consent-container, .cky-overlay, #cmplz-cookiebanner-container, #iubenda-cs-banner, .cc-window, .cc-banner, #termly-code-snippet-support, #sp_message_container, [id^="sp_message_container"], .fc-consent-root, #intercom-container, .intercom-lightweight-app, #hubspot-messages-iframe-container, #drift-widget-container, #drift-frame-controller, #drift-frame-chat, .crisp-client, #fc_frame, #tidio-chat, #olark-wrapper, #chat-widget-container, .embeddedServiceHelpButton, .embeddedServiceSidebar, iframe[title*="chat" i], iframe[title*="messaging" i]';
  const ACTION = /\b(accept|agree|allow|reject|decline|deny|got it|ok|okay|akzeptieren|accepter|aceptar|accetta)\b/i;
  const CONSENT = /\b(cookies?|consent|gdpr|datenschutz|privacidad|confidentialité)\b/i;
  let hidden = 0;
  const hide = (el: Element) => {
    (el as HTMLElement).style?.setProperty("display", "none", "important");
    hidden += 1;
  };
  for (const el of Array.from(document.querySelectorAll(KNOWN))) hide(el);

  // Unknown consent platforms: fixed layers that cover much of the window, or fixed bars that
  // talk about cookies and offer to accept them.
  const viewport = innerWidth * innerHeight;
  for (const el of Array.from(document.querySelectorAll("body *"))) {
    const s = getComputedStyle(el);
    if (s.position !== "fixed" || s.display === "none" || s.visibility === "hidden") continue;
    const r = el.getBoundingClientRect();
    // Above the page (fixed backgrounds sit below it), and over most of the window.
    const covers = r.width * r.height >= 0.4 * viewport && r.top <= 10 && Number(s.zIndex) >= 10;
    const text = (el.textContent ?? "").slice(0, 3000);
    const banner =
      CONSENT.test(text) && Array.from(el.querySelectorAll("button, a, [role='button']")).some((b) => ACTION.test(b.textContent ?? ""));
    if (covers || banner) hide(el);
  }
  // Consent walls often lock scrolling; unlock it so nothing else stays dimmed or cut off.
  for (const el of [document.documentElement, document.body]) {
    if (getComputedStyle(el).overflow === "hidden") el.style.setProperty("overflow", "visible", "important");
  }
  return hidden;
}
