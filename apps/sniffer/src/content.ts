// Runs inside a rendered page (page.evaluate serialises the function), so it must be
// self-contained: no imports or outer variables. Returns the page's main content as Markdown
// for the Knowledge Box: headings, paragraphs, lists and tables, without the navigation,
// header, footer, cookie banners and hidden elements every page repeats.

// Bumped whenever extractContent reads pages differently: each synced page records the version
// that read it, and pages read by an older one are read again (apps/worker/src/jobs/content.ts).
// 1: the page's own published and modified dates, and its structured-data type.
// 2: a figure the page renders from spans (<data value="$9.99">) is read from its value.
// 3: a form's text is kept (its labels, headings and prices: buzzsprout.com's plan cards sit in a
//    <form>), only its controls dropped; a button's text inside a heading is kept (a plan card's
//    "select" button holding the plan's name: transistor.fm); a card wrapped in a link or span, or a
//    list item holding a heading, is read as its own blocks; a price's other billing cycle given only in data-yearly, data-monthly
//    or data-annual attributes is written out next to it ("$190 per year"); and a billing toggle
//    that reloads the page (a GET form's period=monthly button) is named in billingViews.
// 4: a toggle operated in the rendered page (pages.ts operateToggles): what its other settings show
//    is added to the text, and hidden elements are worked out afresh on each read of the page.
// Keep in step with SNIFFER_EXTRACTOR in the console's lib/content-plan.ts (its EXTRACTOR_VERSION
// also counts what the sync does to the text afterwards).
export const EXTRACTOR_VERSION = 5;

// Which blocks of a page's text to keep, in order: a block the page already said goes when it says
// nothing new, and stays when it belongs to the item it's under (5: imeche.org's "Manchester, 11
// November 2026" under two events, and "per year", "per node" or "monthly" under each plan, were kept
// only under the first, so the next item lost its date or unit).
// - A repeated heading, or a long line, goes, and so does the whole run of repeats around a repeated
//   heading (a carousel's cloned card, a tabbed copy of the same list).
// - A call to action goes wherever it is.
// - A short line with a figure, date or price word stays with its item.
// - Another short line stays when at most one other repeat sits beside it; three or more in a row
//   are a repeated block.
// Self-contained: it runs in the page, inside EXTRACT_SCRIPT.
export function dropRepeats(blocks: readonly string[]): string[] {
  const SHORT = 80;
  const CTA =
    /^(?:[-*] )?(?:learn more|read more|find out more|see more|show more|view (?:more|details|all)|more info(?:rmation)?|details|book now|buy now|shop now|register(?: now)?|sign up.*|get started|start (?:\d+-day )?(?:free )?trial|try (?:it )?(?:for )?free|contact (?:us|sales)|request a demo|get a (?:demo|quote)|download|apply now|mehr erfahren|weiterlesen|jetzt .{1,20}|ver más|leer más|en savoir plus|lire la suite|meer informatie|lees meer|saiba mais|scopri di più)[.!>→\s]*$/i;
  const SAYS =
    /\d|(?:^|[\s/])(?:per|pro|je|par|por|monthly|yearly|annually|annual|month|year|mo|yr|from|starting|billed|monatlich|jährlich|mensual|anual|mensuel|annuel|maandelijks|jaarlijks)(?=$|[\s.,:;)])/i;
  const seen = new Set<string>();
  const repeat = blocks.map((b) => {
    const key = b.toLowerCase();
    const was = seen.has(key);
    seen.add(key);
    return was;
  });
  const keep = blocks.map((_, i) => !repeat[i]);
  for (let i = 0; i < blocks.length; ) {
    if (!repeat[i]) {
      i += 1;
      continue;
    }
    let end = i;
    while (end + 1 < blocks.length && repeat[end + 1]) end += 1;
    const run = blocks.slice(i, end + 1);
    const words = run.filter((b) => !CTA.test(b));
    const cloned = run.some((b) => b.startsWith("#"));
    for (let j = i; j <= end; j += 1) {
      const b = blocks[j] as string;
      if (cloned || CTA.test(b) || b.length > SHORT || b.startsWith("#") || b.startsWith("|") || b.startsWith("\u0060")) continue;
      keep[j] = SAYS.test(b) || words.length <= 2;
    }
    i = end + 1;
  }
  return blocks.filter((_, i) => keep[i]);
}

