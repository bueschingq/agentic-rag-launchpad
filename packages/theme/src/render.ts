// Model text, rendered the same safe way wherever it shows: the chat (the widget renders the
// parsed blocks with DOM calls), validation, the picker, Review's preview and the report (the
// console renders renderModelText's HTML). The markdown answers use: bold, italics, lists,
// headings (as bold lines), inline code and links. No Markdown syntax ever reaches the screen
// (round 6, MOVEit: "[Request a Demo](Request a Demo)" showed brackets and all):
//
// - `[text](target)` is a link only when the target is one of the deployment's synced pages or a
//   call-to-action target, or, when the synced set sent is capped, any page on its own sites;
// - a target that isn't an address links to the cited page whose title is the text, or to the
//   synced page named like it, or the text stays plain;
// - `[text](#)`, unsafe targets (javascript:, data:, anything not http(s)) and pages elsewhere
//   become plain text;
// - stray `[`, `]` and `](…)`, footnote markers ("[1]"), images and reference definitions go.
//
// `repaired` says the model's formatting couldn't be shown as written, for validation's note.
// Pure and dependency-free: the widget bundles it.

import { safeHref } from "./sources.ts";

export type Inline =
  | { kind: "text"; text: string }
  | { kind: "strong" | "em"; children: Inline[] }
  | { kind: "link"; href: string; children: Inline[] }
  | { kind: "code"; text: string }
  | { kind: "br" };

export type Block = { kind: "p" | "h"; inline: Inline[] } | { kind: "ul" | "ol"; items: Inline[][]; start: number };

// Set when the parse dropped or rewrote syntax.
export interface ParseNotes {
  repaired: boolean;
}

export interface LinkContext {
  // The deployment's synced pages, as paths ("/pricing") or full addresses.
  pagePaths?: readonly string[];
  // Its call-to-action and handoff targets (pages, mailto:, tel:).
  ctaTargets?: readonly string[];
  // pagePaths is a capped subset of the synced pages: then any page on the deployment's own sites
  // may be linked.
  capped?: boolean;
  // The deployment's own sites; the first is where a relative path goes.
  hosts?: readonly string[];
  // The pages the answer cites, for a target that isn't an address.
  pages?: readonly { title: string; href: string }[];
}

// How many synced paths the public config carries.
export const PAGE_PATHS_CAP = 300;

const BULLET = /^\s*[-*+•]\s+(.*)$/;
const NUMBERED = /^\s*(\d{1,9})[.)]\s+(.*)$/;
const HEADING = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/;
const REFERENCE = /^\s{0,3}\[[^\]\n]+\]:\s*\S/;

// `partial`: the text is still streaming, so an unclosed ** is bold to the end rather than
// two stray asterisks that vanish a moment later.
export function parseModelText(source: string, partial = false, notes?: ParseNotes): Block[] {
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  let list: { kind: "ul" | "ol"; items: string[]; start: number } | undefined;
  const inline = (s: string) => parseInline(s, partial, notes);

  const endParagraph = () => {
    if (paragraph.length)
      blocks.push({ kind: "p", inline: paragraph.flatMap((line, i) => [...(i ? [{ kind: "br" } as const] : []), ...inline(line)]) });
    paragraph = [];
  };
  const endList = () => {
    if (list) blocks.push({ kind: list.kind, start: list.start, items: list.items.map(inline) });
    list = undefined;
  };

  for (const line of source.replace(/\r\n?/g, "\n").split("\n")) {
    const heading = HEADING.exec(line);
    const bullet = BULLET.exec(line);
    const numbered = NUMBERED.exec(line);
    if (REFERENCE.test(line)) {
      // "[1]: https://…", a link reference definition: never shown.
      if (notes) notes.repaired = true;
    } else if (!line.trim()) {
      endParagraph();
      endList();
    } else if (heading) {
      endParagraph();
      endList();
      blocks.push({ kind: "h", inline: inline(heading[1]!) });
    } else if (bullet || numbered) {
      endParagraph();
      const kind = bullet ? "ul" : "ol";
      if (list?.kind !== kind) {
        endList();
        list = { kind, items: [], start: numbered ? Number(numbered[1]) : 1 };
      }
      list.items.push(bullet ? bullet[1]! : numbered![2]!);
    } else if (list && /^\s+\S/.test(line)) {
      // An indented line continues the list item above it.
      list.items[list.items.length - 1] += ` ${line.trim()}`;
    } else {
      endList();
      paragraph.push(line.trim());
    }
  }
  endParagraph();
  endList();
  return blocks;
}

