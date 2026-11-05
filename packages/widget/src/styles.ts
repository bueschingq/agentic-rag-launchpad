// Shadow-DOM stylesheet. Every visual decision reads a --arag-chat-* token (toCssVariables),
// and every structural element is exposed as a ::part() for partners' custom CSS.
//
// The host carries data-mode (layout), data-finish (surface treatment) and data-position, and
// data-device on the console's stills of the panel (preview's snapshot).
//
// The styles go in as constructable stylesheets (adoptedStyleSheets), which a page's Content
// Security Policy doesn't count as inline styles, so the widget is fully styled under
// `style-src 'self'`. Browsers without them (Safari before 16.4) get <style> elements.

export const STYLES = /* css */ `
:host {
  all: initial;
  display: block;
  font-family: var(--arag-chat-font-family);
  font-size: var(--arag-chat-font-size);
  line-height: var(--arag-chat-line-height);
  color: var(--arag-chat-color-text);

  /* Finish. Primary fills: launcher, send, user messages, the popup's Ask. Flat by default. */
  --arag-chat-fill: var(--arag-chat-color-primary);
  --arag-chat-header-fill: var(--arag-chat-color-surface-alt);
  --arag-chat-bevel: inset 0 0 0 transparent;
}
:host([data-finish="gloss"]) {
  /* A sheen over the top half with a hard edge at the middle, and lit top edges. */
  --arag-chat-fill:
    linear-gradient(
      180deg,
      rgb(255 255 255 / var(--arag-chat-gloss-sheen)) 0%,
      rgb(255 255 255 / calc(var(--arag-chat-gloss-sheen) * 0.4)) 50%,
      rgb(0 0 0 / 0.06) 50%,
      rgb(0 0 0 / 0) 100%
    ),
    var(--arag-chat-gloss-base);
  --arag-chat-header-fill:
    linear-gradient(180deg, rgb(255 255 255 / var(--arag-chat-gloss-sheen)), rgb(255 255 255 / 0) 60%),
    var(--arag-chat-gloss-header-base);
  --arag-chat-bevel: inset 0 1px 0 rgb(255 255 255 / 0.45), inset 0 -1px 0 rgb(0 0 0 / 0.12);
}
:host([data-finish="gradient"]) {
  --arag-chat-fill: linear-gradient(135deg, var(--arag-chat-color-primary), var(--arag-chat-gradient-end));
  --arag-chat-header-fill: linear-gradient(180deg, var(--arag-chat-color-surface-alt), var(--arag-chat-color-surface));
}

*, *::before, *::after { box-sizing: border-box; }
[hidden] { display: none !important; }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }

/* Floating: a chat button pinned to a corner, opening a panel above it. The outline is drawn
   only when the primary color alone wouldn't stand out from the page. --arag-chat-lift is the
   height of a cookie bar or bottom menu under it (lift.ts), set on the button and the panel. */
.launcher {
  position: fixed;
  bottom: calc(var(--arag-chat-launcher-bottom) + var(--arag-chat-lift, 0px));
  transition: bottom 0.2s ease-out;
  width: var(--arag-chat-launcher-size);
  height: var(--arag-chat-launcher-size);
  border: 0;
  border-radius: 50%;
  background: var(--arag-chat-fill);
  color: var(--arag-chat-color-on-primary);
  box-shadow: 0 0 0 2px var(--arag-chat-launcher-outline), var(--arag-chat-bevel), var(--arag-chat-shadow);
  cursor: pointer;
  display: grid;
  place-items: center;
  z-index: 2147483000;
}
.launcher svg { width: 45%; height: 45%; }
:host([data-position="bottom-right"]) .launcher, :host([data-position="bottom-right"]) .panel.floating { right: var(--arag-chat-launcher-offset); }
:host([data-position="bottom-left"]) .launcher, :host([data-position="bottom-left"]) .panel.floating { left: var(--arag-chat-launcher-offset); }

.panel {
  display: flex;
  flex-direction: column;
  background: var(--arag-chat-color-surface);
  border: 1px solid var(--arag-chat-color-divider);
  border-radius: var(--arag-chat-radius);
  overflow: hidden;
}
/* The floating panel is a <dialog>: the browser's dialog styles are reset, and it shows only
   while open. */
.panel.floating {
  position: fixed;
  inset: auto;
  margin: 0;
  padding: 0;
  max-width: none;
  max-height: none;
  color: inherit;
  bottom: calc(var(--arag-chat-launcher-bottom) + var(--arag-chat-lift, 0px) + var(--arag-chat-launcher-size) + 12px);
  width: min(380px, calc(100vw - 2 * var(--arag-chat-launcher-offset)));
  height: min(
    600px,
    calc(100vh - var(--arag-chat-launcher-bottom) - var(--arag-chat-lift, 0px) - var(--arag-chat-launcher-size) - 12px - var(--arag-chat-launcher-offset))
  );
  box-shadow: var(--arag-chat-shadow);
  z-index: 2147483000;
}
.panel.floating:not([open]) { display: none; }
.panel.floating::backdrop { background: transparent; }

/* The console's stills (preview's snapshot): the panel in the page flow at the element's width,
   showing just its header (or an embedded chat's intro), or just the welcome and starters. */
.panel.snapshot { position: static; width: auto; height: auto; box-shadow: none; }
:host([data-device="phone"]) .panel.snapshot:not(.embedded) { border: 0; border-radius: 0; }
.panel.only-header > :not(.header, .intro, .handoff), .panel.only-starters > :not(.log, .intro) { display: none; }
.panel.only-starters .log { overflow: visible; }

/* Chat: the whole conversation in the page flow. Override the height with ::part(panel). */
.panel.chat { width: 100%; height: 560px; max-height: 85vh; }

/* Popup: an ask bar in the page, and the conversation in a modal above the content. */
.trigger {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  min-height: 48px;
  padding: 6px 6px 6px 14px;
  border: 1px solid var(--arag-chat-color-border);
  border-radius: var(--arag-chat-input-radius);
  background: var(--arag-chat-color-surface);
  color: var(--arag-chat-color-text-muted);
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.trigger svg { width: 18px; height: 18px; flex: none; }
.trigger-text { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.trigger-cta {
  padding: 8px 16px;
  border-radius: var(--arag-chat-button-radius);
  background: var(--arag-chat-fill);
  color: var(--arag-chat-color-on-primary);
  box-shadow: var(--arag-chat-bevel);
  font-weight: 600;
}
.modal {
  width: min(720px, calc(100vw - 32px));
  height: min(640px, calc(100dvh - 64px));
  max-width: none;
  max-height: none;
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  overflow: visible;
}
.modal::backdrop { background: rgb(15 23 42 / 0.55); }
.panel.popup { height: 100%; box-shadow: var(--arag-chat-shadow); }

/* Embedded: an ask box in the page flow, answers underneath, no chrome of its own. */
.panel.embedded { gap: 12px; background: transparent; border: 0; border-radius: 0; overflow: visible; }
.intro { margin: 0; font-family: var(--arag-chat-font-heading-family, inherit); font-size: 1.1em; font-weight: 600; }
.panel.embedded .form { padding: 0; border: 0; }
.panel.embedded .log { padding: 0; overflow: visible; }
.panel.embedded .log:empty { display: none; }
.panel.embedded .message { max-width: none; }
.panel.embedded .message.user {
  align-self: stretch;
  padding: 0;
  background: none;
  color: var(--arag-chat-color-text);
  font-family: var(--arag-chat-font-heading-family, inherit);
  font-weight: 600;
  box-shadow: none;
}
.panel.embedded .message.assistant { align-self: stretch; padding: 14px 16px; border: 1px solid var(--arag-chat-color-divider); }
.panel.embedded .disclosure, .panel.embedded .powered-by { padding: 0; }

.header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 12px 16px;
  background: var(--arag-chat-header-fill);
  border-bottom: 1px solid var(--arag-chat-color-divider);
  box-shadow: var(--arag-chat-bevel);
  font-family: var(--arag-chat-font-heading-family, inherit);
  font-weight: 600;
}
.header .title { flex: 1; display: flex; align-items: center; gap: 8px; min-width: 0; }
/* The chat's name on one line. The header goes compact (element.ts) before it would be cut, and
   then it is cut with an ellipsis only after a few letters. */
.header .name { min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.header.compact .name { flex: 0 1 auto; min-width: 4em; }
.avatar { height: 28px; width: auto; max-width: 96px; object-fit: contain; flex: none; }
/* Only when the name is down to its few letters does a wide logo give way too. */
.header.compact .avatar { flex-shrink: 0.01; min-width: 28px; }
.intro .avatar { margin-right: 10px; vertical-align: middle; }
.talk, .secondary {
  border: 1px solid var(--arag-chat-color-border);
  background: var(--arag-chat-color-surface);
  color: var(--arag-chat-color-text);
  font: inherit;
  font-size: 0.85em;
  font-weight: 600;
  border-radius: var(--arag-chat-button-radius);
  min-height: 28px;
  padding: 4px 10px;
  cursor: pointer;
}
/* "Talk to a person": its label while the name fits beside it, else its icon alone, with the
   label as its name and as a tooltip on hover and keyboard focus. */
.talk { position: relative; flex: none; display: inline-flex; align-items: center; justify-content: center; min-height: 32px; white-space: nowrap; }
.talk svg { display: none; width: 18px; height: 18px; flex: none; }
.header.compact .talk { width: 32px; padding: 0; }
.header.compact .talk svg { display: block; }
.header.compact .talk-label { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
.header.compact .talk::after {
  content: attr(data-tip);
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  z-index: 1;
  padding: 4px 8px;
  border-radius: 4px;
  background: var(--arag-chat-color-text);
  color: var(--arag-chat-color-surface);
  font-size: 0.85em;
  font-weight: 600;
  white-space: nowrap;
  pointer-events: none;
  visibility: hidden;
}
.header.compact .talk:hover::after, .header.compact .talk:focus-visible::after { visibility: visible; }
.close {
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 1.4em;
  line-height: 1;
  cursor: pointer;
  border-radius: var(--arag-chat-button-radius);
  min-width: 32px;
  min-height: 32px;
  padding: 2px 8px;
}

.log { flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 12px; }
.message { max-width: 88%; padding: 10px 12px; border-radius: var(--arag-chat-bubble-radius); overflow-wrap: anywhere; }
.message.user {
  align-self: flex-end;
  white-space: pre-wrap;
  background: var(--arag-chat-fill);
  color: var(--arag-chat-color-on-primary);
  box-shadow: var(--arag-chat-bevel);
}
.message.assistant { align-self: flex-start; background: var(--arag-chat-color-surface-alt); }
.cursor { animation: blink 1s steps(2) infinite; }
@keyframes blink { 50% { opacity: 0; } }

/* Answers: the safe markdown subset. */
.answer p { margin: 0 0 0.6em; }
.answer ul, .answer ol { margin: 0 0 0.6em; padding-left: 1.3em; }
.answer li + li { margin-top: 0.2em; }
.answer > :last-child { margin-bottom: 0; }
.answer a { color: var(--arag-chat-color-link); }
.answer code { font-family: ui-monospace, Consolas, monospace; font-size: 0.92em; }

.sources { margin-top: 10px; font-size: 0.9em; }
.sources-label { margin: 0 0 2px; font-size: 0.85em; font-weight: 600; color: var(--arag-chat-color-text-muted); }
.sources ul { margin: 0; padding: 0; list-style: none; }
/* At least 24px tall, so each is an easy target (WCAG 2.5.8). Another site's domain goes on
   the title's line when it fits, else on its own line, and is cut short rather than broken. */
.sources a { display: inline-flex; flex-wrap: wrap; align-items: center; column-gap: 0.4em; max-width: 100%; min-height: 24px; color: var(--arag-chat-color-link); }
.source-domain {
  max-width: 100%;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  overflow-wrap: normal;
  color: var(--arag-chat-color-text-muted);
  font-size: 0.9em;
}

/* Call-to-action buttons and the handoff to a person, under replies. */
.ctas { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
.cta {
  display: inline-flex;
  align-items: center;
  min-height: 32px;
  padding: 6px 12px;
  border: 0;
  border-radius: var(--arag-chat-button-radius);
  background: var(--arag-chat-fill);
  color: var(--arag-chat-color-on-primary);
  box-shadow: var(--arag-chat-bevel);
  font: inherit;
  font-weight: 600;
  font-size: 0.92em;
  text-decoration: none;
  cursor: pointer;
}
.handoff { margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--arag-chat-color-divider); }
.handoff p { margin: 0 0 6px; }
.log > .handoff, .log > .lead, .log > .notice, .panel.embedded > .handoff {
  align-self: flex-start;
  max-width: 88%;
  margin: 0;
  padding: 10px 12px;
  border: 1px solid var(--arag-chat-color-divider);
  border-radius: var(--arag-chat-bubble-radius);
}
.panel.embedded > .handoff { align-self: stretch; max-width: none; }
.contacts { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 14px; }
.contact { display: inline-flex; align-items: center; min-height: 24px; color: var(--arag-chat-color-link); font-weight: 600; }
.still { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 12px; margin: 10px 0 0; font-size: 0.9em; color: var(--arag-chat-color-text-muted); }

/* Thumbs, and Try again on a failed reply. */
.feedback { display: flex; align-items: center; gap: 6px; margin-top: 10px; font-size: 0.85em; color: var(--arag-chat-color-text-muted); }
.thumb {
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  padding: 0;
  border: 1px solid var(--arag-chat-color-border);
  border-radius: var(--arag-chat-button-radius);
  background: var(--arag-chat-color-surface);
  color: var(--arag-chat-color-text);
  cursor: pointer;
}
.thumb svg { width: 16px; height: 16px; }
.thumb[aria-pressed="true"] { background: var(--arag-chat-fill); color: var(--arag-chat-color-on-primary); border-color: transparent; }
.thumb[aria-disabled="true"] { cursor: default; }
.retry { margin-top: 10px; }

/* The in-chat contact form. */
.lead { display: grid; gap: 10px; width: 100%; }
.lead p { margin: 0; }
.lead-field { display: grid; gap: 4px; }
.lead-field label { font-weight: 600; font-size: 0.92em; }
.lead-field .opt { font-weight: 400; color: var(--arag-chat-color-text-muted); }
.lead input[type="text"], .lead input[type="email"], .lead input[type="tel"], .lead textarea {
  width: 100%;
  font: inherit;
  color: var(--arag-chat-color-text);
  background: var(--arag-chat-color-surface);
  border: 1px solid var(--arag-chat-color-border);
  border-radius: var(--arag-chat-input-radius);
  padding: 7px 9px;
}
.lead [aria-invalid="true"] { border-width: 2px; border-color: var(--arag-chat-color-text); }
.lead-error { font-size: 0.88em; font-weight: 600; }
.lead-error::before { content: "! "; }
.check { display: flex; align-items: flex-start; gap: 8px; font-size: 0.92em; }
.check input { flex: none; width: 18px; height: 18px; margin: 2px 0 0; accent-color: var(--arag-chat-color-primary); }
.lead-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.lead-actions .send { min-height: 36px; }
.lead-privacy a, .disclosure a { color: var(--arag-chat-color-link); }

.starters { display: flex; flex-wrap: wrap; gap: 8px; }
.starter {
  border: 1px solid var(--arag-chat-color-border);
  background: var(--arag-chat-color-surface);
  color: var(--arag-chat-color-text);
  border-radius: var(--arag-chat-button-radius);
  min-height: 32px;
  padding: 6px 10px;
  font: inherit;
  font-size: 0.92em;
  cursor: pointer;
  text-align: left;
}

.form { display: flex; gap: 8px; padding: 12px; border-top: 1px solid var(--arag-chat-color-divider); }
.input {
  flex: 1;
  resize: none;
  font: inherit;
  color: var(--arag-chat-color-text);
  background: var(--arag-chat-color-surface);
  border: 1px solid var(--arag-chat-color-border);
  border-radius: var(--arag-chat-input-radius);
  padding: 8px 10px;
  max-height: 8em;
}
.send {
  border: 0;
  background: var(--arag-chat-fill);
  color: var(--arag-chat-color-on-primary);
  box-shadow: var(--arag-chat-bevel);
  border-radius: var(--arag-chat-button-radius);
  padding: 0 14px;
  font: inherit;
  font-weight: 600;
  cursor: pointer;
}
.send:disabled { opacity: 0.5; cursor: default; }
.link-button { border: 0; padding: 4px 2px; background: none; color: var(--arag-chat-color-link); font: inherit; text-decoration: underline; cursor: pointer; }

.disclosure, .powered-by { margin: 0; padding: 0 12px 10px; font-size: 0.8em; color: var(--arag-chat-color-text-muted); }

:focus-visible { outline: 2px solid var(--arag-chat-color-focus); outline-offset: 2px; }

/* Touch screens: 16px or more in text fields, or iOS zooms the page when one gets focus. */
@media (pointer: coarse) {
  .input, .lead input, .lead textarea { font-size: max(16px, 1em); }
}
@media (max-width: 480px) {
  /* :host([data-position]) outranks the corner offsets above. A modal dialog here. */
  :host([data-position]) .panel.floating { inset: 0; width: 100vw; height: 100dvh; border-radius: 0; border: 0; }
  .modal { width: 100vw; height: 100dvh; }
  .panel.popup { border-radius: 0; border: 0; }
}
@media (prefers-reduced-motion: reduce) {
  .cursor { animation: none; }
  .launcher { transition: none; }
}
`;

