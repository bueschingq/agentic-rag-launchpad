// Shadow-DOM stylesheet. Every visual decision reads a --arag-chat-* token (toCssVariables),
// and every structural element is exposed as a ::part() for partners' custom CSS.
//
// The host carries data-mode (layout), data-finish (surface treatment) and data-position.

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

/* Floating: a chat button pinned to a corner, opening a panel above it. */
.launcher {
  position: fixed;
  bottom: var(--arag-chat-launcher-offset);
  width: var(--arag-chat-launcher-size);
  height: var(--arag-chat-launcher-size);
  border: 0;
  border-radius: 50%;
  background: var(--arag-chat-fill);
  color: var(--arag-chat-color-on-primary);
  box-shadow: var(--arag-chat-bevel), var(--arag-chat-shadow);
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
  border: 1px solid var(--arag-chat-color-border);
  border-radius: var(--arag-chat-radius);
  overflow: hidden;
}
.panel.floating {
  position: fixed;
  bottom: calc(var(--arag-chat-launcher-offset) + var(--arag-chat-launcher-size) + 12px);
  width: min(380px, calc(100vw - 2 * var(--arag-chat-launcher-offset)));
  height: min(600px, calc(100vh - var(--arag-chat-launcher-size) - 3 * var(--arag-chat-launcher-offset)));
  box-shadow: var(--arag-chat-shadow);
  z-index: 2147483000;
}

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
.panel.embedded .message.assistant { align-self: stretch; padding: 14px 16px; border: 1px solid var(--arag-chat-color-border); }
.panel.embedded .disclosure, .panel.embedded .powered-by { padding: 0; }

.header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 12px 16px;
  background: var(--arag-chat-header-fill);
  border-bottom: 1px solid var(--arag-chat-color-border);
  box-shadow: var(--arag-chat-bevel);
  font-family: var(--arag-chat-font-heading-family, inherit);
  font-weight: 600;
}
.close {
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 1.4em;
  line-height: 1;
  cursor: pointer;
  border-radius: var(--arag-chat-button-radius);
  padding: 2px 8px;
}

.log { flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 12px; }
.message { max-width: 88%; padding: 10px 12px; border-radius: var(--arag-chat-bubble-radius); white-space: pre-wrap; overflow-wrap: anywhere; }
.message.user {
  align-self: flex-end;
  background: var(--arag-chat-fill);
  color: var(--arag-chat-color-on-primary);
  box-shadow: var(--arag-chat-bevel);
}
.message.assistant { align-self: flex-start; background: var(--arag-chat-color-surface-alt); }
.message[aria-busy="true"]::after { content: "▍"; animation: blink 1s steps(2) infinite; }
@keyframes blink { 50% { opacity: 0; } }

.sources { margin: 8px 0 0; padding: 0; list-style: none; font-size: 0.9em; white-space: normal; }
.sources li + li { margin-top: 4px; }
.sources a { color: var(--arag-chat-color-link); }

.starters { display: flex; flex-wrap: wrap; gap: 8px; }
.starter {
  border: 1px solid var(--arag-chat-color-border);
  background: var(--arag-chat-color-surface);
  color: var(--arag-chat-color-text);
  border-radius: var(--arag-chat-button-radius);
  padding: 6px 10px;
  font: inherit;
  font-size: 0.92em;
  cursor: pointer;
  text-align: left;
}

.form { display: flex; gap: 8px; padding: 12px; border-top: 1px solid var(--arag-chat-color-border); }
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

.disclosure, .powered-by { margin: 0; padding: 0 12px 10px; font-size: 0.8em; color: var(--arag-chat-color-text-muted); }

:focus-visible { outline: 2px solid var(--arag-chat-color-focus); outline-offset: 2px; }

@media (max-width: 480px) {
  /* :host([data-position]) outranks the corner offsets above. */
  :host([data-position]) .panel.floating { inset: 0; width: 100vw; height: 100dvh; border-radius: 0; border: 0; }
  .modal { width: 100vw; height: 100dvh; }
  .panel.popup { border-radius: 0; border: 0; }
}
@media (prefers-reduced-motion: reduce) {
  .message[aria-busy="true"]::after { animation: none; }
}
`;
