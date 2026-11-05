// <arag-chat deployment="…" base-url="https://console.partner.example" language="es"></arag-chat>
//
// Loads its config from the partner's console, then talks to Agentic RAG directly with a
// session token. Nothing from the network is parsed as HTML: answers are rendered from a safe
// markdown subset with DOM calls (markdown.ts), everything else is set with textContent.
//
// The config's mode decides the layout (see WIDGET_MODES). Embedded, chat and popup render
// where the element is placed; floating pins itself to a corner wherever it is. Any page
// element with data-arag-chat-open opens the chat, e.g. an "Ask us" link in the site's nav.
//
// Replies with nothing relevant behind them, and replies that say something asked about is missing
// or over without giving anything of the kind asked for ("The information we have does not
// provide cleaning steps"), count as no answer by the shared verdict (verdict.ts in
// @launchpad/theme), and offer the handoff to a person: contact links and an in-chat contact form,
// wherever the deployment chooses. A cited reply whose figures, dates, links or steps stand in the
// paragraphs it cites is an answer whatever its relevance score (grounding, #verdictOf). So does
// an answer to check (very short, or its pages don't match the question) that tells the visitor
// to contact the team get the handoff. Never when a contact or quote button is already under the
// reply: one way to reach the team, not two. The reply's own words stay as written. An intent
// question (price, buy, trial, events, support, contact) is asked with its intent's saved
// configuration, of its pages, first (route.ts); where the KB holds pages in several languages, a
// question is asked of the pages in its own language first; a reply with no answer is asked once
// more with the deployment's own configuration, across every page and without the conversation
// (#ask). Answers carry up to
// two source links that fit them (sources.ts), call-to-action buttons matched to them, and
// thumbs. The conversation is kept for the tab (store.ts), so it follows the visitor from page to
// page. Chat events go to the site's analytics, with the verdict as `answered`, and to the
// console, which also gets each question as it's asked (analytics.ts).
//
// The widget stays off pages the deployment excludes and out of Sitefinity's page editor
// (page.ts), and says in the browser console why when it can't load (load.ts). On a domain
// added minutes ago, which Agentic RAG hasn't applied yet, a question gets "Almost ready" and
// Try again rather than "Something went wrong" (session.ts).
//
// The header always shows the chat's name: when it and the "Talk to a person" label don't both
// fit (a wide logo, a long name, German), the button keeps only its icon, still named and with
// a tooltip, and only then does a long name end in an ellipsis (#fitHeader).

import { type AskStreamItem, type RetrievedResource, readAskStream } from "@launchpad/par-client/ask-stream";
import {
  answerChecks,
  askedKind,
  COPY_KEYS,
  DEFAULT_HANDOFF_PLACES,
  detectLanguage,
  englishStrings,
  groundedContent,
  type HandoffPlace,
  hasConcreteDetail,
  isAnswered,
  isPriceWord,
  type Language,
  type LinkContext,
  linkFor,
  localizeSettings,
  type PublicTokenResponse,
  type PublicWidgetConfig,
  pageLanguages,
  questionHash,
  questionIntents,
  resolveLanguage,
  retrievalLanguage,
  tellsToContact,
  toCssVariables,
  type WidgetCta,
  type WidgetMode,
  type WidgetStrings,
  widgetMode,
} from "@launchpad/theme";
import { type ChatEvent, consoleEvent, EventBatch, type EventParams, newConversationId, track } from "./analytics.ts";
import { type Attribution, captureAttribution } from "./attribution.ts";
import { type LeadBody, type LeadValues, leadBody, leadFields, sendLead, validateLead } from "./lead.ts";
import { barHeight } from "./lift.ts";
import { contactType, linkHref, linkTarget, matchCtas, reachesTeam, sameSite, waysToTeam } from "./links.ts";
import { explain, loadConfig, UNPUBLISHED } from "./load.ts";
import { parseMarkdown, renderMarkdown } from "./markdown.ts";
import { editorSignals, inSitefinityEditor, pathMatches } from "./page.ts";
import { deniesListedPrice, priceReplacement } from "./prices.ts";
import { datelessEvent, pagesFilter, routedIntent, staysInLanguage } from "./route.ts";
import { fetchOnline, fetchToken, LockPending, originRefused, StatusCheck, TokenSession, Unavailable } from "./session.ts";
import {
  bestScore,
  citedPassages,
  citedSources,
  mayBeNoContext,
  pickSources,
  type Source,
  safeHref,
  showsModelText,
  type Verdict,
  verdict,
} from "./sources.ts";
import { ConversationStore, type StoredReply, type Turn } from "./store.ts";
import { ShadowStyles } from "./styles.ts";

type Settings = PublicWidgetConfig["settings"] & { offlineMessage?: string };

// Follow-up questions carry this many previous turns as chat_history.
const HISTORY_TURNS = 6;

// An answer stream with nothing new for this long has stalled: it's cut, and Try again offered.
const STALL_MS = 20_000;

// Follow the stream only while the visitor is within this many pixels of the newest text.
const FOLLOW_SLACK = 48;

// Phones, where floating and popup fill the screen and the page behind mustn't scroll. There
// the floating panel opens as a modal dialog: the page behind is inert and Tab stays inside.
const FULL_SCREEN = "(max-width: 480px)";

// What Tab cycles through in a modal.
const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select, [tabindex]:not([tabindex="-1"])';

// Deployments already announced as waiting for sign-off, so the page's console says it once.
const waiting = new Set<string>();

// Icons are drawn with DOM calls, so no markup string is parsed (some pages forbid it).
const ICONS = {
  chat: "M4 4h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-5 4v-4H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z",
  search: "M18 11a7 7 0 1 1-14 0a7 7 0 0 1 14 0z|m20 20-3.5-3.5",
  up: "M7 10v12|M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88z",
  down: "M17 14V2|M9 18.12 10 14H4.17a2 2 0 0 1-1.92-2.56l2.33-8A2 2 0 0 1 6.5 2H20a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2.76a2 2 0 0 0-1.79 1.11L12 22a3.13 3.13 0 0 1-3-3.88z",
  person: "M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2|M16 7a4 4 0 1 1-8 0a4 4 0 0 1 8 0z",
};

function icon(name: keyof typeof ICONS, filled = false): SVGSVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  const attrs: Record<string, string> = filled
    ? { viewBox: "0 0 24 24", fill: "currentColor" }
    : {
        viewBox: "0 0 24 24",
        fill: "none",
        stroke: "currentColor",
        "stroke-width": "2",
        "stroke-linecap": "round",
        "stroke-linejoin": "round",
      };
  for (const [name, value] of Object.entries({ ...attrs, "aria-hidden": "true", focusable: "false" })) svg.setAttribute(name, value);
  for (const d of ICONS[name].split("|")) svg.appendChild(document.createElementNS(ns, "path")).setAttribute("d", d);
  return svg;
}

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

// Settings read only when a question is asked or when restyling: changing them in the
// configurator's preview keeps the conversation on screen.
const LIVE_SETTINGS = new Set(["ctas", "analytics", "customCss", "showSources", "feedback", "exclude", "liftAboveBars"]);

export interface PreviewOptions {
  fetchToken: () => Promise<PublicTokenResponse>;
  // Show the floating panel, without taking focus from the configurator's fields.
  open?: boolean;
  // The customer's site, so its links count as same-site in the preview.
  siteUrl?: string;
  // Stands in for posting a lead to the console.
  submitLead?: (body: LeadBody) => Promise<void>;
  // A still of one part of the floating panel (or of the layout's own top), in the page flow
  // at the element's width, for the console's own pages: "header" for Confirm brand, "starters"
  // for the welcome and starter buttons. Nothing in it can be clicked or focused.
  snapshot?: "header" | "starters";
  // The screen it stands for: a phone's panel has no border.
  device?: "desktop" | "phone";
}

// Showing its offline message, the chat asks the console again this often while the page is in
// view, and when the visitor opens it.
const OFFLINE_RECHECK_MS = 30_000;

// How a question is asked: of the pages in one language, or all; with the conversation, or not;
// and for an intent question, with its intent's configuration and of its pages (route.ts).
interface Attempt {
  language?: Language;
  history: Turn[];
  intent?: string;
}