export interface RawPage {
  title: string;
  ogTitle?: string;
  h1?: string;
  description?: string;
  lang?: string;
  canonical?: string;
  noindex: boolean;
  // Which element the content came from, e.g. "main" or "body".
  root: string;
  markdown: string;
  // Same-site links anywhere on the page (navigation included): how a site without a
  // sitemap is crawled.
  links: string[];
  // The content area's text, hidden text included (characters), against the extract's: an
  // extract under half of it lost text somewhere ("Text much shorter than the page").
  rootChars: number;
  textChars: number;
  // Share of the extract that is link text: mostly links means an overview or listing page.
  linkShare: number;
  // The page's own dates as it states them, structured data first (JSON-LD), then article meta
  // tags, then <time itemprop>: freshness rules go by these rather than the sitemap's lastmod.
  datePublished?: string;
  dateModified?: string;
  // The structured-data type of an article page ("BlogPosting", "NewsArticle"…).
  articleType?: string;
  // The modified (else published) date: what earlier versions sent.
  published?: string;
  // A billing toggle that reloads the page with another period (a GET form's button or radio:
  // name=period, value=monthly): the address of each other period's view, and the period the page
  // shows now. The sniffer loads them and adds their prices (pages.ts withBillingViews).
  billingViews?: { period: string; url: string }[];
  billingShown?: string;
}

