// <arag-chat deployment="…" base-url="https://console.partner.example"></arag-chat>
//
// Loads its config from the partner's console, then talks to Agentic RAG directly with a
// session token. All visitor and model text is set with textContent: nothing from the
// network is parsed as HTML.

import { type AskStreamItem, type RetrievedResource, readAskStream } from "@launchpad/par-client/ask-stream";
import { type PublicWidgetConfig, toCssVariables } from "@launchpad/theme";
import { fetchToken, TokenSession } from "./session.ts";
import { sourcesFor } from "./sources.ts";
import { STYLES } from "./styles.ts";

type Turn = { author: "USER" | "NUCLIA"; text: string };

// Follow-up questions carry this many previous turns as chat_history.
const HISTORY_TURNS = 6;

const CHAT_ICON =
  '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M4 4h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-5 4v-4H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z"/></svg>';

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
  node.append(...children);
  return node;
}

export class AragChat extends HTMLElement {
  readonly #root = this.attachShadow({ mode: "open" });
  #config: PublicWidgetConfig | undefined;
  #session: TokenSession | undefined;
  #history: Turn[] = [];
  #inFlight: AbortController | undefined;
  #panel: HTMLElement | undefined;
  #launcher: HTMLButtonElement | undefined;
  #log: HTMLElement | undefined;
  #input: HTMLTextAreaElement | undefined;
  #send: HTMLButtonElement | undefined;

  connectedCallback() {
    if (!this.#config) void this.#load();
  }

  disconnectedCallback() {
    this.#inFlight?.abort();
  }

  async #load() {
    const deployment = this.getAttribute("deployment");
    const base = (this.getAttribute("base-url") ?? location.origin).replace(/\/$/, "");
    if (!deployment) return;
    try {
      const res = await fetch(`${base}/api/public/deployments/${encodeURIComponent(deployment)}/config`);
      if (!res.ok) throw new Error(`config ${res.status}`);
      this.#config = (await res.json()) as PublicWidgetConfig;
    } catch (err) {
      console.warn("[arag-chat] could not load its configuration:", err);
      return;
    }
    this.#session = new TokenSession(() => fetchToken(base, deployment));
    this.#render(this.#config);
  }

  #render(config: PublicWidgetConfig) {
    const { settings } = config;
    const overlay = settings.mode === "overlay";
    this.dataset.position = config.theme.launcher.position;

    const style = el("style");
    style.textContent = `${toCssVariables(config.theme)}\n${STYLES}`;

    const title = settings.nickname ?? "Ask us";
    const close = el("button", { class: "close", part: "close", type: "button", "aria-label": "Close chat" }, "×");
    const header = el("div", { class: "header", part: "header" }, el("span", { part: "title" }, title), ...(overlay ? [close] : []));
    this.#log = el("div", { class: "log", part: "log", role: "log", "aria-live": "polite" });
    const panel = el(
      "section",
      { class: `panel ${overlay ? "overlay" : "inline"}`, part: "panel", role: "dialog", "aria-label": title },
      header,
      this.#log,
    );
    this.#panel = panel;