// What one ask brought back.
interface Collected {
  answer: string;
  status?: string;
  resources: Record<string, RetrievedResource>;
  citations?: Record<string, unknown>;
  // The cited paragraphs with their neighbours, as the model read them (augmented_context).
  augmented: Record<string, { text?: unknown }>;
}

export class AragChat extends HTMLElement {
  readonly #root = this.attachShadow({ mode: "open" });
  readonly #styles = new ShadowStyles(this.#root);
  #config: PublicWidgetConfig | undefined;
  // The config's settings in the visitor's language (localizeSettings).
  #settings: Settings | undefined;
  #session: TokenSession | undefined;
  #history: Turn[] = [];
  #replies: StoredReply[] = [];
  #conversationId = newConversationId();
  #inFlight: AbortController | undefined;
  #mode: WidgetMode = "floating";
  #language: Language = "en";
  #text: WidgetStrings = englishStrings;
  #layout = "";
  // The floating panel: a <dialog>, non-modal on desktops and modal on phones.
  #dialog: HTMLDialogElement | undefined;
  #launcher: HTMLButtonElement | undefined;
  #modal: HTMLDialogElement | undefined;
  #log: HTMLElement | undefined;
  #input: HTMLTextAreaElement | undefined;
  #send: HTMLButtonElement | undefined;
  #announcer: HTMLElement | undefined;
  #base: string | undefined;
  #events: EventBatch | undefined;
  #store: ConversationStore | undefined;
  #status: StatusCheck | undefined;
  #attribution: Attribution | undefined;
  #preview: PreviewOptions | undefined;
  #siteHosts: string[] = [];
  #openedInPage = false;
  #unlockScroll: (() => void) | undefined;
  #liftTimer: ReturnType<typeof setInterval> | undefined;
  #lift = -1;
  #violations: string[] = [];
  #ids = 0;
  // The header with a "Talk to a person" button, kept fitting by #fitHeader.
  #header: HTMLElement | undefined;
  #headerObserver: ResizeObserver | undefined;
  #headerWidth = -1;
  // Rendered offline (paused, or over budget), and the timer that asks whether that's over.
  #offline = false;
  #statusTimer: ReturnType<typeof setInterval> | undefined;
  // Phone-sized or not: crossing it with the panel open switches the panel's form.
  #screen: MediaQueryList | undefined;