const WORD = /[\p{L}\p{N}]/u;
// "[1]", "[^2]", "[1, 3]": footnote markers, dropped with the space before them.
const FOOTNOTE = /^\s*\^?\d{1,3}(\s*[,–-]\s*\^?\d{1,3})*\s*$/;

// The index of the bracket that closes the one at `open`, on the same line; -1 when none does.
function closing(s: string, open: number, left: string, right: string): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (c === "\n") return -1;
    if (c === "\\") i++;
    else if (c === left) depth++;
    else if (c === right && --depth === 0) return i;
  }
  return -1;
}

// A link's text holds no links of its own.
const unlink = (nodes: Inline[]): Inline[] =>
  nodes.flatMap((n) => (n.kind === "link" ? unlink(n.children) : "children" in n ? [{ ...n, children: unlink(n.children) }] : [n]));

const fold = (text: string) =>
  text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

export function parseInline(s: string, partial = false, notes?: ParseNotes): Inline[] {
  const out: Inline[] = [];
  let text = "";
  const repaired = () => {
    if (notes) notes.repaired = true;
  };
  const flush = () => {
    if (text) out.push({ kind: "text", text });
    text = "";
  };
  const inner = (label: string) => parseInline(label, partial, notes);
  let i = 0;
  while (i < s.length) {
    const c = s[i]!;
    const rest = s.slice(i);
    if (c === "\\" && (s[i + 1] === "[" || s[i + 1] === "]")) {
      // An escaped bracket is still a bracket on screen.
      repaired();
      i += 2;
      continue;
    }
    if (c === "[" || (c === "!" && s[i + 1] === "[")) {
      const image = c === "!";
      const open = image ? i + 1 : i;
      const close = closing(s, open, "[", "]");
      if (close < 0) {
        // Unclosed (or still streaming): the bracket goes, the text stays.
        if (!partial) repaired();
        i = open + 1;
        continue;
      }
      const label = s.slice(open + 1, close);
      let j = close + 1;
      if (!image && FOOTNOTE.test(label)) {
        repaired();
        text = text.replace(/\s+$/, "");
        i = j;
        continue;
      }
      // "[text] (target)": a link when what's in the parentheses is one word, not a note.
      const spaced = s[j] === " " && s[j + 1] === "(";
      if (spaced) j++;
      if (s[j] === "(") {
        const end = closing(s, j, "(", ")");
        let target: string;
        let next: number;
        if (end >= 0) {
          target = s.slice(j + 1, end);
          next = end + 1;
        } else {
          // Unclosed: the target runs to the next space, or repeats the text ("[Request a
          // Demo](Request a Demo").
          const after = s.slice(j + 1);
          target = label.trim() && after.toLowerCase().startsWith(label.toLowerCase()) ? label : (/^\S*/.exec(after)?.[0] ?? "");
          next = j + 1 + target.length;
          if (!partial) repaired();
        }
        if (spaced && !/^\s*\S+\s*$/.test(target)) {
          // "[text] (a note)": the brackets go, the note stays.
          repaired();
          flush();
          out.push(...inner(label));
          i = close + 1;
          continue;
        }
        flush();
        if (image) {
          // An image shows its description, never the image.
          repaired();
          out.push(...unlink(inner(label)));
        } else out.push({ kind: "link", href: target, children: unlink(inner(label)) });
        i = next;
        continue;
      }
      // "[text][ref]" or "[text]": the text alone.
      repaired();
      if (s[j] === "[") {
        const ref = closing(s, j, "[", "]");
        if (ref > 0) j = ref + 1;
      }
      flush();
      out.push(...inner(label));
      i = j;
      continue;
    }
    if (c === "]") {
      // A stray "]", and the "(target)" after it.
      repaired();
      const end = s[i + 1] === "(" ? closing(s, i + 1, "(", ")") : -1;
      i = end > 0 ? end + 1 : i + 1;
      continue;
    }
    if (rest.startsWith("**") || rest.startsWith("__")) {
      const marker = rest.slice(0, 2);
      let end = s.indexOf(marker, i + 2);
      if (end < 0 && partial && marker === "**" && s.length > i + 2) end = s.length;
      if (end > i + 2) {
        flush();
        out.push({ kind: "strong", children: inner(s.slice(i + 2, end)) });
        i = end + 2;
        continue;
      }
    }
    if (c === "*" || c === "_") {
      const end = s.indexOf(c, i + 1);
      // *a b* and _a b_, but not 2 * 3 * 4, snake_case_names or a lone asterisk.
      const fits =
        end > i + 1 &&
        !/\s/.test(s[i + 1]!) &&
        !/\s/.test(s[end - 1]!) &&
        (c === "*" || (!WORD.test(s[i - 1] ?? "") && !WORD.test(s[end + 1] ?? "")));
      if (fits) {
        flush();
        out.push({ kind: "em", children: inner(s.slice(i + 1, end)) });
        i = end + 1;
        continue;
      }
    }
    if (c === "`") {
      const end = s.indexOf("`", i + 1);
      if (end > i + 1) {
        flush();
        const code = s.slice(i + 1, end);
        const shown = code.replace(/[[\]]/g, "");
        if (shown !== code) repaired();
        out.push({ kind: "code", text: shown });
        i = end + 1;
        continue;
      }
    }
    text += c;
    i += 1;
  }
  flush();
  return out;
}

