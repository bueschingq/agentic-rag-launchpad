// How far a fixed or sticky bar along the bottom of the window reaches up, under the floating
// chat button: OneTrust's and Cookiebot's banners, Sitefinity's own cookie notice, a site's
// bottom menu on phones. The chat button sits above it, so it never covers the bar's buttons.
//
// It looks only at the bottom edge, in the button's own columns (document.elementsFromPoint is
// cheap), and walks up from each element found there to the one that is fixed or sticky. Taller
// layers, over 45% of the window, are overlays rather than bars, and are left alone.

export function barHeight(host: Element, xs: number[], win: Window = window): number {
  const doc = win.document;
  const bottom = win.innerHeight;
  let top = bottom;
  const seen = new Set<Element>();
  for (const x of xs) {
    if (x < 0 || x >= win.innerWidth) continue;
    for (const hit of doc.elementsFromPoint(x, bottom - 2)) {
      for (let node: Element | null = hit; node && node !== doc.body && node !== doc.documentElement; node = node.parentElement) {
        if (node === host || seen.has(node)) break;
        seen.add(node);
        const { position } = win.getComputedStyle(node);
        if (position !== "fixed" && position !== "sticky") continue;
        const r = node.getBoundingClientRect();
        if (r.bottom >= bottom - 4 && r.top > bottom * 0.55 && r.height >= 8) top = Math.min(top, r.top);
        break;
      }
    }
  }
  return Math.max(0, Math.round(bottom - top));
}