    if (!config.online) {
      this.#addMessage("assistant", config.offlineMessage);
    } else {
      this.#addMessage("assistant", settings.welcome);
      if (settings.starters?.length) {
        const starters = el("div", { class: "starters", part: "starters" });
        for (const q of settings.starters) {
          const chip = el("button", { class: "starter", part: "starter", type: "button" }, q);
          chip.addEventListener("click", () => {
            starters.remove();
            void this.#ask(q);
          });
          starters.append(chip);
        }
        this.#log.append(starters);
      }
      this.#input = el("textarea", { id: "q", class: "input", part: "input", rows: "1", placeholder: settings.placeholder });
      this.#send = el("button", { class: "send", part: "send", type: "submit" }, "Send");
      const form = el(
        "form",
        { class: "form", part: "form" },
        el("label", { class: "sr-only", for: "q" }, "Your question"),
        this.#input,
        this.#send,
      );
      form.addEventListener("submit", (e) => {
        e.preventDefault();
        const q = this.#input?.value.trim();
        if (q) void this.#ask(q);
      });
      this.#input.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          form.requestSubmit();
        }
      });
      panel.append(form, el("p", { class: "disclosure", part: "disclosure" }, settings.disclosure));
      if (settings.poweredBy) panel.append(el("p", { class: "powered-by", part: "powered-by" }, "Powered by Progress® Agentic RAG"));
    }

    const children: Node[] = [style];
    if (overlay) {
      panel.id = "panel";
      panel.hidden = true;
      this.#launcher = el("button", {
        class: "launcher",
        part: "launcher",
        type: "button",
        "aria-label": `Open ${title}`,
        "aria-expanded": "false",
        "aria-controls": "panel",
      });
      this.#launcher.innerHTML = CHAT_ICON; // static markup, no data
      this.#launcher.addEventListener("click", () => this.#toggle());
      close.addEventListener("click", () => this.#toggle(false));
      panel.addEventListener("keydown", (e) => {
        if (e.key === "Escape") this.#toggle(false);
      });
      children.push(this.#launcher);
    }
    children.push(panel);
    this.#root.replaceChildren(...children);
  }

  #toggle(open = this.#panel?.hidden ?? false) {
    if (!this.#panel || !this.#launcher) return;
    this.#panel.hidden = !open;
    this.#launcher.setAttribute("aria-expanded", String(open));
    this.#launcher.setAttribute("aria-label", `${open ? "Close" : "Open"} ${this.#config?.settings.nickname ?? "Ask us"}`);
    if (open) this.#input?.focus();
    else this.#launcher.focus();
  }

  #addMessage(role: "user" | "assistant", text: string): HTMLElement {
    const message = el("div", { class: `message ${role}`, part: `message ${role}` }, text);
    this.#log?.append(message);
    message.scrollIntoView({ block: "end" });
    return message;
  }

  async #ask(question: string) {
    const config = this.#config;
    if (!config) return;
    this.#inFlight?.abort();
    const controller = new AbortController();
    this.#inFlight = controller;
    if (this.#input) this.#input.value = "";
    if (this.#send) this.#send.disabled = true;

    this.#addMessage("user", question);
    const reply = this.#addMessage("assistant", "");
    reply.setAttribute("aria-busy", "true");

    let answer = "";
    let resources: Record<string, RetrievedResource> = {};
    let citations: Record<string, unknown> = {};
    try {
      for await (const item of await this.#stream(config, question, controller.signal)) {
        if (item.type === "answer") {
          answer += item.text;
          reply.textContent = answer;
        } else if (item.type === "retrieval") resources = item.resources;
        else if (item.type === "citations") citations = item.citations;
        else if (item.type === "error") throw new Error(item.error);
      }
      if (!answer) reply.textContent = "Sorry, I couldn't find an answer to that on this site.";
      else if (config.settings.showSources) this.#appendSources(reply, resources, citations);
      this.#history = [...this.#history, { author: "USER" as const, text: question }, { author: "NUCLIA" as const, text: answer }].slice(
        -HISTORY_TURNS,
      );
    } catch (err) {
      if (controller.signal.aborted) return;
      console.warn("[arag-chat] answer failed:", err);
      reply.textContent = answer || "Something went wrong. Please try again.";
    } finally {
      reply.removeAttribute("aria-busy");
      if (this.#inFlight === controller && this.#send) this.#send.disabled = false;
    }
  }

  // Streams /ask with the session token, refreshing it once if Agentic RAG rejects it.
  async #stream(config: PublicWidgetConfig, question: string, signal: AbortSignal): Promise<AsyncGenerator<AskStreamItem>> {
    const body = JSON.stringify({
      query: question,
      search_configuration: config.searchConfig,
      chat_history: this.#history,
      show: ["basic", "origin"],
    });
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await this.#session!.get();
      const res = await fetch(`${token.askUrl}?eph-token=${encodeURIComponent(token.token)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        signal,
      });
      if ((res.status === 401 || res.status === 403) && attempt === 0) {
        this.#session!.invalidate();
        continue;
      }
      if (!res.ok || !res.body) throw new Error(`/ask returned ${res.status}`);
      return readAskStream(res.body);
    }
    throw new Error("/ask rejected a fresh token");
  }

  #appendSources(reply: HTMLElement, resources: Record<string, RetrievedResource>, citations: Record<string, unknown>) {
    const sources = sourcesFor(resources, citations);
    if (!sources.length) return;
    const list = el("ul", { class: "sources", part: "sources", "aria-label": "Sources" });
    for (const s of sources) list.append(el("li", {}, el("a", { href: s.href, target: "_top", part: "source" }, s.title)));
    reply.append(list);
  }
}
