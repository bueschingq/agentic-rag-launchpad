// Runs inside the scanned page (page.evaluate serialises the function), so it must be
// self-contained: no imports or outer variables. It only reads computed styles.

export interface RawButton {
  text: string;
  background: string;
  color: string;
  borderRadius: string;
  fontWeight: string;
  boxShadow: string;
  width: number;
  height: number;
  // How many visible buttons share this exact look.
  count: number;
}

export interface RawStyles {
  rootVars: Record<string, string>;
  body: { color: string; background: string; fontFamily: string; fontSize: string; lineHeight: string };
  heading?: { fontFamily: string; color: string };
  linkColor?: string;
  buttons: RawButton[];
  input?: { borderColor: string; borderRadius: string };
  header?: { background: string; color: string };
  loadedFonts: string[];
  logo?: string;
  icons: string[];
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

  // Button-like elements with a filled background, grouped by look.
  const groups = new Map<string, RawButton>();
  const candidates = document.querySelectorAll(
    'button, .btn, [class*="button" i], [role="button"], input[type="submit"], input[type="button"], a[class*="cta" i]',
  );
  for (const el of Array.from(candidates)) {
    if (!visible(el)) continue;
    const s = getComputedStyle(el);
    if (transparent(s.backgroundColor)) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 40 || r.height < 24 || r.height > 120) continue;
    const key = `${s.backgroundColor}|${s.color}|${s.borderRadius}`;
    const existing = groups.get(key);
    if (existing) existing.count += 1;
    else
      groups.set(key, {
        text: (el.textContent ?? (el as HTMLInputElement).value ?? "").trim().slice(0, 40),
        background: s.backgroundColor,
        color: s.color,
        borderRadius: s.borderRadius,
        fontWeight: s.fontWeight,
        boxShadow: s.boxShadow,
        width: Math.round(r.width),
        height: Math.round(r.height),
        count: 1,
      });
  }

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

  const logoEl = first('header img[src*="logo" i], img[alt*="logo" i], [class*="logo" i] img') as HTMLImageElement | undefined;
  const icons = Array.from(document.querySelectorAll('link[rel~="icon"], link[rel="apple-touch-icon"]')).map(
    (l) => (l as HTMLLinkElement).href,
  );

  return {
    rootVars,
    body,
    ...(heading && { heading }),
    ...(linkColor && { linkColor }),
    buttons: [...groups.values()].sort((a, b) => b.count - a.count).slice(0, 20),
    ...(input && { input }),
    ...(header && { header }),
    loadedFonts,
    ...(logoEl?.src && { logo: logoEl.src }),
    icons,
  };
}