  connectedCallback() {
    document.addEventListener("click", this.#onPageClick);
    document.addEventListener("securitypolicyviolation", this.#onViolation);
    document.addEventListener("visibilitychange", this.#onHide);
    addEventListener("pagehide", this.#onHide);
    // The site's web fonts often arrive after the chat renders, and widen its name.
    document.fonts?.addEventListener("loadingdone", this.#fitHeader);
    if (this.#header) this.#headerObserver?.observe(this.#header);
    this.#screen ??= matchMedia(FULL_SCREEN);
    this.#screen.addEventListener("change", this.#onScreenChange);
    if (!this.#config) void this.#load();
  }

  disconnectedCallback() {
    document.removeEventListener("click", this.#onPageClick);
    document.removeEventListener("securitypolicyviolation", this.#onViolation);
    document.removeEventListener("visibilitychange", this.#onHide);
    removeEventListener("pagehide", this.#onHide);
    this.#inFlight?.abort();
    this.#events?.flush(true);
    this.#lockScroll(false);
    this.#watchBars(false);
    this.#watchStatus(false);
    document.fonts?.removeEventListener("loadingdone", this.#fitHeader);
    this.#headerObserver?.disconnect();
    this.#screen?.removeEventListener("change", this.#onScreenChange);
  }

  // Floating opens its panel and popup its modal; embedded and chat move focus to the input.
  open() {
    if (this.#mode === "floating") this.#toggle(true);
    else if (this.#mode === "popup" && this.#modal && !this.#modal.open) {
      this.#modal.showModal();
      this.#lockScroll(true);
      this.#track("arag_chat_open");
    }
    this.#input?.focus();
  }

  close() {
    if (this.#mode === "floating") this.#toggle(false);
    else this.#modal?.close();
  }

  // The console's widget configurator: renders a config it supplies instead of loading one,
  // and answers through its fetchToken. A change that only affects the look restyles in
  // place, so the conversation stays on screen while colors are tweaked. Nothing is stored
  // and no events reach the console.
  preview(config: PublicWidgetConfig, options: PreviewOptions) {
    this.#config = config;
    this.#preview = options;
    this.#siteHosts = options.siteUrl ? [new URL(options.siteUrl).host] : [];
    this.#session = new TokenSession(options.fetchToken);
    if (options.device) this.dataset.device = options.device;
    else delete this.dataset.device;
    if (this.#layout === this.#layoutKey(config)) return this.#restyle(config);
    this.#inFlight?.abort();
    this.#history = [];
    this.#replies = [];
    this.#conversationId = newConversationId();
    this.#render(config, options.open);
  }

  // data-arag-chat-open="" opens any chat on the page; a deployment id picks one.
  readonly #onPageClick = (e: MouseEvent) => {
    const opener = e.target instanceof Element ? e.target.closest("[data-arag-chat-open]") : null;
    const wanted = opener?.getAttribute("data-arag-chat-open");
    if (!opener || !this.#config || this.#preview?.snapshot || (wanted && wanted !== this.getAttribute("deployment"))) return;
    e.preventDefault();
    this.open();
  };

  readonly #onViolation = (e: Event) => {
    const blocked = (e as SecurityPolicyViolationEvent).blockedURI;
    if (blocked) this.#violations.push(blocked);
  };

  // A phone rotated, or a window narrowed past phone width (or widened back), with the panel
  // open: it takes the other form, modal full screen or the panel above the chat button, with
  // the conversation and the keyboard where they were.
  readonly #onScreenChange = () => {
    if (!this.#dialog?.open || this.#preview) return;
    const focused = this.#root.activeElement;
    this.#showPanel();
    this.#lockScroll(false);
    this.#lockScroll(true);
    if (focused instanceof HTMLElement && this.#dialog.contains(focused)) focused.focus();
    else this.#input?.focus();
  };

  // Events still queued go with the beacon when the visitor leaves or hides the page. Back in
  // view, an offline chat asks whether it's back.
  readonly #onHide = (e: Event) => {
    if (e.type === "pagehide" || document.visibilityState === "hidden") this.#events?.flush(true);
    else void this.#recheck();
  };

  async #load() {
    const deployment = this.getAttribute("deployment");
    if (!deployment || inSitefinityEditor(editorSignals())) return;
    const base = (this.getAttribute("base-url") ?? location.origin).replace(/\/$/, "");
    const loaded = await loadConfig(base, deployment);
    if ("unpublished" in loaded) {
      if (!waiting.has(deployment)) console.info(UNPUBLISHED);
      waiting.add(deployment);
      return;
    }
    if ("failure" in loaded) {
      console.error(explain(loaded.failure, base, deployment));
      return;
    }
    const { config } = loaded;
    // The visit's first page and campaign tags, kept for the tab in case a lead is sent later.
    this.#attribution = captureAttribution(location.href, document.referrer);
    // The editor's markers can appear after the script runs; check again before showing up.
    if (pathMatches(location.pathname, config.settings.exclude ?? []) || inSitefinityEditor(editorSignals())) return;
    this.#base = base;
    this.#status = new StatusCheck(config.online, () => fetchOnline(base, deployment));
    this.#events = new EventBatch(`${base}/api/public/deployments/${encodeURIComponent(deployment)}/events`);
    this.#store = new ConversationStore(deployment);
    const saved = config.online ? this.#store.load() : undefined;
    if (saved) {
      this.#conversationId = saved.id;
      this.#replies = saved.replies;
      this.#history = saved.history;
    }
    this.#config = config;
    this.#session = new TokenSession(() => fetchToken(base, deployment));
    this.#render(config, saved?.open);
  }

  #layoutKey(config: PublicWidgetConfig): string {
    const settings = Object.entries(config.settings).filter(([k]) => !LIVE_SETTINGS.has(k));
    return JSON.stringify([config.online, config.offlineMessage, this.getAttribute("language"), settings]);
  }

  // Read by the stylesheet, and by partners' CSS: arag-chat[data-finish="gloss"] { … }
  #restyle(config: PublicWidgetConfig) {
    const { theme } = config;
    this.#settings = localizeSettings(config.settings, this.#language, config.offlineMessage);
    this.dataset.finish = theme.finish.style;
    this.dataset.position = theme.launcher.position;
    this.#styles.set(toCssVariables(theme), config.settings.customCss ?? "");
    this.#watchBars(widgetMode(config.settings.mode) === "floating" && config.settings.liftAboveBars !== false && !this.#preview?.snapshot);
    // A new font or size changes what fits in the header.
    this.#fitHeader();
  }

  #render(config: PublicWidgetConfig, open = false) {
    this.#layout = this.#layoutKey(config);
    const mode = widgetMode(config.settings.mode);
    this.#mode = mode;
    // Read by the stylesheet, and by partners' CSS: arag-chat[data-mode="chat"] { … }
    this.dataset.mode = mode;
    const preferred = pageLanguages(this.getAttribute("language"), document.documentElement.lang, navigator.languages);
    const language = resolveLanguage(config.settings.language, preferred, config.settings.languages ?? []);
    this.#language = language;
    this.#restyle(config);
    const settings = this.#settings!;
    const t = this.#strings(settings, config.strings?.[language] ?? englishStrings);
    this.#text = t;

    const title = settings.nickname ?? t.title;
    const dismissible = mode === "floating" || mode === "popup";
    const avatar = this.#avatar(settings);
    const close = el("button", { class: "close", part: "close", type: "button", "aria-label": t.closeChat }, "×");
    const talk = config.online && this.#handoffAt("header") ? [this.#talkButton()] : [];
    const header = el(
      "div",
      { class: "header", part: "header" },
      el("span", { class: "title", part: "title" }, ...avatar, el("span", { class: "name", part: "name" }, title)),
      ...talk,
      ...(dismissible ? [close] : []),
    );
    this.#offline = !config.online;
    this.#watchStatus(this.#offline && !this.#preview);
    this.#log = el("div", { class: "log", part: "log" });
    // Streamed text isn't announced as it arrives; each finished reply is, once, from here.
    this.#announcer = el("div", { class: "sr-only", "aria-live": "polite", "aria-atomic": "true" });
    // The popup's <dialog> carries the label; floating is a <dialog> of its own, modal only on
    // phones; the rest are regions. A console still is a plain section, out of reach.
    const snapshot = this.#preview?.snapshot;
    const panel: HTMLElement = el(mode === "floating" && !snapshot ? "dialog" : "section", {
      class: snapshot ? `panel snapshot only-${snapshot}${mode === "embedded" ? " embedded" : ""}` : `panel ${mode}`,
      part: "panel",
      ...(mode === "popup" ? {} : { "aria-label": title }),
    });
    if (snapshot) panel.inert = true;
    this.#dialog = panel instanceof HTMLDialogElement ? panel : undefined;
    if (mode === "embedded" || mode === "chat") {
      // Always on screen, so "open" is the first time the visitor steps into it.
      panel.addEventListener("focusin", () => {
        if (this.#openedInPage) return;
        this.#openedInPage = true;
        this.#track("arag_chat_open");
      });
    }

    const greeting = config.online ? (settings.welcome ?? t.welcome) : (settings.offlineMessage ?? t.offline);
    const form = config.online ? this.#form(settings, mode === "embedded" ? t.ask : t.send) : undefined;
    // Offline: the message alone, without the form, disclosure or credit.
    const controls = form ? [form] : [];
    const notes: HTMLElement[] = [];
    if (form) {
      const privacy = safeHref(settings.privacyUrl);
      const link = privacy ? [" ", el("a", { href: privacy, target: "_blank", rel: "noopener", part: "privacy" }, t.privacy)] : [];
      notes.push(el("p", { class: "disclosure", part: "disclosure" }, settings.disclosure ?? t.disclosure, ...link));
      if (settings.poweredBy) notes.push(el("p", { class: "powered-by", part: "powered-by" }, t.poweredBy));
    }
    if (mode === "embedded") {
      // An ask box: the greeting introduces it and answers appear underneath. With no header,
      // the handoff's header place is under the intro.
      const contact = talk.length ? [this.#handoffCard("header")] : [];
      panel.append(el("p", { class: "intro", part: "intro" }, ...avatar, greeting), ...contact, ...controls, this.#log, ...notes);
    } else {
      this.#log.append(el("div", { class: "message assistant", part: "message assistant" }, greeting));
      panel.append(header, this.#log, ...controls, ...notes);
    }
    panel.append(this.#announcer);
    if (config.online) {
      // A conversation from an earlier page of the site; embedded shows its last answer.
      const shown = mode === "embedded" ? this.#replies.slice(-1) : this.#replies;
      for (const reply of shown) this.#showReply(reply);
      if (!this.#replies.length && settings.starters?.length) this.#log.append(this.#starters(settings.starters));
    }

    const children: Node[] = [...this.#styles.elements];
    if (snapshot) {
      this.#launcher = undefined;
      children.push(panel);
    } else if (mode === "floating") {
      panel.id = "panel";
      this.#launcher = el("button", {
        class: "launcher",
        part: "launcher",
        type: "button",
        "aria-label": `${open ? t.close : t.open} ${title}`,
        "aria-expanded": String(open),
        "aria-controls": "panel",
      });
      this.#launcher.append(icon("chat", true));
      this.#launcher.addEventListener("click", () => this.#toggle());
      close.addEventListener("click", () => this.#toggle(false));
      panel.addEventListener("keydown", (e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          this.#toggle(false);
        } else if (panel.getAttribute("aria-modal") === "true") this.#trapTab(e, panel);
      });
      // The modal's own Escape, and a phone's back gesture.
      panel.addEventListener("cancel", (e) => {
        e.preventDefault();
        this.#toggle(false);
      });
      children.push(this.#launcher, panel);
    } else if (mode === "popup") {
      // A modal <dialog> sits in the top layer, above any z-index on the page, and brings
      // Escape and focus return with it; Tab is kept inside (#trapTab).
      const modal = el("dialog", { class: "modal", part: "modal", "aria-label": title }, panel);
      modal.addEventListener("click", (e) => {
        if (e.target === modal) modal.close(); // a click on the backdrop
      });
      modal.addEventListener("keydown", (e) => this.#trapTab(e, modal));
      modal.addEventListener("close", () => this.#lockScroll(false));
      close.addEventListener("click", () => modal.close());
      this.#modal = modal;
      const trigger = el("button", { class: "trigger", part: "trigger", type: "button", "aria-haspopup": "dialog" });
      trigger.append(
        icon("search"),
        el("span", { class: "trigger-text" }, settings.placeholder ?? t.placeholder),
        el("span", { class: "trigger-cta", part: "trigger-cta", "aria-hidden": "true" }, t.ask),
      );
      trigger.addEventListener("click", () => this.open());
      children.push(trigger, modal);
    } else {
      children.push(panel);
    }
    // Screen readers pronounce the widget in its own language, whatever the page's is.
    for (const child of children) if (child instanceof HTMLElement && !(child instanceof HTMLStyleElement)) child.lang = language;
    this.#root.replaceChildren(...children);
    if (open && this.#dialog) {
      this.#showPanel();
      if (!this.#preview) this.#lockScroll(true);
    }
    this.#lift = -1;
    this.#measureBars();
    this.#observeHeader(mode !== "embedded" && talk.length ? header : undefined);
  }

  // Keeps the header fitting as its width changes (the panel opening, a window resized), and
  // once the avatar has loaded and so has a width.
  #observeHeader(header: HTMLElement | undefined) {
    this.#headerObserver?.disconnect();
    this.#header = header;
    this.#headerWidth = -1;
    if (!header || typeof ResizeObserver === "undefined") return;
    // Only a new width calls for a new fit: the fit itself never changes the header's size.
    this.#headerObserver ??= new ResizeObserver((entries) => {
      const width = Math.round(entries.at(-1)?.contentRect.width ?? 0);
      if (width === this.#headerWidth) return;
      this.#headerWidth = width;
      this.#fitHeader();
    });
    this.#headerObserver.observe(header);
    header.querySelector("img")?.addEventListener("load", this.#fitHeader);
  }

  // The name first: the button shows its label only while the name fits in full beside it.
  // Compact, the button is its icon (named by the hidden label, with a tooltip), and a name too
  // long even then ends in an ellipsis, never narrower than a few letters (styles.ts).
  readonly #fitHeader = () => {
    const header = this.#header;
    if (!header?.isConnected || !header.querySelector(".talk")) return;
    header.classList.remove("compact");
    const squeezed = [".title", ".name"].some((selector) => {
      const part = header.querySelector(selector);
      return part !== null && part.scrollWidth > part.clientWidth + 1;
    });
    header.classList.toggle("compact", squeezed);
  };

  // Asks the console every 30 s while the chat shows its offline message.
  #watchStatus(on: boolean) {
    clearInterval(this.#statusTimer);
    this.#statusTimer = on ? setInterval(() => void this.#recheck(), OFFLINE_RECHECK_MS) : undefined;
  }

  // Offline, and the page in view: when the console says the chat is back (Resume), it renders
  // again with the question box and the conversation it had, panel open or closed as it was.
  async #recheck() {
    const config = this.#config;
    if (!this.#offline || !config || !this.#status || this.#preview || document.hidden) return;
    if (!(await this.#status.online(5_000)) || !this.#offline) return;
    this.#config = { ...config, online: true };
    if (!this.#replies.length) {
      const saved = this.#store?.load();
      if (saved) {
        this.#conversationId = saved.id;
        this.#replies = saved.replies;
        this.#history = saved.history;
      }
    }
    const open = this.#dialog?.open;
    this.#render(this.#config, open);
    if (open || this.#modal?.open) this.#input?.focus();
  }

  // Tab and Shift+Tab wrap around inside a modal, so focus never reaches the page (or the
  // browser's own controls) behind it.
  #trapTab(e: KeyboardEvent, modal: HTMLElement) {
    if (e.key !== "Tab") return;
    const items = Array.from(modal.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((x) => x.getClientRects().length > 0);
    const [first, last] = [items[0], items.at(-1)];
    if (!first || !last) return;
    const active = this.#root.activeElement;
    const outside = !active || !modal.contains(active);
    if (e.shiftKey && (active === first || outside)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (active === last || outside)) {
      e.preventDefault();
      first.focus();
    }
  }

  // The floating panel: modal full screen on a phone, with the chat button hidden behind it;
  // a non-modal panel above the button elsewhere, and always in the console's preview.
  #showPanel() {
    const dialog = this.#dialog;
    if (!dialog?.isConnected) return;
    const modal = !this.#preview && matchMedia(FULL_SCREEN).matches;
    if (dialog.open) dialog.close();
    if (modal) {
      dialog.showModal();
      dialog.setAttribute("aria-modal", "true");
      if (this.#launcher) this.#launcher.hidden = true;
    } else {
      // Not show(): that would move focus, and the preview mustn't take it from the console.
      dialog.setAttribute("open", "");
      dialog.removeAttribute("aria-modal");
      if (this.#launcher) this.#launcher.hidden = false;
    }
  }

  #hidePanel() {
    this.#dialog?.close();
    this.#dialog?.removeAttribute("aria-modal");
    if (this.#launcher) this.#launcher.hidden = false;
  }

  // Keeps the chat button above a fixed bar along the bottom of the window (a cookie bar, a
  // bottom menu): checked every second, and just after the visitor clicks or the window
  // resizes, so it moves back down soon after the bar closes.
  #watchBars(on: boolean) {
    if (!on) {
      clearInterval(this.#liftTimer);
      this.#liftTimer = undefined;
      removeEventListener("resize", this.#measureBars);
      document.removeEventListener("click", this.#soon, true);
      if (this.#lift > 0) this.#setLift(0);
      return;
    }
    if (this.#liftTimer) return;
    this.#liftTimer = setInterval(this.#measureBars, 1000);
    addEventListener("resize", this.#measureBars);
    document.addEventListener("click", this.#soon, true);
    this.#measureBars();
  }

  readonly #soon = () => {
    setTimeout(this.#measureBars, 400);
    setTimeout(this.#measureBars, 1200);
  };

  readonly #measureBars = () => {
    const launcher = this.#launcher;
    if (!this.#liftTimer || !launcher?.isConnected || launcher.hidden || document.hidden) return;
    // Where the button would be without a lift: its own column, at the bottom of the window.
    const r = launcher.getBoundingClientRect();
    this.#setLift(barHeight(this, [r.left + 4, r.left + r.width / 2, r.right - 4]));
  };

  #setLift(px: number) {
    if (px === this.#lift) return;
    this.#lift = px;
    // On the shadow root's own elements: the page's DOM is left alone.
    for (const node of [this.#launcher, this.#dialog]) node?.style.setProperty("--arag-chat-lift", `${px}px`);
  }

  // The language's text, with the partner's rewording of it.
  #strings(settings: Settings, base: WidgetStrings): WidgetStrings {
    const t = { ...base };
    for (const key of COPY_KEYS) {
      const value = settings.copy?.[key]?.trim();
      if (value) t[key] = value;
    }
    return t;
  }

  // The site's logo or icon, if it loads; a broken image would look worse than none. An inline
  // SVG logo comes as a data: URL, which an <img> renders without running anything.
  #avatar(settings: Settings): HTMLImageElement[] {
    const data = /^data:image\/(svg\+xml|png|jpeg|webp|gif)[;,]/.test(settings.avatar ?? "") ? settings.avatar : undefined;
    const src = safeHref(settings.avatar) ?? data;
    if (!src) return [];
    const img = el("img", { class: "avatar", part: "avatar", src, alt: "" });
    img.addEventListener("error", () => img.remove());
    return [img];
  }

  // consoleOnly goes to the console's batch alone, never to the page or its analytics.
  #track(name: ChatEvent, params: EventParams = {}, consoleOnly: EventParams = {}) {
    if (!this.#config) return;
    const fields = { conversation_id: this.#conversationId, ...params };
    track(this, this.#config, name, fields);
    const event = consoleEvent(name, { ...fields, ...consoleOnly });
    if (event) this.#events?.add(event);
  }

  #announce(text: string) {
    const announcer = this.#announcer;
    if (!announcer) return;
    announcer.textContent = "";
    // A fresh text node after a pause, so the same words twice are still read.
    setTimeout(() => {
      announcer.textContent = text;
    }, 60);
  }

  #save() {
    this.#store?.save({
      id: this.#conversationId,
      replies: this.#replies,
      history: this.#history,
      open: this.#mode === "floating" && this.#dialog?.open === true,
    });
  }

  // Same-site pages, as the page or the customer's site in the preview.
  #onSite(host: string): boolean {
    return [location.host, ...this.#siteHosts].some((h) => sameSite(host, h));
  }

  // A link that opens in place on this site (the conversation follows) or in a new tab.
  #decorate(a: HTMLAnchorElement) {
    const target = this.#preview ? "_blank" : linkTarget(a.href, location.host);
    if (target) a.target = target;
    if (target === "_blank") a.rel = "noopener";
  }

  // A partner-configured link.
  #link(href: string, label: string, part: string): HTMLAnchorElement {
    const a = el("a", { class: part, part, href }, label);
    this.#decorate(a);
    return a;
  }

  #leadOn(): boolean {
    return Boolean(this.#settings?.lead?.enabled && this.#config?.online);
  }

  #handoffAt(place: HandoffPlace): boolean {
    const handoff = this.#settings?.handoff;
    const show = handoff?.show ?? DEFAULT_HANDOFF_PLACES;
    const contacts = Boolean(handoff?.contacts.some((c) => linkHref(c.url)));
    return (handoff !== undefined || this.#leadOn()) && show.includes(place) && (contacts || this.#leadOn());
  }

  // Contact links, then the contact form's button when the deployment has one.
  #contactLinks(place: HandoffPlace): HTMLElement[] {
    const t = this.#text;
    const links: HTMLElement[] = (this.#settings?.handoff?.contacts ?? []).flatMap((contact) => {
      const href = linkHref(contact.url);
      if (!href) return [];
      const type = contactType(href);
      const label = contact.label?.trim() || (type === "phone" ? t.callUs : type === "email" ? t.emailUs : t.contactPage);
      const a = this.#link(href, label, "contact");
      a.addEventListener("click", () => this.#track("arag_chat_handoff_click", { contact_type: type, placement: place }));
      return [a];
    });
    if (this.#leadOn()) {
      const button = el("button", { type: "button", class: "secondary", part: "lead-button" }, t.leadButton);
      button.addEventListener("click", () => {
        this.#track("arag_chat_handoff_click", { contact_type: "form", placement: place });
        this.#openLead(place);
      });
      links.push(button);
    }
    return links;
  }

  // The intro and every way to reach a person.
  #handoffCard(place: HandoffPlace): HTMLElement {
    const message = this.#settings?.handoff?.message?.trim() || this.#text.handoff;
    return el(
      "div",
      { class: "handoff", part: "handoff" },
      el("p", {}, message),
      el("div", { class: "contacts", part: "contacts" }, ...this.#contactLinks(place)),
    );
  }

  // In the header: adds the contact card to the conversation, or opens the form when that's
  // the only way to reach someone. Its icon shows when the header is short of room, the label
  // then hidden but still its name, and repeated as a tooltip (data-tip).
  #talkButton(): HTMLButtonElement {
    const label = this.#text.talkToPerson;
    const button = el(
      "button",
      { class: "talk", part: "handoff-button", type: "button", "data-tip": label },
      icon("person"),
      el("span", { class: "talk-label" }, label),
    );
    button.addEventListener("click", () => {
      const links = this.#settings?.handoff?.contacts.some((c) => linkHref(c.url));
      if (!links && this.#leadOn()) return this.#openLead("header");
      this.#log?.append(this.#handoffCard("header"));
      this.#scrollLog();
    });
    return button;
  }

  #form(settings: Settings, sendLabel: string): HTMLFormElement {
    const t = this.#text;
    this.#input = el("textarea", { id: "q", class: "input", part: "input", rows: "1", placeholder: settings.placeholder ?? t.placeholder });
    this.#send = el("button", { class: "send", part: "send", type: "submit" }, sendLabel);
    const form = el(
      "form",
      { class: "form", part: "form" },
      el("label", { class: "sr-only", for: "q" }, t.question),
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
    return form;
  }

  #starters(questions: string[]): HTMLElement {
    const starters = el("div", { class: "starters", part: "starters" });
    for (const q of questions) {
      const chip = el("button", { class: "starter", part: "starter", type: "button" }, q);
      chip.addEventListener("click", () => {
        // The chip is about to go: keep the keyboard in the chat, ready for a follow-up.
        this.#input?.focus();
        starters.remove();
        void this.#ask(q, true);
      });
      starters.append(chip);
    }
    return starters;
  }

  #toggle(open = !this.#dialog?.open) {
    if (!this.#dialog || !this.#launcher) return;
    if (open) this.#showPanel();
    else this.#hidePanel();
    if (open) void this.#recheck();
    this.#launcher.setAttribute("aria-expanded", String(open));
    const t = this.#text;
    this.#launcher.setAttribute("aria-label", `${open ? t.close : t.open} ${this.#settings?.nickname ?? t.title}`);
    this.#lockScroll(open);
    if (open) {
      this.#input?.focus();
      this.#track("arag_chat_open");
    } else this.#launcher.focus();
    this.#save();
  }

  // Full screen on a phone: the page behind stays put. Inline overflow is set through the
  // CSSOM, which a page's Content Security Policy allows.
  #lockScroll(on: boolean) {
    if (on && !this.#unlockScroll && matchMedia(FULL_SCREEN).matches) {
      const targets = [document.documentElement, document.body].filter(Boolean);
      const before = targets.map((t) => t.style.overflow);
      for (const t of targets) t.style.overflow = "hidden";
      this.#unlockScroll = () => {
        for (const [i, t] of targets.entries()) t.style.overflow = before[i] ?? "";
      };
    } else if (!on) {
      this.#unlockScroll?.();
      this.#unlockScroll = undefined;
    }
  }

  #addMessage(role: "user" | "assistant", text: string): HTMLElement {
    const message = el("div", { class: `message ${role}`, part: `message ${role}` }, text);
    this.#log?.append(message);
    this.#scrollLog();
    return message;
  }

  // Scrolls the log, never the page. The embedded log doesn't scroll, so this is a no-op there.
  #scrollLog() {
    if (this.#log) this.#log.scrollTop = this.#log.scrollHeight;
  }

  #nearEnd(): boolean {
    const log = this.#log;
    return !log || log.scrollHeight - log.scrollTop - log.clientHeight < FOLLOW_SLACK;
  }

  // Markdown into the answer, with no bracket syntax left (render.ts in @launchpad/theme). A link
  // goes only to a synced page or a button's or contact's target (any page on the client's sites
  // when the synced set sent is capped, or from an older console); one whose target isn't an
  // address goes to the cited page titled like it (`pages`), or stays plain text.
  #paint(body: HTMLElement, markdown: string, hosts: string[], streaming = false, pages: readonly Source[] = []) {
    const follow = this.#nearEnd();
    const config = this.#config;
    const settings = this.#settings;
    const ctx: LinkContext = {
      pagePaths: config?.pagePaths ?? [],
      capped: config?.pagePathsCapped === true || !config?.pagePaths,
      ctaTargets: [...(settings?.ctas ?? []), ...(settings?.handoff?.contacts ?? [])].flatMap((c) => (c.url ? [c.url] : [])),
      hosts: [...this.#siteHosts, location.host, ...hosts],
      pages,
    };
    const blocks = parseMarkdown(markdown, streaming);
    body.replaceChildren(
      renderMarkdown(blocks, document, { allowHref: (h, text) => linkFor(h, text, ctx), onLink: (a) => this.#decorate(a) }),
    );
    if (streaming) {
      const last = body.lastElementChild;
      const at = last?.tagName === "UL" || last?.tagName === "OL" ? (last.lastElementChild ?? last) : (last ?? body);
      at.append(el("span", { class: "cursor", "aria-hidden": "true" }, "▍"));
    }
    if (follow) this.#scrollLog();
  }

  async #ask(question: string, starter = false) {
    const config = this.#config;
    const settings = this.#settings;
    if (!config || !settings || !this.#session) return;
    // Paused since the page loaded: say so instead of asking.
    if (this.#status && !(await this.#status.online())) return this.#goOffline();
    this.#inFlight?.abort();
    const controller = new AbortController();
    this.#inFlight = controller;
    if (this.#input) this.#input.value = "";
    if (this.#send) this.#send.disabled = true;
    const started = Date.now();
    const language = this.#language;
    this.#track("arag_chat_question", { question_length: question.length, starter, language });
    // On its own and at once, so the console knows where it was asked whatever happens next.
    this.#events?.question(this.#conversationId, questionHash(question));

    // Embedded mode shows one answer at a time; the history still carries earlier turns.
    if (this.#mode === "embedded") this.#log?.replaceChildren();
    const asked = this.#addMessage("user", question);
    const body = el("div", { class: "answer", part: "answer" });
    const reply = el("div", { class: "message assistant", part: "message assistant", "aria-busy": "true" }, body);
    this.#log?.append(reply);
    this.#paint(body, "", [], true);

    // In the question's language where the KB holds pages in several (an English question
    // otherwise finds the German page as readily), with the conversation so far; an intent
    // question with its intent's configuration, of its pages (route.ts). A reply with no answer is
    // asked once more with the deployment's own configuration, of every page and without the
    // conversation: Agentic RAG rewrites a follow-up with its history, and the rewrite can miss the
    // page that answers it.
    const filter = retrievalLanguage(question, language, config.contentLanguages ?? []);
    const intents = questionIntents(question);
    const intent = routedIntent(question, config.intentConfigs, () => intents);
    // An intent question (a price, a phone number, a trial) stays with the visitor's language on the
    // second ask too: another market's page gives another market's prices and numbers (round 6,
    // teamleader.eu: French price answers quoted /es/precio, German phone questions got the Spanish
    // support number). Other questions are asked of every page the second time.
    const second: Attempt = { history: [], ...(filter && staysInLanguage(question, intents) && { language: filter }) };
    // A price question, where the deployment has a confirmed price table: the reply is held until
    // it's complete and checked against the table (prices.ts). Other questions stream.
    // With no table confirmed, the pricing page's own rows check it the same way (pricingFacts): a
    // figure another row has, given for this plan, isn't shown (round 7: Kemp's German answers shifted
    // every price by one plan). A price question is held for that, not streamed.
    const table = config.priceTable?.rows.length ? config.priceTable : undefined;
    const facts = table ? undefined : config.pricingFacts?.rows.length ? config.pricingFacts : undefined;
    const hold = Boolean(table ?? facts) && (intents.includes("price") || askedKind(question) === "price");
    const attempts: Attempt[] = [{ language: filter, history: this.#history, ...(intent && { intent }) }];
    if (intent || this.#history.length || filter !== second.language) attempts.push(second);
    // Each ask is a row in the question log: the console counts the question once.
    let asks = 1;
    // A held reply shows nothing but a cursor: after 1.5 s a word, told to a screen reader once.
    let word = "";
    const checking = hold
      ? setTimeout(() => {
          word = this.#text.checkingPrices;
          this.#paint(body, word, [], true);
          this.#announce(word);
        }, 1500)
      : undefined;
    try {
      // A routed ask that fails (its configuration not saved on the KB yet, say) leaves it to the
      // deployment's own configuration.
      const first = await this.#collect(config, question, controller.signal, attempts[0]!, body, hold).catch((err) => {
        if (controller.signal.aborted || !intent) throw err;
        return undefined;
      });
      let got = first;
      let v = first && this.#verdictOf(question, first);
      if ((!v || !isAnswered(v)) && attempts[1]) {
        asks = 2;
        this.#paint(body, word, [], true);
        // A retry that fails leaves the first reply standing.
        const again = await this.#collect(config, question, controller.signal, attempts[1], body, hold).catch((err) => {
          if (controller.signal.aborted || !first) throw err;
          return undefined;
        });
        const second = again && this.#verdictOf(question, again);
        if (again && second && (!v || isAnswered(second))) [got, v] = [again, second];
      }
      clearTimeout(checking);
      if (!got || !v) throw new Error("/ask failed");
      const { answer, resources, citations } = got;
      // The shared verdict: a reply that may not answer (it says something asked about is missing,
      // with nothing of the kind asked for) is no answer, here, in GA and in the report; one that
      // partly answers is an answer.
      const cited = citedSources(resources, citations ?? {});
      // A held price reply that contradicts the confirmed table: the table's rows instead, citing
      // the pricing page (prices.ts). It's an answer.
      // Any question's reply is checked once complete, a streamed one too: what counts as a price
      // question is read from its words, and "What does Premium run yearly?" names no price word.
      const replaced = showsModelText(v) ? priceReplacement(question, answer, table, cited, this.#text, language, facts) : undefined;
      // An answer whose figures, dates, links or steps stand on the pages it cites: its sources show
      // whatever the verdict, and it never gets the handoff card (round 6: a card under an answered
      // support question; a correct "Yes" lost its sources).
      const isGrounded =
        !replaced &&
        showsModelText(v) &&
        groundedContent(answer, citedPassages(resources, citations, got.augmented), { question }).grounded;
      // A reply denying a price the pricing page states, about what was asked: no answer, with the
      // card (round 7, item 4).
      // So does a date question's reply that cites a page stating events and gives no day and month.
      const denies =
        !replaced &&
        showsModelText(v) &&
        (deniesListedPrice(question, answer, table ?? config.pricingFacts, cited, language) ||
          datelessEvent(question, answer, cited, config.eventPages));
      const answered = replaced ? !replaced.pointer : isAnswered(v) && !denies;
      const brand = settings.nickname;
      const sources = !settings.showSources
        ? []
        : replaced
          ? [replaced.source]
          : answered || isGrounded
            ? pickSources(cited, { question, answer, language, brand, resources })
            : [];
      // A reply that sends the visitor to the team without saying how (no link, address, email,
      // phone, or contact page it names, and no contact page among its sources), and is an answer
      // to check (very short, or no page it cites matches the question) or gives nothing concrete
      // ("Contact us to discuss becoming a Sitefinity partner."): the handoff card goes under it,
      // as under a no-answer. It still counts as answered.
      const contacts = (settings.handoff?.contacts ?? []).flatMap((c) => linkHref(c.url) ?? []);
      const toTeam =
        !replaced &&
        answered &&
        !isGrounded &&
        tellsToContact(answer) &&
        !waysToTeam(answer, sources, contacts) &&
        (!hasConcreteDetail(answer) ||
          answerChecks({
            question,
            answer,
            sources: cited.map((s) => ({ title: s.title, text: s.passages.join("\n"), ...(s.language && { language: s.language }) })),
            ...(brand && { brand }),
          }).length > 0);
      const record: StoredReply = {
        question,
        answer: replaced ? replaced.answer : showsModelText(v) ? answer : "",
        answered,
        sources,
        ...(toTeam && { toTeam }),
        ...(replaced && { priced: true, pricingPage: { title: replaced.source.title, href: replaced.source.href } }),
      };
      const hosts = Object.values(resources).flatMap((r) => (safeHref(r.origin?.url) ? [new URL(r.origin!.url!).host] : []));
      this.#showReply(record, reply, hosts);
      this.#track(
        "arag_chat_answer",
        { answered, sources: sources.length, duration_ms: Date.now() - started, language },
        { question_hash: questionHash(question), attempts: asks, origin: location.origin },
      );
      this.#replies.push(record);
      this.#history = [
        ...this.#history,
        { author: "USER" as const, text: question },
        { author: "NUCLIA" as const, text: record.answer },
      ].slice(-HISTORY_TURNS);
      this.#save();
    } catch (err) {
      // A newer question replaced this one: what came stays, without its cursor, and an empty bubble goes.
      if (controller.signal.aborted) {
        body.querySelector(".cursor")?.remove();
        if (!body.textContent?.trim()) {
          asked.remove();
          reply.remove();
        }
        return;
      }
      if (err instanceof Unavailable) {
        // Down for now (round 6: the account blocked for budget): the chat's offline message, and the
        // console hears of the block, for the partner's channel and Fleet.
        this.#track(
          "arag_chat_answer",
          { answered: false, error: true, duration_ms: Date.now() - started, language },
          err.blocked ? { blocked: true } : {},
        );
        this.#events?.flush();
        asked.remove();
        reply.remove();
        return this.#goOffline();
      }
      console.warn("[arag-chat] answer failed:", err);
      this.#explainBlocked();
      this.#failed(reply, asked, question, err instanceof LockPending);
      this.#track("arag_chat_answer", { answered: false, error: true, duration_ms: Date.now() - started, language });
    } finally {
      clearTimeout(checking);
      reply.removeAttribute("aria-busy");
      if (this.#inFlight === controller && this.#send) this.#send.disabled = false;
    }
  }

  // The chat as it is while paused: the offline message, and no question box.
  #goOffline() {
    const config = this.#config;
    if (!config) return;
    this.#render({ ...config, online: false }, this.#dialog?.open);
    this.#announce(this.#settings?.offlineMessage ?? this.#text.offline);
    this.#root.querySelector<HTMLElement>(".close")?.focus();
  }

  // A blocked request to Agentic RAG fails like a dropped connection; say when it's the CSP.
  #explainBlocked() {
    const blocked = this.#violations.find((uri) => /\.(progress\.cloud|nuclia\.cloud)/.test(uri) || uri.startsWith(this.#base ?? " "));
    if (!blocked) return;
    this.#violations = [];
    const origin = /^https?:/.test(blocked) ? new URL(blocked).origin : blocked;
    console.error(
      `[arag-chat] This page's Content Security Policy blocked ${origin}, so answers can't load. Add ${origin} to its connect-src directive.`,
    );
  }

  // The shared verdict on one ask (verdict.ts in @launchpad/theme), from what it brought back: a
  // cited answer whose figures, dates, links or steps stand in the paragraphs it cites shows,
  // whatever its reranker score (round 5: kemptechnologies.com's "What are your prices?" scored
  // 0.0112 and visitors got "Sorry, I couldn't find an answer").
  #verdictOf(question: string, got: Collected): Verdict {
    return verdict({
      ...got,
      best: bestScore(got.resources),
      question,
      language: this.#language,
      ...(got.citations && { passages: citedPassages(got.resources, got.citations, got.augmented) }),
    });
  }

  // One ask, streamed into the reply as it arrives; what came back, for the verdict.
  async #collect(
    config: PublicWidgetConfig,
    question: string,
    signal: AbortSignal,
    attempt: Attempt,
    body: HTMLElement,
    // Held until complete (a price question): only the cursor shows while it streams.
    hold = false,
  ): Promise<Collected> {
    let answer = "";
    let status: string | undefined;
    let resources: Record<string, RetrievedResource> = {};
    let citations: Record<string, unknown> | undefined;
    let augmented: Collected["augmented"] = {};
    // A stream that goes quiet is cut after STALL_MS and counts as failed, so the visitor gets Try
    // again rather than a cursor that never moves (round 6: a Dutch answer sat at "▍" for 93 s).
    const live = new AbortController();
    const stop = () => live.abort();
    signal.addEventListener("abort", stop, { once: true });
    let stalled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const wait = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        stalled = true;
        live.abort();
      }, STALL_MS);
    };
    wait();
    try {
      for await (const item of await this.#stream(config, question, live.signal, attempt)) {
        wait();
        if (item.type === "status") status = item.status;
        // With nothing retrieved, Agentic RAG skips the model and streams a fixed English
        // sentence; the widget says so itself, in the visitor's language.
        else if (item.type === "answer" && status !== "no_retrieval_data") {
          answer += item.text;
          if (!hold && !mayBeNoContext(answer)) this.#paint(body, answer, [], true);
        } else if (item.type === "retrieval") resources = item.resources;
        else if (item.type === "citations") citations = item.citations;
        else if (item.type === "other" && item.itemType === "augmented_context")
          augmented = ((item.raw as { augmented?: { paragraphs?: Collected["augmented"] } }).augmented?.paragraphs ??
            {}) as Collected["augmented"];
        else if (item.type === "error") throw new Error(item.error);
      }
    } catch (err) {
      if (stalled && !signal.aborted) throw new Error(`/ask stalled for ${STALL_MS / 1000} s`);
      throw err;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
    }
    if (stalled && !signal.aborted) throw new Error(`/ask stalled for ${STALL_MS / 1000} s`);
    return { answer, status, resources, citations, augmented };
  }

  // Streams /ask with the session token, refreshing it once if Agentic RAG rejects it.
  async #stream(config: PublicWidgetConfig, question: string, signal: AbortSignal, how: Attempt): Promise<AsyncGenerator<AskStreamItem>> {
    const body = JSON.stringify({
      query: question,
      // The intent's own configuration, else the deployment's. Empty means the KB's own defaults;
      // JSON leaves the field out.
      search_configuration: (how.intent && config.intentConfigs?.[how.intent]) || config.searchConfig || undefined,
      chat_history: how.history,
      // Whether anything was cited is half of telling an answer from a non-answer.
      citations: true,
      show: ["basic", "origin"],
      // Only the pages whose main language is the question's, and an intent's pages; never the
      // agents' generated text while they're on.
      ...pagesFilter(how.language, how.intent, how.intent ? config.intentPages?.[how.intent] : undefined, config.excludeGenerated),
    });
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await this.#session!.get();
      const res = await fetch(`${token.askUrl}?eph-token=${encodeURIComponent(token.token)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        signal,
      }).catch(async (err) => {
        // The console allows this page (it gave the token), so a refusal is the domain lock
        // still on its way to Agentic RAG.
        if (!signal.aborted && !this.#preview && (await originRefused(token.askUrl))) throw new LockPending();
        throw err;
      });
      if ((res.status === 401 || res.status === 403) && attempt === 0) {
        this.#session!.invalidate();
        continue;
      }
      // The partner's Agentic RAG account blocked for budget: the offline message, not an error.
      if (res.status === 402) throw new Unavailable(true);
      if (!res.ok || !res.body) throw new Error(`/ask returned ${res.status}`);
      return readAskStream(res.body);
    }
    throw new Error("/ask rejected a fresh token");
  }

  // A finished reply: the answer (or the no-answer text), source links, call-to-action
  // buttons, the handoff and thumbs. Also shows replies kept from an earlier page.
  #showReply(record: StoredReply, reply?: HTMLElement, hosts: string[] = []) {
    const t = this.#text;
    const restored = !reply;
    const body = reply?.querySelector<HTMLElement>(".answer") ?? el("div", { class: "answer", part: "answer" });
    if (!reply) {
      this.#addMessage("user", record.question);
      reply = el("div", { class: "message assistant", part: "message assistant" }, body);
      this.#log?.append(reply);
    }
    const sourceHosts = record.sources.map((s) => new URL(s.href).host);
    if (record.answer) this.#paint(body, record.answer, [...hosts, ...sourceHosts], false, record.sources);
    else {
      // In the language it was asked in, where this chat has that language's text: on an English page
      // (Review's preview, or a site's) a German question got an English no-answer (round 7).
      const asked = detectLanguage(record.question);
      const own =
        asked && asked !== this.#language ? (asked === "en" ? englishStrings : this.#config?.strings?.[asked])?.noAnswer : undefined;
      body.replaceChildren(el("p", {}, own || t.noAnswer));
    }
    if (record.sources.length) reply.append(this.#sourceList(record.sources));

    const follow = this.#nearEnd();
    const ctas = this.#ctaButtons(record);
    if (ctas.buttons.length) reply.append(el("div", { class: "ctas", part: "ctas" }, ...ctas.buttons));
    // The card under a no-answer, or an answer to check that sends the visitor to the team; not
    // when a contact or quote button is already there.
    const toTeam = !record.answered || record.toTeam === true;
    let handoff: HTMLElement | undefined;
    if (toTeam) {
      if (!ctas.toTeam && this.#handoffAt("no-answer")) handoff = this.#handoffCard("no-answer");
    } else if (this.#handoffAt("after-answer")) {
      handoff = el("p", { class: "still", part: "still-need-help" }, t.stillNeedHelp, ...this.#contactLinks("after-answer"));
    }
    if (handoff) reply.append(handoff);
    // A contact or callback question offers the form, by the question alone, whatever the reply says.
    if (this.#leadOn() && !reply.querySelector("[part=lead-button]") && questionIntents(record.question).includes("contact"))
      reply.append(this.#contactLinks("after-answer").at(-1)!);
    if (record.answered && this.#settings?.feedback !== false) reply.append(this.#thumbs(record));
    if (follow) this.#scrollLog();
    if (!restored) this.#announce([body.textContent, toTeam && handoff ? handoff.firstChild?.textContent : ""].join(" ").trim());
  }

  #sourceList(sources: Source[]): HTMLElement {
    const id = `sources-${++this.#ids}`;
    const list = el("ul", { "aria-labelledby": id });
    for (const s of sources) {
      const host = new URL(s.href).host;
      // Another site's page says so, so nobody is surprised where it leads.
      const domain = this.#onSite(host) ? [] : [el("span", { class: "source-domain" }, host.replace(/^www\./, ""))];
      const link = el("a", { href: s.href, part: "source" }, s.title, ...domain);
      this.#decorate(link);
      link.addEventListener("click", () => this.#track("arag_chat_source_click", { link_url: s.href }));
      list.append(el("li", {}, link));
    }
    return el("div", { class: "sources", part: "sources" }, el("p", { class: "sources-label", id }, this.#text.sources), list);
  }

  // The partner's buttons whose keywords the question, or the answer, mentions, and whether one of
  // them reaches the team already (links.ts reachesTeam).
  #ctaButtons(record: StoredReply): { buttons: HTMLElement[]; toTeam: boolean } {
    const contacts = (this.#settings?.handoff?.contacts ?? []).flatMap((c) => linkHref(c.url) ?? []);
    const shown: WidgetCta[] = [];
    const ctas = this.#settings?.ctas ?? [];
    // A price reply replaced with the table's rows: the pricing or quote button with it, whatever
    // the question's words.
    const priced = record.priced ? ctas.filter((c) => c.keywords.some((k) => k.toLowerCase().split(/\s+/).some(isPriceWord))) : [];
    const buttons = [...new Set([...matchCtas(ctas, record.question, record.answered ? record.answer : ""), ...priced])]
      .slice(0, 2)
      .flatMap((cta): HTMLElement[] => {
        if (cta.action === "lead") {
          if (!this.#leadOn()) return [];
          const button = el("button", { type: "button", class: "cta", part: "cta" }, cta.label);
          button.addEventListener("click", () => {
            this.#track("arag_chat_cta_click", { cta_label: cta.label });
            this.#openLead("cta", cta.label);
          });
          shown.push(cta);
          return [button];
        }
        const href = linkHref(cta.url);
        if (!href) return [];
        const link = this.#link(href, cta.label, "cta");
        link.addEventListener("click", () => this.#track("arag_chat_cta_click", { cta_label: cta.label, link_url: href }));
        shown.push(cta);
        return [link];
      });
    // No pricing or quote button set up: the pricing page itself, which the rows cite (round 7).
    const page = record.priced && !buttons.length ? linkHref(record.pricingPage?.href) : undefined;
    if (page) buttons.push(this.#link(page, record.pricingPage?.title ?? page, "cta"));
    return { buttons, toTeam: shown.some((cta) => reachesTeam(cta, contacts)) };
  }

  // One vote per answer, kept with the conversation; only "up" or "down" leaves the page.
  #thumbs(record: StoredReply): HTMLElement {
    const t = this.#text;
    const thanks = el("span", { class: "feedback-thanks" }, record.vote ? t.feedbackThanks : "");
    const buttons = (["up", "down"] as const).map((value) => {
      const button = el("button", {
        type: "button",
        class: "thumb",
        part: `thumb thumb-${value}`,
        "aria-label": value === "up" ? t.helpful : t.notHelpful,
        "aria-pressed": String(record.vote === value),
        ...(record.vote ? { "aria-disabled": "true" } : {}),
      });
      button.append(icon(value));
      button.addEventListener("click", () => {
        if (record.vote) return;
        record.vote = value;
        for (const b of buttons) {
          b.setAttribute("aria-pressed", String(b === button));
          b.setAttribute("aria-disabled", "true");
        }
        thanks.textContent = t.feedbackThanks;
        this.#announce(t.feedbackThanks);
        this.#track("arag_chat_feedback", { value, answered: true }, { question_hash: questionHash(record.question) });
        this.#save();
      });
      return button;
    });
    return el("div", { class: "feedback", part: "feedback" }, ...buttons, thanks);
  }

  // The question stays; Try again asks it once more. "Almost ready" while Agentic RAG is still
  // applying the site's domain, which a minute or two puts right.
  #failed(reply: HTMLElement, asked: HTMLElement, question: string, pending = false) {
    const t = this.#text;
    const text = pending ? t.almostReady : t.failed;
    reply.querySelector(".answer")?.replaceChildren(el("p", {}, text));
    const retry = el("button", { type: "button", class: "secondary retry", part: "retry" }, t.retry);
    retry.addEventListener("click", () => {
      asked.remove();
      reply.remove();
      this.#input?.focus();
      void this.#ask(question);
    });
    reply.append(retry);
    if (this.#handoffAt("no-answer")) reply.append(this.#handoffCard("no-answer"));
    this.#announce(text);
  }

  // The in-chat contact form, in the conversation. One at a time; the lead records what opened
  // it last (a call-to-action button by its label).
  #openLead(placement: string, ctaLabel?: string) {
    const lead = this.#settings?.lead;
    if (!lead || !this.#log) return;
    this.#leadTrigger = { placement, ctaLabel };
    const open = this.#log.querySelector<HTMLFormElement>("form.lead");
    const form = open ?? this.#leadForm(lead);
    if (!open) this.#log.append(form);
    this.#scrollLog();
    form.querySelector<HTMLElement>("input, textarea")?.focus();
  }

  #leadTrigger: { placement: string; ctaLabel?: string } = { placement: "header" };

  #leadForm(lead: NonNullable<Settings["lead"]>): HTMLFormElement {
    const t = this.#text;
    const id = `lead-${++this.#ids}`;
    const form = el("form", { class: "lead", part: "lead-form", novalidate: "", "aria-labelledby": `${id}-intro` });
    form.append(el("p", { id: `${id}-intro` }, lead.intro?.trim() || t.leadIntro));

    const inputs = new Map<string, HTMLInputElement | HTMLTextAreaElement>();
    const errors = new Map<string, HTMLElement>();
    const errorFor = (key: string, control: HTMLElement) => {
      const message = el("p", { class: "lead-error", id: `${id}-${key}-error`, hidden: "" });
      errors.set(key, message);
      control.setAttribute("aria-describedby", message.id);
      return message;
    };
    const INPUT = { name: ["text", "name"], email: ["email", "email"], phone: ["tel", "tel"] } as const;
    for (const { field, required } of leadFields(lead)) {
      const control =
        field === "message"
          ? el("textarea", { id: `${id}-${field}`, rows: "3" })
          : el("input", { id: `${id}-${field}`, type: INPUT[field][0], autocomplete: INPUT[field][1] });
      if (required) control.setAttribute("aria-required", "true");
      inputs.set(field, control);
      const label = el("label", { for: control.id }, t[field], ...(required ? [] : [" ", el("span", { class: "opt" }, `(${t.optional})`)]));
      form.append(el("div", { class: "lead-field" }, label, control, errorFor(field, control)));
    }

    const consent = el("input", { type: "checkbox", id: `${id}-consent`, "aria-required": "true" });
    // Sent with the lead as the wording the visitor agreed to.
    const consentText = lead.consentText?.trim() || t.consent;
    form.append(el("div", {}, el("label", { class: "check" }, consent, consentText), errorFor("consent", consent)));
    const privacy = safeHref(this.#settings?.privacyUrl);
    if (privacy) form.append(el("p", { class: "lead-privacy" }, el("a", { href: privacy, target: "_blank", rel: "noopener" }, t.privacy)));
    const transcript = lead.transcript !== false && this.#replies.length ? el("input", { type: "checkbox" }) : undefined;
    if (transcript) form.append(el("label", { class: "check" }, transcript, t.includeConversation));

    const submit = el("button", { type: "submit", class: "send" }, t.send);
    const cancel = el("button", { type: "button", class: "link-button" }, t.cancel);
    const status = el("p", { class: "lead-status", role: "status" });
    form.append(el("div", { class: "lead-actions" }, submit, cancel), status);

    cancel.addEventListener("click", () => {
      form.remove();
      this.#input?.focus();
    });
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const values: LeadValues = {};
      for (const [field, control] of inputs) values[field as keyof LeadValues] = control.value;
      const found = validateLead(lead, values, consent.checked);
      for (const [key, message] of errors) {
        const problem = found[key as keyof typeof found];
        message.hidden = !problem;
        message.textContent = problem ? t[problem] : "";
        (key === "consent" ? consent : inputs.get(key))?.setAttribute("aria-invalid", String(Boolean(problem)));
      }
      const first = Object.keys(found)[0];
      if (first) return (first === "consent" ? consent : inputs.get(first))?.focus();

      submit.disabled = true;
      status.textContent = "";
      const turns = this.#replies.flatMap((r): Turn[] => [
        { author: "USER", text: r.question },
        { author: "NUCLIA", text: r.answer || t.noAnswer },
      ]);
      const { placement, ctaLabel } = this.#leadTrigger;
      const body = leadBody(lead, values, {
        conversationId: this.#conversationId,
        transcript: transcript?.checked ? turns : undefined,
        pageUrl: location.href,
        language: this.#language,
        consentText,
        placement,
        ctaLabel,
        attribution: this.#attribution,
      });
      try {
        if (this.#preview) await (this.#preview.submitLead ?? (() => new Promise((r) => setTimeout(r, 300))))(body);
        else await sendLead(this.#base!, this.#config!.deploymentId, body);
        form.replaceWith(el("p", { class: "notice", part: "lead-sent" }, t.leadSent));
        this.#announce(t.leadSent);
        this.#track("arag_chat_lead_submit", { placement, language: this.#language });
        this.#input?.focus();
      } catch (err) {
        console.warn("[arag-chat] contact form failed:", err);
        status.textContent = t.leadFailed;
        submit.disabled = false;
      }
    });
    return form;
  }
}