let shared: CSSStyleSheet | undefined;

const constructable = (): boolean => {
  try {
    return "adoptedStyleSheets" in ShadowRoot.prototype && typeof new CSSStyleSheet().replaceSync === "function";
  } catch {
    return false;
  }
};

// The widget's three stylesheets: its own rules (shared by every instance), the theme's
// variables, and the partner's custom CSS, which comes last so it wins at equal specificity.
export class ShadowStyles {
  readonly #sheets: CSSStyleSheet[] | undefined;
  readonly #elements: HTMLStyleElement[] = [];

  constructor(root: ShadowRoot) {
    if (constructable()) {
      shared ??= new CSSStyleSheet();
      if (!shared.cssRules.length) shared.replaceSync(STYLES);
      this.#sheets = [shared, new CSSStyleSheet(), new CSSStyleSheet()];
      root.adoptedStyleSheets = this.#sheets;
    } else {
      this.#elements = [0, 1, 2].map(() => document.createElement("style"));
      this.#elements[0]!.textContent = STYLES;
    }
  }

  // Theme variables and custom CSS. Partner CSS is parsed as a stylesheet: @import is ignored.
  set(variables: string, custom: string) {
    if (this.#sheets) {
      this.#sheets[1]!.replaceSync(variables);
      try {
        this.#sheets[2]!.replaceSync(custom);
      } catch {
        this.#sheets[2]!.replaceSync("");
      }
    } else {
      this.#elements[1]!.textContent = variables;
      this.#elements[2]!.textContent = custom;
    }
  }

  // <style> elements to keep in the shadow root; none when the sheets are adopted.
  get elements(): HTMLStyleElement[] {
    return this.#elements;
  }
}
