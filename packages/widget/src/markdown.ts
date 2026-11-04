// The markdown answers use, rendered safely: bold, italics, lists, headings (as bold lines),
// inline code and links. Parsing is pure and shared with the console (renderModelText): no
// bracket syntax survives it. Rendering builds DOM nodes and sets text with textContent, so
// nothing from the network is ever parsed as HTML. Links render only when `allowHref` accepts
// them (linkFor: a synced page or a call-to-action target); anything else stays plain text.

import { type Block, type Inline, plainText } from "@launchpad/theme";

// The parse is the shared one (render.ts in @launchpad/theme), as the console renders it.
export { type Block, type Inline, parseInline, parseModelText as parseMarkdown, plainText } from "@launchpad/theme";

export interface RenderOptions {
  // Returns the href to use for a link (its target and its text), or undefined to show its text
  // unlinked.
  allowHref: (href: string, text: string) => string | undefined;
  // Decorates a rendered link (target, rel, analytics).
  onLink?: (a: HTMLAnchorElement) => void;
}

export function renderMarkdown(blocks: Block[], doc: Document, options: RenderOptions): DocumentFragment {
  const fragment = doc.createDocumentFragment();
  const inline = (parent: Node, nodes: Inline[]) => {
    for (const n of nodes) {
      if (n.kind === "text") parent.appendChild(doc.createTextNode(n.text));
      else if (n.kind === "br") parent.appendChild(doc.createElement("br"));
      else if (n.kind === "code") parent.appendChild(doc.createElement("code")).textContent = n.text;
      else if (n.kind !== "link") inline(parent.appendChild(doc.createElement(n.kind)), n.children);
      else {
        const href = options.allowHref(n.href, plainText([{ kind: "p", inline: n.children }]));
        if (!href) {
          inline(parent, n.children);
          continue;
        }
        const a = doc.createElement("a");
        a.href = href;
        inline(a, n.children);
        options.onLink?.(a);
        parent.appendChild(a);
      }
    }
  };
  for (const block of blocks) {
    if ("items" in block) {
      const list = doc.createElement(block.kind);
      if (block.kind === "ol" && block.start !== 1) list.setAttribute("start", String(block.start));
      for (const item of block.items) inline(list.appendChild(doc.createElement("li")), item);
      fragment.appendChild(list);
    } else {
      const p = doc.createElement("p");
      if (block.kind === "h") inline(p.appendChild(doc.createElement("strong")), block.inline);
      else inline(p, block.inline);
      fragment.appendChild(p);
    }
  }
  return fragment;
}