const inlineText = (nodes: Inline[]): string =>
  nodes.map((n) => (n.kind === "text" || n.kind === "code" ? n.text : n.kind === "br" ? "\n" : inlineText(n.children))).join("");

// The text a screen reader should hear, and what call-to-action keywords are matched against.
export function plainText(blocks: Block[]): string {
  return blocks.map((b) => ("items" in b ? b.items.map(inlineText).join("\n") : inlineText(b.inline))).join("\n");
}

// ---- which links show ----

const bare = (host: string) => host.toLowerCase().replace(/^www\./, "");

// One site: www.client.com, client.com and shop.client.com, but not client.com.evil.example.
export function sameSite(host: string, other: string): boolean {
  const [a, b] = [bare(host), bare(other)];
  return Boolean(a) && (a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`));
}

// A path as pages are compared: no query or fragment, no trailing slash, lower case.
export const normalizePath = (path: string): string =>
  `/${path.replace(/[?#].*$/, "").replace(/^\/+/, "")}`
    .replace(/\/{2,}/g, "/")
    .replace(/(.)\/+$/, "$1")
    .toLowerCase();

const SCHEME = /^([a-z][a-z\d+.-]*):/i;

const toUrl = (s: string): URL | undefined => {
  try {
    return new URL(s);
  } catch {
    return undefined;
  }
};

// A call-to-action target as an href: a page, an email or a phone number.
const ctaHref = (url: string): string | undefined => {
  const u = toUrl(url.trim());
  return u && ["https:", "http:", "mailto:", "tel:"].includes(u.protocol) ? u.href : undefined;
};

function listed(path: string, host: string | undefined, ctx: LinkContext): boolean {
  const own = host === undefined || Boolean(ctx.hosts?.some((h) => sameSite(host, h)));
  for (const entry of [...(ctx.pagePaths ?? []), ...(ctx.ctaTargets ?? [])]) {
    if (SCHEME.test(entry)) {
      const u = toUrl(entry.trim());
      if (u && (u.protocol === "https:" || u.protocol === "http:") && (host === undefined ? own : sameSite(u.host, host))) {
        if (normalizePath(u.pathname) === path) return true;
      }
    } else if (own && entry.trim() && normalizePath(entry.trim()) === path) return true;
  }
  return false;
}

// A synced path on the deployment's first site.
function onSite(path: string, ctx: LinkContext): string | undefined {
  const host = ctx.hosts?.[0];
  return host ? safeHref(`https://${host.replace(/^https?:\/\//, "")}${path}`) : undefined;
}

function titleMatches(title: string, text: string): boolean {
  const [a, b] = [fold(title), fold(text)];
  if (b.length < 3 || !a) return false;
  return a === b || (b.length >= 5 && ` ${a} `.includes(` ${b} `)) || (a.length >= 5 && ` ${b} `.includes(` ${a} `));
}

// Where a model-written link may go, or undefined to show its text unlinked.
export function linkFor(target: string, label: string, ctx: LinkContext): string | undefined {
  let t = target
    .trim()
    .replace(/^<([^>]*)>$/, "$1")
    .trim();
  // [text](url "Title")
  const titled = /^(\S+)\s+("[^"]*"|'[^']*')$/.exec(t);
  if (titled) t = titled[1]!;
  if (!t || t.startsWith("#")) return undefined;
  const cta = ctx.ctaTargets?.find((c) => c.trim() === t);
  if (cta) return ctaHref(cta);
  const scheme = SCHEME.exec(t)?.[1]?.toLowerCase();
  let url: URL | undefined;
  if (scheme) {
    if (scheme !== "https" && scheme !== "http") return undefined;
    url = toUrl(t.replace(/\s/g, "%20"));
    if (!url) return undefined;
  } else if (t.startsWith("//") && !/\s/.test(t)) url = toUrl(`https:${t}`);
  else if (!/\s/.test(t)) {
    // /pricing, ./pricing, pricing, or client.com/pricing.
    const path = normalizePath(t.replace(/^(\.\.?\/)+/, ""));
    if (listed(path, undefined, ctx)) return onSite(path, ctx);
    if (/^([\w-]+\.)+[a-z]{2,}(\/|$)/i.test(t)) url = toUrl(`https://${t}`);
  }
  if (url) {
    if (listed(normalizePath(url.pathname), url.host, ctx)) return url.href;
    return ctx.capped && ctx.hosts?.some((h) => sameSite(url.host, h)) ? url.href : undefined;
  }
  // Not an address ("Request a Demo"): the cited page titled like the text, or the synced page
  // named like it.
  for (const page of ctx.pages ?? []) {
    if (titleMatches(page.title, label) || titleMatches(page.title, t)) {
      const href = safeHref(page.href);
      if (href) return href;
    }
  }
  const slug = `/${fold(label).replace(/ /g, "-")}`;
  return slug.length > 2 && listed(slug, undefined, ctx) ? onSite(slug, ctx) : undefined;
}

// The synced pages as the public config carries them: distinct paths, at most `cap`, in the order
// given (key pages first), and whether some were left out.
export function compactPagePaths(urls: readonly string[], cap = PAGE_PATHS_CAP): { paths: string[]; capped: boolean } {
  const paths = new Set<string>();
  for (const url of urls) {
    const u = toUrl(url);
    const path = u ? normalizePath(u.pathname) : url.startsWith("/") ? normalizePath(url) : undefined;
    if (path) paths.add(path);
  }
  const all = [...paths];
  return { paths: all.slice(0, cap), capped: all.length > cap };
}

// ---- HTML, for the console ----

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

// Model text as HTML that is safe to set as innerHTML: every character from the model is escaped,
// and the only attributes written are vetted hrefs.
export function renderModelText(text: string, ctx: LinkContext = {}): { html: string; repaired: boolean } {
  const notes: ParseNotes = { repaired: false };
  const blocks = parseModelText(text, false, notes);
  const inline = (nodes: Inline[]): string =>
    nodes
      .map((n) => {
        if (n.kind === "text") return escapeHtml(n.text);
        if (n.kind === "br") return "<br>";
        if (n.kind === "code") return `<code>${escapeHtml(n.text)}</code>`;
        if (n.kind !== "link") return `<${n.kind}>${inline(n.children)}</${n.kind}>`;
        const href = linkFor(n.href, inlineText(n.children), ctx);
        // Shown as plain text, or linked from a target that wasn't an address.
        if (!href || /\s/.test(n.href.trim())) notes.repaired = true;
        if (!href) return inline(n.children);
        return `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${inline(n.children)}</a>`;
      })
      .join("");
  const html = blocks
    .map((b) => {
      if ("items" in b) {
        const start = b.kind === "ol" && b.start !== 1 ? ` start="${b.start}"` : "";
        return `<${b.kind}${start}>${b.items.map((item) => `<li>${inline(item)}</li>`).join("")}</${b.kind}>`;
      }
      return b.kind === "h" ? `<p><strong>${inline(b.inline)}</strong></p>` : `<p>${inline(b.inline)}</p>`;
    })
    .join("");
  return { html, repaired: notes.repaired };
}