export function extractContent(): RawPage {
  const meta = (selector: string) => document.querySelector<HTMLMetaElement>(selector)?.content?.trim() || undefined;
  const robots = (meta('meta[name="robots" i]') ?? "").toLowerCase();
  const links = [
    ...new Set(
      Array.from(document.querySelectorAll("a[href]"))
        // SVG links' href is an SVGAnimatedString, not a URL: HTML links only.
        .flatMap((a) => (a instanceof HTMLAnchorElement ? [a.href.split("#")[0]!] : []))
        .filter((href) => href.startsWith(location.origin)),
    ),
  ].slice(0, 300);

  // Hidden elements can only be told apart in the live page, so mark them before cloning. Folded
  // content is kept: accordions, tabs and "read more" panels hold the answers on FAQ and pricing
  // pages (Sitefinity's List widget folds each answer into a display:none .sf-list-content).
  // Overlays (dialogs, cookie banners, menus) are still dropped.
  const HIDDEN = "data-arag-hidden";
  const KEEP = "data-arag-folded";
  // A second read of the same page, after a toggle was operated: what was hidden may show now.
  for (const el of Array.from(document.querySelectorAll(`[${HIDDEN}], [${KEEP}]`))) {
    el.removeAttribute(HIDDEN);
    el.removeAttribute(KEEP);
  }
  const FOLDED =
    'details, .collapse, .collapsing, .accordion-collapse, .panel-collapse, .tab-pane, [role="tabpanel"], .sf-list-content, [data-sf-role="content"]';
  const OVERLAY = 'dialog, [role="dialog"], [role="alertdialog"], [aria-modal="true"], nav, [role="navigation"]';
  const controlled = new Set<Element>();
  for (const toggle of Array.from(document.querySelectorAll("[aria-controls]"))) {
    for (const id of (toggle.getAttribute("aria-controls") ?? "").split(/\s+/)) {
      const target = id ? document.getElementById(id) : null;
      if (target) controlled.add(target);
    }
  }
  const folded = (el: Element) => {
    if (el.closest(OVERLAY)) return false;
    for (let at: Element | null = el; at && at !== document.body; at = at.parentElement) {
      if (at.matches(FOLDED) || controlled.has(at)) return true;
    }
    return false;
  };
  for (const el of Array.from(document.body.querySelectorAll("*"))) {
    const s = getComputedStyle(el);
    const isFolded = folded(el);
    if ((s.display === "none" || s.visibility === "hidden") && !isFolded) el.setAttribute(HIDDEN, "");
    // A closed panel's hidden or aria-hidden attribute isn't boilerplate either.
    if (isFolded && (el.hasAttribute("hidden") || el.getAttribute("aria-hidden") === "true")) el.setAttribute(KEEP, "");
  }

  const textLength = (el: Element) => (el as HTMLElement).innerText?.trim().length ?? 0;
  // The page's content area: semantic landmarks first, then Sitefinity's content placeholders
  // (MVC layouts render them as sf_colsIn columns with ContentPlaceholder ids), then the body.
  const candidates = [
    "main",
    '[role="main"]',
    "article",
    '[id^="Contentplaceholder" i]',
    '[id*="ContentPlaceHolder" i]',
    "#content",
    "#main-content",
    ".main-content",
  ];
  const bodyLength = textLength(document.body) || 1;
  let root: Element = document.body;
  let rootName = "body";
  for (const selector of candidates) {
    const found = Array.from(document.querySelectorAll(selector)).filter((el) => !el.closest(`[${HIDDEN}]`));
    // Several Sitefinity placeholders can hold content; take the largest, if it holds most of the page.
    const best = found.sort((a, b) => textLength(b) - textLength(a))[0];
    if (best && textLength(best) > Math.max(200, bodyLength * 0.3)) {
      root = best;
      rootName = selector;
      break;
    }
  }

  const squash = (text: string | null) => (text ?? "").replace(/\s+/g, " ").trim();
  // What the extract is measured against: the content area without scripts and the structure
  // every page repeats, but with every hidden element still in.
  // A form whose text is content: a heading, a price, or a paragraph's worth of text besides its
  // controls (a pricing grid inside a plan-picker form). A search box or a newsletter sign-up
  // isn't. Its controls go either way.
  const CONTROLS = "input, select, textarea, button, option";
  const keptForm = (form: Element) => {
    const copy = form.cloneNode(true) as Element;
    for (const el of Array.from(copy.querySelectorAll(CONTROLS))) el.remove();
    const text = squash(copy.textContent);
    return Boolean(copy.querySelector("h1, h2, h3, h4, h5, h6")) || /[$€£¥]\s?\d|\d\s?[€$]/.test(text) || text.length >= 120;
  };
  // A kept form becomes a plain block, so its content is read like any other.
  const unwrapForms = (within: Element) => {
    for (const form of Array.from(within.querySelectorAll("form"))) {
      if (form.closest('[role="search"]') || !keptForm(form)) continue;
      const div = document.createElement("div");
      for (const attr of Array.from(form.attributes)) if (attr.name !== "role") div.setAttribute(attr.name, attr.value);
      while (form.firstChild) div.appendChild(form.firstChild);
      form.replaceWith(div);
    }
  };
  const measure = root.cloneNode(true) as Element;
  unwrapForms(measure);
  const STRUCTURE =
    'script, style, noscript, template, svg, nav, header, footer, aside, form, dialog, [role="navigation"], [role="banner"], [role="contentinfo"], [role="search"], [role="dialog"], [aria-modal="true"]';
  for (const el of Array.from(measure.querySelectorAll(STRUCTURE))) el.remove();
  const rootChars = squash(measure.textContent).length;

  // A billing toggle that reloads the page: a GET form's button or radio naming a period, whose
  // other values are other views of the same prices (buzzsprout.com: period=annual|monthly).
  const PERIOD = /^(monthly|month|annual|annually|yearly|year)$/i;
  const billingViews: { period: string; url: string }[] = [];
  let billingShown: string | undefined;
  const toggles = document.querySelectorAll<HTMLButtonElement | HTMLInputElement>("button[name][value], input[type=radio][name][value]");
  for (const control of Array.from(toggles)) {
    const value = control.value.trim();
    if (!PERIOD.test(value) || control.closest(`[${HIDDEN}]`)) continue;
    const form = control.form;
    if (!form || (form.getAttribute("method") ?? "get").toLowerCase() !== "get") continue;
    let action: URL;
    try {
      action = new URL(form.getAttribute("action") || location.href, location.href);
    } catch {
      continue;
    }
    if (action.origin !== location.origin) continue;
    // The period shown now: the form's hidden field of that name, the address's, or a checked radio.
    const name = CSS.escape(control.name);
    const current =
      form.querySelector<HTMLInputElement>(`input[type=hidden][name="${name}"]`)?.value ??
      new URL(location.href).searchParams.get(control.name) ??
      document.querySelector<HTMLInputElement>(`input[type=radio][name="${name}"]:checked`)?.value ??
      undefined;
    if (current && PERIOD.test(current)) billingShown = current.toLowerCase();
    if (current && current.toLowerCase() === value.toLowerCase()) continue;
    action.searchParams.set(control.name, value);
    action.hash = "";
    if (billingViews.length < 2 && !billingViews.some((v) => v.url === action.href)) {
      billingViews.push({ period: value.toLowerCase(), url: action.href });
    }
  }
  const views = billingViews.filter((v) => v.period !== billingShown && v.url !== location.href);

  const clone = root.cloneNode(true) as Element;
  unwrapForms(clone);
  // A button inside a heading is a card's "select this plan" control holding its name: its text
  // is the heading's (transistor.fm's <h2><button>Starter</button></h2>).
  for (const button of Array.from(clone.querySelectorAll("h1 button, h2 button, h3 button, h4 button, h5 button, h6 button"))) {
    button.replaceWith(document.createTextNode(button.textContent ?? ""));
  }
  // A price toggle's other billing cycle, kept only in attributes (data-monthly="19"
  // data-yearly="190", swapped in by a script): written out after the price's block, as that
  // block with the figure swapped and what followed the figure dropped ("$190 per year";
  // "Transcription (5 hrs per month) $50 per year").
  const TOGGLE_ATTR = /^data-(?:price-)?(monthly|month|yearly|year|annual|annually)(?:-price)?$/i;
  const BLOCKISH = "p, div, li, td, th, section, article, dd";
  const numberOf = (text: string) => /\d[\d.,]*/.exec(text)?.[0]?.replace(/,/g, "");
  const MARK = "data-arag-price";
  for (const el of Array.from(clone.querySelectorAll("*"))) {
    const shown = squash(el.textContent);
    const shownNumber = numberOf(shown);
    if (!shownNumber || shown.length > 24 || !/[$€£¥]|\b[A-Z]{3}\b/.test(shown)) continue;
    const others = Array.from(el.attributes).flatMap((attr) => {
      const m = TOGGLE_ATTR.exec(attr.name);
      const value = attr.value.trim();
      const n = numberOf(value);
      return m && n && Number(n) !== Number(shownNumber) ? [{ yearly: !/^month/i.test(m[1]!), value, n }] : [];
    });
    if (!others.length) continue;
    const block = el.parentElement?.closest(BLOCKISH);
    if (!block || !clone.contains(block)) continue;
    let after: Element = block;
    for (const other of others) {
      // A bare number takes the shown figure's currency; a yearly figure below the shown one is
      // the monthly price when billed yearly.
      const figure = /[$€£¥]|[A-Z]{3}/.test(other.value) ? other.value : shown.replace(/\d[\d.,]*/, other.value).replace(/\s*\/.*$/, "");
      const said = other.yearly
        ? Number(other.n) > Number(shownNumber)
          ? `${figure} per year`
          : `${figure} per month, billed yearly`
        : `${figure} per month, billed monthly`;
      el.setAttribute(MARK, "");
      const copy = block.cloneNode(true) as Element;
      el.removeAttribute(MARK);
      const twin = copy.querySelector(`[${MARK}]`);
      if (!twin) continue;
      twin.removeAttribute(MARK);
      for (let next = twin.nextSibling; next; next = twin.nextSibling) next.remove();
      for (let up: Element | null = twin.parentElement; up && up !== copy; up = up.parentElement) {
        for (let next = up.nextSibling; next; next = up.nextSibling) next.remove();
      }
      twin.textContent = said;
      copy.removeAttribute("id");
      for (const attr of Array.from(copy.querySelectorAll("[data-yearly], [data-monthly], [data-annual]"))) {
        for (const name of attr.getAttributeNames()) if (TOGGLE_ATTR.test(name)) attr.removeAttribute(name);
      }
      after.after(copy);
      after = copy;
    }
  }
  // A figure the page renders from spans its script fills or animates (teamwork.com's pricing
  // cards: a "&" placeholder, then <data value="$9.99"><span>9</span><span> .99</span></data>,
  // read mid-animation as "$ ."): its machine-readable value stands for it, and a placeholder
  // just before it goes when the value carries its own currency.
  for (const el of Array.from(clone.querySelectorAll("data[value]"))) {
    const value = (el.getAttribute("value") ?? "").trim();
    if (!/\d/.test(value)) continue;
    el.textContent = value;
    const before = el.previousElementSibling;
    if (before && /[$€£¥]|[A-Z]{3}/.test(value) && /^[\s&$€£¥]*$/.test(before.textContent ?? "")) before.remove();
  }
  for (const el of Array.from(clone.querySelectorAll(`[${KEEP}]`))) {
    el.removeAttribute("hidden");
    el.removeAttribute("aria-hidden");
  }
  const BOILERPLATE = [
    `[${HIDDEN}]`,
    "script, style, noscript, template, svg, canvas, iframe, object, video, audio",
    "nav, header, footer, aside, form, button, select, input, textarea, dialog",
    '[role="navigation"], [role="banner"], [role="contentinfo"], [role="search"], [role="dialog"], [role="alert"]',
    '[aria-hidden="true"], [hidden]',
  ];
  for (const el of Array.from(clone.querySelectorAll(BOILERPLATE.join(", ")))) el.remove();
  const NOISE =
    /(^|[\s_-])(cookie|consent|gdpr|onetrust|newsletter|breadcrumbs?|skip-?link|social|share|sharing|modal|popup|navbar|sidebar|site-?header|site-?footer)([\s_-]|$)/i;
  for (const el of Array.from(clone.querySelectorAll("[class], [id]"))) {
    if (NOISE.test(`${el.getAttribute("class") ?? ""} ${el.id}`)) el.remove();
  }
  const keptChars = squash(clone.textContent).length;
  const linkChars = Array.from(clone.querySelectorAll("a")).reduce((sum, a) => sum + squash(a.textContent).length, 0);

  const inline = (el: Element) => (el.textContent ?? "").replace(/\s+/g, " ").trim();
  const blocks: string[] = [];
  const BLOCK = new Set(["P", "DIV", "SECTION", "ARTICLE", "MAIN", "UL", "OL", "LI", "TABLE", "BLOCKQUOTE", "PRE", "DL", "FIGURE"]);
  const walk = (el: Element) => {
    const tag = el.tagName;
    if (/^H[1-6]$/.test(tag)) {
      const text = inline(el);
      if (text) blocks.push(`${"#".repeat(Number(tag[1]))} ${text}`);
      return;
    }
    // A list item holding a heading is a card (buzzsprout.com's plan cards are <li>s): read as blocks.
    if (tag === "LI" && !el.querySelector("h1, h2, h3, h4, h5, h6")) {
      const text = inline(el);
      if (text) blocks.push(`- ${text}`);
      return;
    }
    if (tag === "TABLE") {
      for (const row of Array.from(el.querySelectorAll("tr"))) {
        const cells = Array.from(row.children).map(inline).filter(Boolean);
        if (cells.length) blocks.push(`| ${cells.join(" | ")} |`);
      }
      return;
    }
    if (tag === "DT" || tag === "DD") {
      const text = inline(el);
      if (text) blocks.push(tag === "DT" ? `**${text}**` : text);
      return;
    }
    if (tag === "PRE") {
      const text = el.textContent?.trim();
      if (text) blocks.push(`\`\`\`\n${text}\n\`\`\``);
      return;
    }
    if (tag === "BLOCKQUOTE") {
      const text = inline(el);
      if (text) blocks.push(`> ${text}`);
      return;
    }
    // Text sitting directly in this element (not in a nested block) is a paragraph of its own.
    let run = "";
    const flush = () => {
      const text = run.replace(/\s+/g, " ").trim();
      if (text) blocks.push(text);
      run = "";
    };
    for (const child of Array.from(el.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) run += child.textContent ?? "";
      else if (child.nodeType === Node.ELEMENT_NODE) {
        const c = child as Element;
        if (BLOCK.has(c.tagName) || /^H[1-6]$/.test(c.tagName) || c.tagName === "DT" || c.tagName === "DD") {
          flush();
          walk(c);
        } else if (c.tagName === "BR") run += "\n";
        // A card wrapped in a link or span (alfredapp.com's <a><h2>Single License</h2><h3>£34</h3>…):
        // its headings and paragraphs are blocks of their own, not one run of text.
        else if (c.querySelector("h1, h2, h3, h4, h5, h6, p, li, table")) {
          flush();
          walk(c);
        } else run += ` ${c.textContent ?? ""} `;
      }
    }
    flush();
  };
  walk(clone);

  // Repeated lines (carousels, cards) say nothing new the second time, unless they're their item's.
  const markdown = dropRepeats(blocks).join("\n\n").slice(0, 100_000);

  // JSON-LD: the article if the page has one (Article, BlogPosting, NewsArticle and their kinds),
  // else the first thing with a date, looking inside @graph and arrays. An Event's dates are
  // when it happens, not when the page was written, so they're not read.
  const structured = (() => {
    const nodes: Record<string, unknown>[] = [];
    const collect = (value: unknown, depth: number) => {
      if (depth > 4 || !value || typeof value !== "object") return;
      if (Array.isArray(value)) {
        for (const item of value) collect(item, depth + 1);
        return;
      }
      const node = value as Record<string, unknown>;
      nodes.push(node);
      collect(node["@graph"], depth + 1);
      collect(node.mainEntity, depth + 1);
    };
    const loose: { published?: string; modified?: string } = {};
    for (const script of Array.from(document.querySelectorAll('script[type="application/ld+json" i]'))) {
      const text = script.textContent ?? "";
      try {
        collect(JSON.parse(text), 0);
      } catch {
        // Broken JSON (common): its dates can still be read.
        loose.published ??= /"datePublished"\s*:\s*"([^"]+)"/.exec(text)?.[1];
        loose.modified ??= /"dateModified"\s*:\s*"([^"]+)"/.exec(text)?.[1];
      }
    }
    const types = (node: Record<string, unknown>) => [node["@type"]].flat().filter((t): t is string => typeof t === "string");
    // The node's own date, else one nested in it: whatsupgold.com's posts close the publisher's
    // braces after the dates, so the article's dates sit inside its publisher.
    const date = (node: Record<string, unknown> | undefined, key: string, depth = 0): string | undefined => {
      if (!node || depth > 3) return undefined;
      if (typeof node[key] === "string" && node[key]) return node[key] as string;
      for (const value of Object.values(node)) {
        if (value && typeof value === "object" && !Array.isArray(value)) {
          const found = date(value as Record<string, unknown>, key, depth + 1);
          if (found) return found;
        }
      }
      return undefined;
    };
    const dated = nodes.filter((n) => date(n, "datePublished") || date(n, "dateModified"));
    const article = dated.find((n) => types(n).some((t) => /(Article|BlogPosting|Posting)$/.test(t)));
    const best = article ?? dated.find((n) => !types(n).some((t) => /Event$/.test(t)));
    return {
      published: date(best, "datePublished") ?? loose.published,
      modified: date(best, "dateModified") ?? loose.modified,
      articleType: article ? types(article).find((t) => /(Article|BlogPosting|Posting)$/.test(t)) : undefined,
    };
  })();
  const time = (prop: string) => {
    const el = document.querySelector<HTMLTimeElement>(`time[itemprop="${prop}"]`);
    return el?.getAttribute("datetime")?.trim() || el?.textContent?.trim() || undefined;
  };
  const datePublished =
    structured.published ??
    meta('meta[property="article:published_time"]') ??
    meta('meta[itemprop="datePublished"]') ??
    time("datePublished") ??
    meta('meta[name="dcterms.issued" i]') ??
    meta('meta[name="dcterms.created" i]') ??
    meta('meta[name="date" i]');
  const dateModified =
    structured.modified ??
    meta('meta[property="article:modified_time"]') ??
    meta('meta[property="og:updated_time"]') ??
    meta('meta[itemprop="dateModified"]') ??
    time("dateModified") ??
    meta('meta[name="dcterms.modified" i]') ??
    meta('meta[name="last-modified" i]');
  const published = dateModified ?? datePublished;

  return {
    title: document.title.trim(),
    ...(meta('meta[property="og:title"]') && { ogTitle: meta('meta[property="og:title"]') }),
    ...(document.querySelector("h1") && { h1: inline(document.querySelector("h1")!) }),
    ...(meta('meta[name="description" i]') && { description: meta('meta[name="description" i]') }),
    ...(document.documentElement.lang && { lang: document.documentElement.lang }),
    ...(document.querySelector<HTMLLinkElement>('link[rel="canonical"]')?.href && {
      canonical: document.querySelector<HTMLLinkElement>('link[rel="canonical"]')!.href,
    }),
    noindex: robots.includes("noindex"),
    root: rootName,
    markdown,
    links,
    rootChars,
    textChars: squash(markdown.replace(/^(#+|-|>) |\*\*|\||```/gm, " ")).length,
    linkShare: keptChars ? Math.round((linkChars / keptChars) * 100) / 100 : 0,
    ...(datePublished && { datePublished }),
    ...(dateModified && { dateModified }),
    ...(structured.articleType && { articleType: structured.articleType }),
    ...(published && { published }),
    ...(views.length && { billingViews: views }),
    ...(billingShown && { billingShown }),
  };
}

// The controls on a rendered page that may switch what its prices show: small groups of short-labelled
// siblings a person clicks (tabs, a Monthly/Yearly switch, radio buttons, even a clickable list), and
// lone switches. Not by their words: pages.ts clicks one and sees whether the page's figures change.
// What page.evaluate runs: extractContent with what it calls beside it (a function passed to evaluate
// loses the module around it).
export const EXTRACT_SCRIPT = `(() => { const dropRepeats = ${dropRepeats.toString()}; return (${extractContent.toString()})(); })()`;

// Runs in the page, like extractContent. Links to other pages, a form's submit buttons, menus and
// dialogs are never candidates. Each control is marked with data-arag-toggle="n" for the click.
export interface ToggleControl {
  id: number;
  label: string;
  // Its group's index; the first control that changes nothing ends the group.
  group: number;
  // The setting the page shows now (aria-selected, aria-checked, checked, is-active…).
  active: boolean;
}

export function toggleControls(): ToggleControl[] {
  const MARK = "data-arag-toggle";
  for (const el of Array.from(document.querySelectorAll(`[${MARK}]`))) el.removeAttribute(MARK);
  const CHROME =
    'nav, header, footer, dialog, [role="navigation"], [role="banner"], [role="contentinfo"], [role="dialog"], [aria-modal="true"]';
  const labelOf = (el: Element) => (el.textContent ?? el.getAttribute("aria-label") ?? "").replace(/\s+/g, " ").trim();
  const seen = (el: Element) => {
    const box = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return box.width > 0 && box.height > 0 && style.visibility !== "hidden" && style.display !== "none";
  };
  const semantic = (el: Element) =>
    el.matches('button, [role="tab"], [role="radio"], [role="switch"], [role="button"], input[type="radio"], input[type="checkbox"]');
  const clickable = (el: Element): boolean => {
    if (el.closest(CHROME) || !seen(el)) return false;
    // Anything inside a link to another page, or a form's submit button, leaves or sends.
    const link = el.closest("a[href]");
    const href = link?.getAttribute("href") ?? "";
    if (link && !href.startsWith("#") && !href.startsWith("javascript:")) return false;
    const button = el.closest("button");
    if (button?.form && button.type === "submit") return false;
    if (el instanceof HTMLInputElement && el.type !== "radio" && el.type !== "checkbox") return false;
    if ((el as HTMLButtonElement).disabled) return false;
    return semantic(el) || getComputedStyle(el).cursor === "pointer";
  };
  const short = (label: string) => label.length >= 1 && label.length <= 24 && /\p{L}/u.test(label);
  const activeOf = (el: Element) =>
    el.getAttribute("aria-selected") === "true" ||
    el.getAttribute("aria-checked") === "true" ||
    el.getAttribute("aria-pressed") === "true" ||
    (el as HTMLInputElement).checked === true ||
    /(?:^|[\s_-])(?:active|selected|current|checked|on)(?:$|[\s_-])/i.test(el.getAttribute("class") ?? "");
  const groups = new Map<Element, Element[]>();
  const SELECTOR = 'button, [role="tab"], [role="radio"], [role="switch"], [role="button"], input[type="radio"], label, li, a, div, span';
  for (const el of Array.from(document.body.querySelectorAll(SELECTOR))) {
    const parent = el.parentElement;
    if (!parent || !clickable(el)) continue;
    // A label's own input is the control; a wrapper around one clickable element isn't one more.
    if (el.querySelector("button, a, input, [role='tab'], [role='radio'], [role='switch']") && !el.matches("label")) continue;
    if (!short(labelOf(el) || (el.parentElement?.textContent ?? "").trim().slice(0, 24))) continue;
    groups.set(parent, [...(groups.get(parent) ?? []), el]);
  }
  const controls: ToggleControl[] = [];
  const found: { el: Element; label: string; active: boolean; named: boolean }[][] = [];
  let group = 0;
  for (const members of groups.values()) {
    const lone = members.length === 1 && members[0]!.matches('[role="switch"], input[type="checkbox"]');
    if (!lone && (members.length < 2 || members.length > 5)) continue;
    // A group's members look alike (the same tag), and say different things.
    if (new Set(members.map((m) => m.tagName)).size > 1) continue;
    const labels = members.map((el) => labelOf(el) || (el.parentElement?.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 24));
    if (!lone && new Set(labels).size < members.length) continue;
    found.push(members.map((el, i) => ({ el, label: labels[i]!, active: activeOf(el), named: semantic(el) })));
  }
  // A group that says which setting is on comes first, then one that's built as controls.
  const rank = (g: (typeof found)[number]) => (g.some((m) => m.active) ? 0 : g.some((m) => m.named) ? 1 : 2);
  for (const members of [...found].sort((a, b) => rank(a) - rank(b))) {
    for (const m of members) {
      const id = controls.length;
      m.el.setAttribute(MARK, String(id));
      controls.push({ id, label: m.label, group, active: m.active });
    }
    group += 1;
  }
  return controls;
}
