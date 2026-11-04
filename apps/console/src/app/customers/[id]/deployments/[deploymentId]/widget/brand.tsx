"use client";

// Confirm brand: the chat's header as visitors see it, drawn by the widget itself (still.tsx):
// the name and avatar at their real size, with "Talk to a person" beside them when the handoff
// shows in the header, in each language the chat speaks, at the width where the layout has
// least room. Then the primary color as visitors see it on the chat button, the send button and
// their own messages. Confirming records who did it and the values as saved; a later change to
// any of them shows "Changed since it was confirmed" here and on the review.

import {
  type Language,
  languageName,
  type PublicWidgetConfig,
  type SiteFont,
  type ThemeTokens,
  type WidgetStrings,
} from "@launchpad/theme";
import { useFocusOnChange } from "@/components/focus.tsx";
import type { Confirmed } from "@/lib/widget.ts";
import { narrowestDevice, STILL_WIDTHS, WidgetStill } from "./still.tsx";

// The chat header's fill and text, as the widget paints them for each finish.
export function headerLook(theme: ThemeTokens) {
  const { surfaceAlt, surface, text } = theme.color;
  const background =
    theme.finish.style === "gradient"
      ? `linear-gradient(180deg, ${surfaceAlt}, ${surface})`
      : theme.finish.style === "gloss"
        ? `linear-gradient(180deg, rgb(255 255 255 / 0.35), rgb(255 255 255 / 0) 60%), ${surfaceAlt}`
        : surfaceAlt;
  return { background, color: text, fontFamily: theme.font.headingFamily === "inherit" ? theme.font.family : theme.font.headingFamily };
}

// The avatar as the widget shows it: 28px tall, at most 96px wide.
export function AvatarImage({ src }: { src: string }) {
  // biome-ignore lint/performance/noImgElement: an image on the customer's site, shown as is; nothing to optimise.
  return <img src={src} alt="" style={{ height: 28, width: "auto", maxWidth: 96, objectFit: "contain", flex: "none" }} />;
}

const when = (at: string) => `${at.slice(0, 10)} ${at.slice(11, 16)} UTC`;

interface Props {
  theme: ThemeTokens;
  // The draft as the preview has it, and the languages it speaks (one, or each served).
  config: PublicWidgetConfig;
  languages: Language[];
  fonts: SiteFont[];
  strings: WidgetStrings;
  confirmed: Confirmed;
  // Unsaved changes: confirming saves them first.
  dirty: boolean;
  setupMode: boolean;
  typedName: string;
  setTypedName: (name: string) => void;
  nameError?: string;
  busy: boolean;
  onConfirm: () => void;
  status?: string;
}

export function BrandConfirm(props: Props) {
  const {
    theme,
    config,
    languages,
    fonts,
    strings,
    confirmed,
    dirty,
    setupMode,
    typedName,
    setTypedName,
    nameError,
    busy,
    onConfirm,
    status,
  } = props;
  const device = narrowestDevice(config.settings.mode);
  const where = device === "desktop" ? `on a desktop (the ${STILL_WIDTHS.desktop} px panel)` : `on a ${STILL_WIDTHS.phone} px phone`;
  const fill =
    theme.finish.style === "gradient"
      ? `linear-gradient(135deg, ${theme.color.primary}, ${theme.finish.gradientEnd})`
      : theme.color.primary;
  const on = theme.color.onPrimary;
  const size = theme.launcher.size;
  const state =
    confirmed.brand === "confirmed" && confirmed.brandBy
      ? `Confirmed by ${confirmed.brandBy.name}, ${when(confirmed.brandBy.at)}.`
      : confirmed.brand === "changed" && confirmed.brandBy
        ? `Changed since ${confirmed.brandBy.name} confirmed it on ${when(confirmed.brandBy.at)}: check it and confirm again.`
        : "Not confirmed yet. The chat can't be signed off until someone confirms its brand.";
  // After Confirm brand (or a save that confirms it), its result takes focus.
  const statusRef = useFocusOnChange<HTMLParagraphElement>(status ?? state);

  return (
    <div className="group" id="brand">
      <h3>Confirm brand</h3>
      <p className="help">
        The chat's header exactly as visitors see it {where}, with everything the widget puts there, then the primary color. Check that the
        name and the logo read clearly and nothing runs into anything else.
      </p>
      <div style={{ display: "grid", gap: 8, marginBottom: 12 }}>
        {languages.map((language) => (
          <WidgetStill
            key={language}
            config={config}
            part="header"
            device={device}
            language={language}
            fonts={fonts}
            label={`${languages.length > 1 ? `${languageName(language)}: ` : ""}the header as “${config.settings.nickname || strings.title}”${
              config.settings.avatar ? " with its avatar" : ""
            }`}
          />
        ))}
      </div>
      <div
        style={{
          display: "grid",
          gap: 12,
          padding: 12,
          border: "1px solid var(--arag-border)",
          borderRadius: "var(--arag-radius)",
          background: theme.color.surface,
          color: theme.color.text,
          fontFamily: theme.font.family,
          maxWidth: 380,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
          <span style={{ padding: "10px 12px", borderRadius: theme.shape.bubbleRadius, background: fill, color: on }}>
            {strings.placeholder}
          </span>
          <span
            aria-hidden="true"
            style={{ display: "inline-block", width: size, height: size, borderRadius: "50%", background: fill, flex: "none" }}
          />
        </div>
      </div>
      <p className="help" role="status" tabIndex={-1} ref={statusRef}>
        {status ?? state}
      </p>
      {setupMode && (
        <div className="field">
          <label htmlFor="typedName">Your name</label>
          <input
            id="typedName"
            name="typedName"
            value={typedName}
            onChange={(e) => setTypedName(e.target.value)}
            autoComplete="name"
            aria-invalid={nameError ? true : undefined}
            aria-describedby={nameError ? "typedName-error" : "typedName-help"}
          />
          <p id="typedName-help" className="help">
            Setup mode can't tell who you are: your name is recorded with the confirmation, marked “not verified”.
          </p>
          {nameError && (
            <p id="typedName-error" className="field-error">
              {nameError}
            </p>
          )}
        </div>
      )}
      <div>
        {dirty ? (
          <button type="submit" name="confirmBrand" value="1" className="button secondary" disabled={busy}>
            Save and confirm brand
          </button>
        ) : (
          <button type="button" className="button secondary" disabled={busy || confirmed.brand === "confirmed"} onClick={onConfirm}>
            {confirmed.brand === "confirmed" ? "Brand confirmed" : "Confirm brand"}
          </button>
        )}
      </div>
    </div>
  );
}
