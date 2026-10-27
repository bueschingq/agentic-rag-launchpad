// Shadow-DOM stylesheet. Every visual decision reads a --arag-chat-* token (toCssVariables),
// and every structural element is exposed as a ::part() for partners' custom CSS.

export const STYLES = /* css */ `
:host {
  all: initial;
  font-family: var(--arag-chat-font-family);
  font-size: var(--arag-chat-font-size);
  line-height: var(--arag-chat-line-height);
  color: var(--arag-chat-color-text);
}
*, *::before, *::after { box-sizing: border-box; }
[hidden] { display: none !important; }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }

.launcher {
  position: fixed;
  bottom: var(--arag-chat-launcher-offset);
  width: var(--arag-chat-launcher-size);
  height: var(--arag-chat-launcher-size);
  border: 0;
  border-radius: 50%;
  background: var(--arag-chat-color-primary);
  color: var(--arag-chat-color-on-primary);
  box-shadow: var(--arag-chat-shadow);
  cursor: pointer;
  display: grid;
  place-items: center;
  z-index: 2147483000;
}
.launcher svg { width: 45%; height: 45%; }
:host([data-position="bottom-right"]) .launcher, :host([data-position="bottom-right"]) .panel.overlay { right: var(--arag-chat-launcher-offset); }
:host([data-position="bottom-left"]) .launcher, :host([data-position="bottom-left"]) .panel.overlay { left: var(--arag-chat-launcher-offset); }

.panel {
  display: flex;
  flex-direction: column;
  background: var(--arag-chat-color-surface);
  border: 1px solid var(--arag-chat-color-border);
  border-radius: var(--arag-chat-radius);
  overflow: hidden;
}
.panel.overlay {
  position: fixed;
  bottom: calc(var(--arag-chat-launcher-offset) + var(--arag-chat-launcher-size) + 12px);
  width: min(380px, calc(100vw - 2 * var(--arag-chat-launcher-offset)));
  height: min(600px, calc(100vh - var(--arag-chat-launcher-size) - 3 * var(--arag-chat-launcher-offset)));
  box-shadow: var(--arag-chat-shadow);
  z-index: 2147483000;
}
.panel.inline { width: 100%; min-height: 420px; }

.header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 12px 16px;
  background: var(--arag-chat-color-surface-alt);
  border-bottom: 1px solid var(--arag-chat-color-border);
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
.message.user { align-self: flex-end; background: var(--arag-chat-color-primary); color: var(--arag-chat-color-on-primary); }
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
  background: var(--arag-chat-color-primary);
  color: var(--arag-chat-color-on-primary);
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
  .panel.overlay { inset: 0; width: 100vw; height: 100dvh; border-radius: 0; border: 0; }
}
@media (prefers-reduced-motion: reduce) {
  .message[aria-busy="true"]::after { animation: none; }
}
`;
