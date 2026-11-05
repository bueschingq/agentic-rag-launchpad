"use client";

// The configurator's live preview: a frame holding the real widget over the site's screenshot,
// at desktop size or in a 390×844 phone frame. Each draft is posted into it (same origin only);
// the widget's analytics events, and which of the site's fonts loaded, come back.

import { type Language, languageName, type PublicWidgetConfig } from "@launchpad/theme";
import { useEffect, useRef, useState } from "react";

export type Answers = "sample" | "none" | "live" | "offline";
type Device = "desktop" | "phone";

export interface PreviewEvent {
  name: string;
  [param: string]: unknown;
}

interface Props {
  src: string;
  config: PublicWidgetConfig;
  canAsk: boolean;
  siteUrl: string;
  // With "auto": the languages the site serves, to preview each.
  languages: Language[];
  onEvent: (event: PreviewEvent) => void;
  // The site's fonts the preview couldn't load, if any.
  onFonts: (missing: string[]) => void;
}

const ANSWERS: { value: Answers; label: string }[] = [
  { value: "sample", label: "Sample answer" },
  { value: "none", label: "No answer found" },
  { value: "live", label: "Live from the Knowledge Box" },
  { value: "offline", label: "Offline" },
];

const PHONE = { width: 390, height: 844 };

export function PreviewFrame({ src, config, canAsk, siteUrl, languages, onEvent, onFonts }: Props) {
  const frame = useRef<HTMLIFrameElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  // Counts the frame's ready messages: a new screenshot reloads it, and the new page needs the draft.
  const [loads, setLoads] = useState(0);
  // Bumped by "Reload preview", which remounts the frame.
  const [attempt, setAttempt] = useState(0);
  const [stalled, setStalled] = useState(false);
  const [answers, setAnswers] = useState<Answers>("sample");
  const [device, setDevice] = useState<Device>("desktop");
  const [language, setLanguage] = useState<string>("");
  const [scale, setScale] = useState(1);
  const handlers = useRef({ onEvent, onFonts });
  handlers.current = { onEvent, onFonts };

  // biome-ignore lint/correctness/useExhaustiveDependencies: listens once, for the page's life; hello only reads the frame ref.
  useEffect(() => {
    const listen = (e: MessageEvent) => {
      if (e.origin !== location.origin || e.source !== frame.current?.contentWindow) return;
      if (e.data?.type === "arag-chat-preview-ready") setLoads((n) => n + 1);
      if (e.data?.type === "arag-chat-event") handlers.current.onEvent(e.data.event as PreviewEvent);
      if (e.data?.type === "arag-chat-fonts") handlers.current.onFonts(e.data.missing as string[]);
    };
    addEventListener("message", listen);
    // The frame may have said it was ready before this page hydrated, and that message is lost:
    // ask again. A frame that hasn't run its script yet says so itself when it does.
    hello();
    return () => removeEventListener("message", listen);
  }, []);

  // Nothing heard from the frame: offer a reload rather than an empty preview.
  // biome-ignore lint/correctness/useExhaustiveDependencies: a reload (attempt) restarts the wait.
  useEffect(() => {
    if (loads) {
      setStalled(false);
      return;
    }
    const timer = setTimeout(() => setStalled(true), 5000);
    return () => clearTimeout(timer);
  }, [loads, attempt]);

  // The phone frame shrinks to fit the window's height and the column's width, so a color
  // change shows without scrolling.
  useEffect(() => {
    if (device !== "phone") return;
    const fit = () => {
      const width = stage.current?.clientWidth ?? PHONE.width;
      setScale(Math.min(1, (innerHeight - 220) / PHONE.height, width / PHONE.width));
    };
    fit();
    addEventListener("resize", fit);
    return () => removeEventListener("resize", fit);
  }, [device]);

  // A short pause, so typing a hex color doesn't re-render the widget on every keystroke.
  useEffect(() => {
    if (!loads) return;
    const timer = setTimeout(
      () => frame.current?.contentWindow?.postMessage({ type: "arag-chat-preview", config, answers, language, siteUrl }, location.origin),
      120,
    );
    return () => clearTimeout(timer);
  }, [loads, config, answers, language, siteUrl]);

  const phone = device === "phone";
  function hello() {
    frame.current?.contentWindow?.postMessage({ type: "arag-chat-preview-hello" }, location.origin);
  }
  return (
    <div className="preview">
      <div className="preview-toolbar">
        <fieldset className="segmented">
          <legend>Screen</legend>
          {(["desktop", "phone"] as const).map((d) => (
            <label key={d}>
              <input type="radio" name="preview-device" value={d} checked={device === d} onChange={() => setDevice(d)} />
              <span>{d === "desktop" ? "Desktop" : "Phone"}</span>
            </label>
          ))}
        </fieldset>
        {languages.length > 1 && (
          <div className="field inline-field">
            <label htmlFor="preview-language">Language</label>
            <select id="preview-language" value={language} onChange={(e) => setLanguage(e.target.value)}>
              <option value="">The visitor's</option>
              {languages.map((l) => (
                <option key={l} value={l}>
                  {languageName(l)}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>
      <fieldset className="preview-answers">
        <legend>Replies in the preview</legend>
        {ANSWERS.map((a) => (
          <label key={a.value} className="inline">
            <input
              type="radio"
              name="preview-answers"
              value={a.value}
              checked={answers === a.value}
              disabled={a.value === "live" && !canAsk}
              onChange={() => setAnswers(a.value)}
            />{" "}
            {a.label}
          </label>
        ))}
      </fieldset>
      <p className="help">
        {answers === "live"
          ? "Questions go to this deployment's Knowledge Box with its saved prompt. They're marked as partner tests, so they stay out of the customer's usage and report."
          : answers === "offline"
            ? "What visitors see while the deployment or the customer is paused, or stopped for budget."
            : canAsk
              ? "Ask anything in the preview to see the reply's layout. Nothing is sent to Agentic RAG."
              : "Live answers need a provisioned Knowledge Box. Sample replies show the layout."}
      </p>
      <div ref={stage} className={`preview-stage ${device}`} style={phone ? { height: PHONE.height * scale } : undefined}>
        {stalled && (
          <p className="notice" data-tone="warning" role="status">
            The preview didn't load.{" "}
            <button
              type="button"
              className="link-button"
              onClick={() => {
                setStalled(false);
                setAttempt((n) => n + 1);
              }}
            >
              Reload preview
            </button>
          </p>
        )}
        <iframe
          key={attempt}
          ref={frame}
          src={src}
          onLoad={hello}
          title={phone ? "Widget preview, phone" : "Widget preview"}
          className={`preview-frame ${device}`}
          style={phone ? { width: PHONE.width, height: PHONE.height, transform: `scale(${scale})` } : undefined}
        />
      </div>
    </div>
  );
}
