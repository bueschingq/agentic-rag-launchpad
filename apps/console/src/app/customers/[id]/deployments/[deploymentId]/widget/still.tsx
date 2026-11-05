"use client";

// Stills of the real widget on the console's own pages: its header as visitors see it, for
// Confirm brand, or its welcome and starter buttons, for the starter picker. arag-chat.js draws
// them itself (preview's snapshot option), in the site's web fonts where their host allows, so
// the console never guesses at the widget's layout: a name that runs into "Talk to a person" on
// the site runs into it here too.

import { allWidgetStrings, type PublicWidgetConfig, type SiteFont, type WidgetMode } from "@launchpad/theme";
import { createElement, useEffect, useRef, useState } from "react";

export type StillPart = "header" | "starters";
export type StillDevice = "desktop" | "phone";

interface AragChat extends HTMLElement {
  preview(config: PublicWidgetConfig, options: { snapshot: StillPart; device: StillDevice; fetchToken: () => Promise<never> }): void;
}

// The widget's own widths: the floating panel on a desktop, and a phone's screen.
export const STILL_WIDTHS: Record<StillDevice, number> = { desktop: 380, phone: 390 };

// Where a layout has least room: the floating panel is narrower on a desktop than on a phone;
// the popup and the in-page layouts are narrowest on a phone.
export const narrowestDevice = (mode: WidgetMode | undefined): StillDevice => (mode === "floating" || !mode ? "desktop" : "phone");

// arag-chat.js, added once to the page.
function useWidgetScript(): boolean {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let live = true;
    if (!customElements.get("arag-chat") && !document.querySelector("script[data-arag-chat-stills]")) {
      const script = Object.assign(document.createElement("script"), { src: "/arag-chat.js", async: true });
      script.dataset.aragChatStills = "";
      document.head.append(script);
    }
    void customElements.whenDefined("arag-chat").then(() => live && setReady(true));
    return () => {
      live = false;
    };
  }, []);
  return ready;
}

// The site's web fonts, loaded into this page once each: the widget uses fonts already on the
// page. The console's own text doesn't name these families, so nothing else changes.
const loaded = new Set<string>();
function useSiteFonts(fonts: SiteFont[]) {
  const key = JSON.stringify(fonts);
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the list's contents.
  useEffect(() => {
    for (const f of fonts) {
      if (loaded.has(f.url)) continue;
      loaded.add(f.url);
      if (f.kind === "stylesheet") {
        document.head.append(
          Object.assign(document.createElement("link"), { rel: "stylesheet", href: f.url, referrerPolicy: "no-referrer" }),
        );
      } else {
        const face = new FontFace(f.family, `url(${JSON.stringify(f.url)})`, { weight: f.weight || "normal", style: f.style || "normal" });
        face.load().then(
          (ready) => document.fonts.add(ready),
          () => undefined,
        );
      }
    }
  }, [key]);
}

interface Props {
  config: PublicWidgetConfig;
  part: StillPart;
  device: StillDevice;
  // For a deployment that follows each visitor's language: the one to draw.
  language?: string;
  fonts?: SiteFont[];
  // What it shows, for the caption and for screen readers (the still itself is inert).
  label: string;
}

export function WidgetStill({ config, part, device, language, fonts = [], label }: Props) {
  const ready = useWidgetScript();
  useSiteFonts(fonts);
  const host = useRef<AragChat>(null);
  useEffect(() => {
    const el = host.current;
    if (!ready || !el) return;
    if (language) el.setAttribute("language", language);
    else el.removeAttribute("language");
    el.preview(
      { ...config, strings: allWidgetStrings() },
      { snapshot: part, device, fetchToken: () => Promise.reject(new Error("A still never asks.")) },
    );
  }, [ready, config, part, device, language]);

  return (
    <figure className="widget-still" style={{ margin: 0 }}>
      <figcaption className="help">{label}</figcaption>
      {/* At the widget's real width, scrolling sideways in a narrow column rather than shrinking;
          keyboard users can focus it to scroll it. */}
      {/* biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling region must take focus to scroll by keyboard (WCAG 2.1.1). */}
      <section style={{ maxWidth: "100%", overflowX: "auto" }} tabIndex={0} aria-label={`${label}, scrolls sideways`}>
        {createElement("arag-chat", {
          ref: host,
          style: { display: "block", width: STILL_WIDTHS[device], minHeight: part === "header" ? 56 : 40 },
        })}
      </section>
    </figure>
  );
}
