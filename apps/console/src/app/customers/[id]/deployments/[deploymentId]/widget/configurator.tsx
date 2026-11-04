"use client";

// The widget configurator. The draft lives here and the preview shows it as it's edited;
// nothing reaches the customer's site until it's saved. A site scan changes nothing by itself:
// what it found shows "From the scan" beside each field, with where it came from and its own
// Apply, until someone applies it there or with Apply all. The customer's "Name visitors see"
// goes ahead of the scan's guess at a chat name. Confirm brand records a person's look at the
// header as visitors see it (the widget draws it) and at the primary color.
//
// The page leads with Essentials, the few settings most deployments need, and keeps the rest
// under Fine-tune, presets before raw values. Leaving with unsaved changes always asks first.

import {
  defaultWidgetSettings,
  FINISHES,
  type Language,
  type LanguageSetting,
  type PublicWidgetConfig,
  resolveLanguage,
  resolveTheme,
  type ThemeTokens,
  WIDGET_MODES,
  type WidgetSettings,
  widgetStrings,
} from "@launchpad/theme";
import { startTransition, useActionState, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { CopyButton } from "@/components/copy-button.tsx";
import { SelectField, TextField } from "@/components/fields.tsx";
import { useFocusOnChange } from "@/components/focus.tsx";
import { useTypedName } from "@/components/typed-name.ts";
import type { FormErrors } from "@/lib/customer-form.ts";
import { FINISH_LABELS, MODE_LABELS, options, PLATFORM_LABELS, POSITION_LABELS } from "@/lib/labels.ts";
import type { Confirmed, ScanSummary } from "@/lib/widget.ts";
import {
  applySuggestions,
  CORNER_PRESETS,
  type ContactSuggestion,
  type CornerPreset,
  contactParts,
  cornerPreset,
  customerSuggestions,
  pixels,
  plainRepair,
  previewFonts,
  type ScanFindings,
  SHADOW_PRESETS,
  type ShadowPreset,
  type Suggestion,
  type SuggestionKey,
  scanSuggestions,
  shadowPreset,
  suggestionTopics,
  unapplied,
  type WidgetDraft,
  withContactPage,
} from "@/lib/widget-form.ts";
import type { SaveState, ScanResult } from "./actions.ts";
import { BrandConfirm, headerLook } from "./brand.tsx";
import type { ButtonFit, ButtonSuggestion } from "./button-suggestions.ts";
import { ColorField, FromScan, PixelField, PresetChoices, ScanNote, type Scanned } from "./controls.tsx";
import { orderHandoffSuggestions } from "./handoff-suggestions.ts";
import { LanguagesSection } from "./languages.tsx";
import { type PreviewEvent, PreviewFrame } from "./preview-frame.tsx";
import {
  AnalyticsSection,
  BrandingGroup,
  CssGroup,
  CtaSection,
  HandoffGroup,
  LeadSection,
  PrivacySection,
  TextGroup,
  WelcomeGroup,
} from "./sections.tsx";

interface Props {
  deploymentId: string;
  language: LanguageSetting;
  saved: WidgetDraft;
  scan: ScanSummary | undefined;
  canAsk: boolean;
  suggestions: ContactSuggestion[];
  // Ready-made call-to-action buttons from the key pages and the scan (button-suggestions.ts).
  buttonSuggestions?: ButtonSuggestion[];
  // How saved buttons were fitted to each served language for visitors (fitCtasToLanguages).
  buttonFits?: ButtonFit[];
  // The deployment's contact key page, the first handoff contact suggested.
  contactKeyPage?: string | null;
  // Its support key page, suggested first when it has no contact key page.
  supportKeyPage?: string | null;
  // The customer's "Name visitors see", the first suggestion for the chat's name.
  displayName?: string | null;
  // The languages of the KB's pages, so live answers in the preview are asked as on the site.
  contentLanguages?: string[];
  // Its intent routing, as the public config serves it (intentConfigs, intentPages), and the
  // synced pages links may open and the confirmed price table (pagePaths, priceTable).
  routing?: Pick<PublicWidgetConfig, "intentConfigs" | "intentPages" | "eventPages" | "pagePaths" | "pagePathsCapped" | "priceTable">;
  base: string;
  embedTag: string;
  siteUrl: string;
  scanAction: (pageUrl: string) => Promise<ScanResult>;
  saveAction: (previous: SaveState, form: FormData) => Promise<SaveState>;
  confirmAction: (typedName: string) => Promise<{ confirmed: Confirmed } | { error: string }>;
  confirmed: Confirmed;
  // Shared-password sign-in: confirmations need a typed name.
  setupMode: boolean;
  // A webhook or email is set for leads, on the Edit page at leadsHref.
  leadDestination: boolean;
  leadsHref: string;
}

type Group = keyof ThemeTokens;

const token = (theme: ThemeTokens, path: string): string => {
  const [group, key] = path.split(".") as [Group, string];
  return (theme[group] as Record<string, string>)[key] ?? "";
};

// Primary is in Essentials; these are fine-tuning.
const COLORS: [keyof ThemeTokens["color"], string, string?][] = [
  ["onPrimary", "Text on primary"],
  ["surface", "Background"],
  ["surfaceAlt", "Header and answers"],
  ["text", "Text"],
  ["textMuted", "Secondary text"],
  ["border", "Borders", "Outlines the question box and buttons."],
  ["link", "Links"],
  ["focus", "Keyboard focus ring"],
];

const FONTS: [string, string, string?][] = [
  ["font.family", "Font", "The site's own fonts only: on the site, the widget uses fonts the page has already loaded."],
  ["font.headingFamily", "Heading font", "“inherit” uses the font above."],
  ["font.size", "Text size"],
  ["font.lineHeight", "Line height"],
];

const SHAPES: [string, string][] = [
  ["shape.radius", "Panel corners"],
  ["shape.bubbleRadius", "Message corners"],
  ["shape.buttonRadius", "Button corners"],
  ["shape.inputRadius", "Input corners"],
  ["shape.shadow", "Shadow"],
];

// Repairs worth showing beside the primary color, where the partner is looking.
const PRIMARY_REPAIRS = new Set(["color.onPrimary", "launcher.outline", "finish.gradientEnd"]);

export function WidgetConfigurator(props: Props) {
  const { deploymentId, language, canAsk, suggestions, base, embedTag, scanAction, saveAction, confirmAction, siteUrl, setupMode } = props;
  const [draft, setDraft] = useState(props.saved);
  const [baseline, setBaseline] = useState(props.saved);
  const [scan, setScan] = useState(props.scan);
  const [scanUrl, setScanUrl] = useState(props.scan?.url ?? props.siteUrl);
  // The result of a scan or an Apply; focus moves to it (n tells one from the next). An Apply's
  // ("Nothing is saved yet") is unsaved: a save clears it.
  const [scanNotice, setScanNotice] = useState<{ tone: "good" | "critical"; text: string; n: number; unsaved?: boolean }>();
  const noticeRef = useRef<HTMLParagraphElement>(null);
  const [confirmed, setConfirmed] = useState(props.confirmed);
  const [confirming, startConfirm] = useTransition();
  const [brandStatus, setBrandStatus] = useState<string>();
  const [typedName, setTypedName] = useTypedName();
  const [nameError, setNameError] = useState<string>();
  // The starter questions were typed or kept here, unsaved: the save records who chose them.
  const [startersChosen, setStartersChosen] = useState(false);
  const [scanning, startScan] = useTransition();
  const [events, setEvents] = useState<{ id: number; event: PreviewEvent }[]>([]);
  const [missingFonts, setMissingFonts] = useState<string[]>([]);
  const [sheet, setSheet] = useState(false);
  const eventId = useRef(0);
  const submitted = useRef(draft);
  const previewButton = useRef<HTMLButtonElement>(null);
  const closeSheet = useRef<HTMLButtonElement>(null);

  const [state, save, saving] = useActionState(
    async (previous: SaveState, form: FormData) => {
      submitted.current = JSON.parse(String(form.get("draft")));
      const next = await saveAction(previous, form);
      if (next.saved > previous.saved) {
        setBaseline(submitted.current);
        setScanNotice((n) => (n?.unsaved ? undefined : n));
        if (form.get("startersChosen") === "1" && !next.notice) setStartersChosen(false);
        // Said once, after Save and confirm; any later save shows the brand's state as it is.
        setBrandStatus(
          next.unrecorded
            ? next.notice
            : form.get("confirmBrand") === "1" && next.confirmed?.brand === "confirmed"
              ? "Saved, and the brand is confirmed."
              : undefined,
        );
      }
      if (next.confirmed) setConfirmed(next.confirmed);
      setNameError(next.errors.typedName);
      return next;
    },
    { errors: {}, saved: 0 },
  );
  // Save widget's result takes focus, so the next Tab goes on from it.
  const savedNotice = useFocusOnChange<HTMLSpanElement>(state.saved);

  const dirty = JSON.stringify(draft) !== JSON.stringify(baseline) || startersChosen;

  // What the scan found that the draft doesn't have yet.
  const findings = scan?.result as ScanFindings | undefined;
  const { displayName } = props;
  const proposals = useMemo(
    () => (findings ? scanSuggestions(findings, { displayName }) : customerSuggestions({ displayName })),
    [findings, displayName],
  );
  // The contact key page first, then the scan's contact page; the customer's internal contact last,
  // only if the client wants visitors to reach that person (handoff-suggestions.ts).
  const { contactKeyPage, supportKeyPage } = props;
  const contactSuggestions = useMemo(
    () => orderHandoffSuggestions(withContactPage(suggestions, findings?.contactUrl), contactKeyPage, supportKeyPage),
    [suggestions, findings, contactKeyPage, supportKeyPage],
  );
  const pending = unapplied(draft, proposals);
  const suggest = (key: SuggestionKey) => pending.find((s) => s.key === key);
  const announce = (tone: "good" | "critical", text: string, unsaved = false) =>
    setScanNotice((n) => ({ tone, text, n: (n?.n ?? 0) + 1, unsaved }));
  const apply = (items: Suggestion[]) => {
    setDraft((d) => applySuggestions(d, items));
    const topics = suggestionTopics(items);
    announce("good", `Applied from the scan: ${topics.join(", ")}. Nothing is saved yet; check the preview, then save.`, true);
  };
  useEffect(() => {
    if (scanNotice) noticeRef.current?.focus();
  }, [scanNotice]);

  const confirmBrand = () =>
    startConfirm(async () => {
      const result = await confirmAction(typedName);
      if ("error" in result) {
        setNameError(result.error);
        return;
      }
      setNameError(undefined);
      setConfirmed(result.confirmed);
      setBrandStatus(undefined);
    });
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    // In-app links don't unload the page, so beforeunload never fires for them: ask first.
    const guard = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const link = e.target instanceof Element ? e.target.closest<HTMLAnchorElement>("a[href]") : null;
      if (!link || link.target === "_blank" || link.hasAttribute("download")) return;
      const url = new URL(link.href, location.href);
      if (url.origin !== location.origin || (url.pathname === location.pathname && url.search === location.search)) return;
      if (!confirm("Leave without saving? Your changes to this widget will be lost.")) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    addEventListener("beforeunload", warn);
    addEventListener("click", guard, true);
    return () => {
      removeEventListener("beforeunload", warn);
      removeEventListener("click", guard, true);
    };
  }, [dirty]);

  // The preview as a sheet on phones: Escape closes it, and focus goes back where it was.
  useEffect(() => {
    if (!sheet) return;
    closeSheet.current?.focus();
    const close = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSheet(false);
    };
    addEventListener("keydown", close);
    return () => {
      removeEventListener("keydown", close);
      previewButton.current?.focus();
    };
  }, [sheet]);

  const resolved = useMemo(() => resolveTheme(draft.theme), [draft.theme]);
  // Invalid values are marked as they're typed; contrast repairs are listed in plain words.
  const errors: FormErrors = { ...state.errors };
  for (const warning of resolved.warnings) {
    const [path, problem = ""] = warning.split(": ");
    if (problem.startsWith("ignored invalid color")) errors[`theme.${path}`] = "Enter a color like #1a4d8f.";
    else if (problem.startsWith("ignored invalid")) errors[`theme.${path}`] = "This value isn't allowed here.";
  }
  const repairs = resolved.repairs.map((r) => ({ path: r.path, words: plainRepair(r, resolved.theme) }));

  const config = useMemo<PublicWidgetConfig>(() => {
    const s = draft.settings;
    return {
      deploymentId,
      zone: "",
      kbId: "",
      searchConfig: "",
      theme: resolved.theme,
      settings: {
        ...defaultWidgetSettings,
        ...s,
        language,
        starters: s.starters?.map((q) => q.trim()).filter(Boolean),
        handoff: s.handoff && { ...s.handoff, contacts: s.handoff.contacts.filter((c) => contactParts(c.url).value.trim()) },
        ctas: s.ctas?.map((c) => ({ ...c, keywords: c.keywords.map((k) => k.trim()).filter(Boolean) })),
      },
      online: true,
      contentLanguages: props.contentLanguages,
      // Intent questions asked as on the site: their configuration and pages first.
      ...props.routing,
    };
  }, [deploymentId, draft.settings, resolved, language, props.contentLanguages, props.routing]);

  const setToken = (path: string, value: string) => {
    const [group, key] = path.split(".") as [Group, string];
    setDraft((d) => ({ ...d, theme: { ...d.theme, [group]: { ...d.theme[group], [key]: value } } }));
  };
  const setShape = (values: Partial<ThemeTokens["shape"]>) =>
    setDraft((d) => ({ ...d, theme: { ...d.theme, shape: { ...d.theme.shape, ...values } } }));
  const setSetting = <K extends keyof WidgetSettings>(key: K, value: WidgetSettings[K]) =>
    setDraft((d) => ({ ...d, settings: { ...d.settings, [key]: value } }));

  // A scanned value the partner hasn't changed, and how sure the scan was of it.
  const scanned = (path: string): Scanned => {
    const result = scan?.result;
    const confidence = result?.confidence[path];
    if (!result || confidence === undefined || token(draft.theme, path) !== token(result.theme, path)) return undefined;
    return { low: confidence < 0.6, source: result.sources[path] ?? "the site" };
  };

  // A scan changes nothing: it lists what it found beside each field.
  const runScan = () =>
    startScan(async () => {
      setScanNotice(undefined);
      const result = await scanAction(scanUrl);
      if ("error" in result) {
        announce("critical", result.error);
        return;
      }
      setScan(result.scan);
      const found = unapplied(draft, scanSuggestions(result.scan.result as ScanFindings));
      const host = new URL(result.scan.finalUrl).host;
      announce(
        "good",
        found.length
          ? `Scanned ${host}. Nothing is applied yet: what it found is marked “From the scan” below (${suggestionTopics(found).join(", ")}). Apply each, or all at once.`
          : `Scanned ${host}. The widget already matches everything it found.`,
      );
    });

  const mode = draft.settings.mode ?? "floating";
  const finish = draft.theme.finish.style;
  const auto = language === "auto";
  // Placeholders show the widget's own text; "auto" shows the main language's.
  const strings = widgetStrings(resolveLanguage(language, [], draft.settings.languages ?? []));
  // The languages visitors may see the chat in, for Confirm brand's header in each.
  const spoken: Language[] = auto ? (draft.settings.languages?.length ? draft.settings.languages : ["en"]) : [resolveLanguage(language)];
  const shape = draft.theme.shape;
  const sections: [string, string][] = [
    ["scan", "Site scan"],
    ["essentials", "Essentials"],
    ["fine-tune", "Fine-tune"],
    ...(auto ? ([["languages", "Languages"]] as [string, string][]) : []),
    ["form", "Contact form"],
    ["ctas", "Buttons"],
    ["privacy", "Privacy"],
    ["analytics", "Analytics"],
  ];
  const fontNote = missingFonts.length > 0 && (
    <p className="font-note" role="status">
      <strong>Site font not loaded:</strong> {missingFonts.join(", ")}. The preview shows a fallback font; on the client's site, the widget
      uses the site's own.
    </p>
  );

  return (
    <div className={`configurator${sheet ? " sheet-open" : ""}`}>
      {/* Submitted by hand: a form `action` resets the form afterwards, and a reset puts
          controlled selects and checkboxes back to their defaults on screen. */}
      <form
        className="form configurator-controls"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          const form = new FormData(e.currentTarget, (e.nativeEvent as SubmitEvent).submitter);
          startTransition(() => save(form));
        }}
      >
        <input type="hidden" name="draft" value={JSON.stringify(draft)} />
        <input type="hidden" name="startersChosen" value={startersChosen ? "1" : ""} />
        <SaveErrors errors={state.errors} />

        <nav className="section-index" aria-label="Sections of this page">
          <ul>
            {sections.map(([id, label]) => (
              <li key={id}>
                <a
                  href={`#${id}`}
                  onClick={() => {
                    if (id === "fine-tune")
                      (document.querySelector("#fine-tune details") as HTMLDetailsElement | null)?.setAttribute("open", "");
                  }}
                >
                  {label}
                </a>
              </li>
            ))}
          </ul>
        </nav>

        <section id="scan" className="panel" aria-labelledby="scan-title">
          <h2 id="scan-title">Site scan</h2>
          {scan ? (
            <dl className="details">
              <dt>Scanned</dt>
              <dd>
                {/* UTC: the server and the browser render this, and must agree. */}
                {scan.createdAt.toLocaleString("en", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" })} UTC, from{" "}
                <a href={scan.finalUrl} target="_blank" rel="noreferrer">
                  {new URL(scan.finalUrl).host}
                </a>
              </dd>
              <dt>Platform</dt>
              <dd>
                {PLATFORM_LABELS[scan.platform.platform]}
                {scan.platform.version && ` ${scan.platform.version}`}
              </dd>
              <dt>Sitemap</dt>
              <dd>
                {scan.sitemapPages
                  ? `${scan.sitemapPages.toLocaleString("en")}${scan.result.sitemapTruncated ? "+" : ""} pages`
                  : "None found"}
              </dd>
            </dl>
          ) : (
            <p className="help">
              A scan proposes a theme from the site's colors, fonts and buttons, a chat name and logo, and puts a screenshot of the page
              behind the preview.
            </p>
          )}
          <TextField
            name="scan-url"
            label="Page to scan"
            type="url"
            value={scanUrl}
            onChange={(e) => setScanUrl(e.target.value)}
            onKeyDown={(e) => {
              // Enter scans rather than saving the widget.
              if (e.key === "Enter") {
                e.preventDefault();
                runScan();
              }
            }}
            autoComplete="off"
            help="Usually the home page. Any public page of the site works, such as one showing its main buttons."
          />
          <div className="actions">
            <button type="button" className="button secondary" onClick={runScan} disabled={scanning}>
              {scanning ? "Scanning…" : scan ? "Scan again" : "Scan this page"}
            </button>
          </div>
          <p className="help" aria-live="polite">
            {scanning && "Loading the page in the scanner. This takes 10 to 30 seconds."}
          </p>
          {scanNotice && (
            <p
              ref={noticeRef}
              tabIndex={-1}
              className="notice"
              data-tone={scanNotice.tone}
              role={scanNotice.tone === "critical" ? "alert" : "status"}
            >
              {scanNotice.text}
            </p>
          )}
        </section>

        {scan && pending.length > 0 && (
          <div className="notice" data-tone="warning" id="scan-banner">
            <p>
              <strong>The scan of {new URL(scan.finalUrl).host} isn't applied.</strong> It suggests {suggestionTopics(pending).join(", ")},
              marked “From the scan” below. {pending.some((p) => p.low) ? "Those marked “Check this” are guesses. " : ""}
              Nothing is used until you apply it and save.
            </p>
            <div className="actions">
              <button type="button" className="button secondary" onClick={() => apply(pending)} disabled={scanning}>
                Apply all from the scan
              </button>
            </div>
          </div>
        )}

        <section id="essentials" className="panel" aria-labelledby="essentials-title">
          <h2 id="essentials-title">Essentials</h2>
          <p className="help">What most deployments need. Everything else is under Fine-tune.</p>
          <div className="group">
            <h3>Layout</h3>
            <fieldset className="choices">
              <legend className="sr-only">Layout</legend>
              {WIDGET_MODES.map((m) => (
                <label key={m} className="choice">
                  <input type="radio" name="mode" value={m} checked={mode === m} onChange={() => setSetting("mode", m)} />
                  <span>
                    <strong>{MODE_LABELS[m][0]}</strong>
                    <span className="help">{MODE_LABELS[m][1]}</span>
                  </span>
                </label>
              ))}
            </fieldset>
            {mode === "floating" ? (
              <>
                <SelectField
                  name="theme.launcher.position"
                  label="Chat button corner"
                  options={options(POSITION_LABELS)}
                  value={draft.theme.launcher.position}
                  onChange={(e) => setToken("launcher.position", e.target.value)}
                />
                <div className="field">
                  <label className="inline">
                    <input
                      type="checkbox"
                      id="settings.liftAboveBars"
                      checked={draft.settings.liftAboveBars !== false}
                      onChange={(e) => setSetting("liftAboveBars", e.target.checked ? undefined : false)}
                    />{" "}
                    Lift above the site's cookie bar
                  </label>
                  <p className="help">
                    The chat button moves up while a cookie bar or a bottom menu covers the bottom of the window, and back down when it
                    closes, so it never hides the bar's buttons.
                    {findings?.bottomBar && scan
                      ? ` The scan found a ${findings.bottomBar.height} px ${findings.bottomBar.label} along the bottom of ${new URL(scan.finalUrl).host}.`
                      : ""}
                    <FromScan suggestion={suggest("liftAboveBars")} label="Lift above the cookie bar" onApply={(x) => apply([x])}>
                      on
                    </FromScan>
                  </p>
                </div>
              </>
            ) : (
              <div className="field">
                <span className="label">Where it appears</span>
                <p className="help">
                  In-page layouts appear where the site places this tag. With the embed snippet alone, the chat is added at the end of the
                  page.
                </p>
                <pre className="snippet">
                  <code>{embedTag}</code>
                </pre>
                <div>
                  <CopyButton text={embedTag} label="Copy tag" />
                </div>
              </div>
            )}
          </div>
          <div className="group">
            <h3>Primary color</h3>
            <ColorField
              name="theme.color.primary"
              label="Primary"
              help="The chat button, buttons and the visitor's messages."
              value={draft.theme.color.primary}
              onChange={(v) => setToken("color.primary", v)}
              scanned={scanned("color.primary")}
              error={errors["theme.color.primary"]}
              suggestion={suggest("color.primary")}
              onApply={(x) => apply([x])}
            >
              <Repairs items={repairs.filter((r) => PRIMARY_REPAIRS.has(r.path))} />
            </ColorField>
          </div>
          <BrandingGroup
            settings={draft.settings}
            set={setSetting}
            errors={errors}
            scan={scan}
            strings={strings}
            suggest={suggest}
            apply={(x) => apply([x])}
            header={headerLook(resolved.theme)}
            unconfirmed={confirmed.brand !== "confirmed"}
            displayName={displayName}
          />
          <BrandConfirm
            theme={resolved.theme}
            config={config}
            languages={spoken}
            fonts={previewFonts(scan?.result)}
            strings={strings}
            confirmed={confirmed}
            dirty={dirty}
            setupMode={setupMode}
            typedName={typedName}
            setTypedName={setTypedName}
            nameError={nameError}
            busy={saving || confirming}
            onConfirm={confirmBrand}
            status={brandStatus}
          />
          <WelcomeGroup
            settings={draft.settings}
            set={setSetting}
            errors={errors}
            strings={strings}
            auto={auto}
            startersBy={confirmed.startersBy}
            chosen={startersChosen}
            choose={() => setStartersChosen(true)}
          />
          <HandoffGroup settings={draft.settings} set={setSetting} errors={errors} strings={strings} suggestions={contactSuggestions} />
        </section>

        <section id="fine-tune" className="panel" aria-labelledby="fine-tune-title">
          <details>
            <summary>
              <h2 id="fine-tune-title">Fine-tune</h2>
              <span className="help">Finish, colors, corners, fonts, the chat button, wording and custom CSS.</span>
            </summary>
            <div className="group">
              <h3>Colors</h3>
              <SelectField
                name="theme.finish.style"
                label="Finish"
                options={FINISHES.map((f) => ({ value: f, label: FINISH_LABELS[f] }))}
                value={finish}
                onChange={(e) => setToken("finish.style", e.target.value)}
                help={
                  <>
                    <ScanNote scanned={scanned("finish.style")} />
                    <FromScan suggestion={suggest("finish.style")} label="Finish" onApply={(x) => apply([x])} />
                  </>
                }
              />
              <div className="field-grid">
                {COLORS.map(([key, label, help]) => (
                  <ColorField
                    key={key}
                    name={`theme.color.${key}`}
                    label={label}
                    help={help}
                    value={draft.theme.color[key]}
                    onChange={(v) => setToken(`color.${key}`, v)}
                    scanned={scanned(`color.${key}`)}
                    error={errors[`theme.color.${key}`]}
                    suggestion={suggest(`color.${key}`)}
                    onApply={(x) => apply([x])}
                  />
                ))}
                {finish === "gradient" && (
                  <ColorField
                    name="theme.finish.gradientEnd"
                    label="Gradient end"
                    help="The gradient runs from the primary color to this one."
                    value={draft.theme.finish.gradientEnd}
                    onChange={(v) => setToken("finish.gradientEnd", v)}
                    scanned={scanned("finish.gradientEnd")}
                    error={errors["theme.finish.gradientEnd"]}
                    suggestion={suggest("finish.gradientEnd")}
                    onApply={(x) => apply([x])}
                  />
                )}
              </div>
              {repairs.length > 0 && (
                <div className="note">
                  <p className="help">Adjusted so everything stays readable (WCAG AA). The preview and the site use these:</p>
                  <Repairs items={repairs} />
                </div>
              )}
            </div>

            <div className="group">
              <h3>Shape</h3>
              <PresetChoices<CornerPreset>
                name="corners"
                legend="Corners"
                options={Object.entries(CORNER_PRESETS).map(([value, p]) => ({ value: value as CornerPreset, label: p.label }))}
                value={cornerPreset(shape)}
                onChange={(p) => setShape(CORNER_PRESETS[p].values)}
                help={cornerPreset(shape) ? <ScanNote scanned={scanned("shape.buttonRadius")} /> : "Set by hand below."}
              />
              <PresetChoices<ShadowPreset>
                name="shadow"
                legend="Shadow"
                options={Object.entries(SHADOW_PRESETS).map(([value, p]) => ({ value: value as ShadowPreset, label: p.label }))}
                value={shadowPreset(shape.shadow)}
                onChange={(p) => setShape({ shadow: SHADOW_PRESETS[p].value })}
                help={shadowPreset(shape.shadow) ? undefined : "Set by hand below."}
              />
              <details className="raw-values" open={SHAPES.some(([path]) => errors[`theme.${path}`])}>
                <summary>Exact values</summary>
                <div className="field-grid">
                  {SHAPES.map(([path, label]) => (
                    <RawField
                      key={path}
                      path={path}
                      label={label}
                      value={token(draft.theme, path)}
                      onChange={setToken}
                      error={errors[`theme.${path}`]}
                      scanned={scanned(path)}
                      suggestion={suggest(path as SuggestionKey)}
                      onApply={(x) => apply([x])}
                    />
                  ))}
                </div>
              </details>
            </div>

            <div className="group">
              <h3>Fonts</h3>
              {fontNote}
              <div className="field-grid">
                {FONTS.map(([path, label, help]) => (
                  <RawField
                    key={path}
                    path={path}
                    label={label}
                    help={help}
                    value={token(draft.theme, path)}
                    onChange={setToken}
                    error={errors[`theme.${path}`]}
                    scanned={scanned(path)}
                    suggestion={suggest(path as SuggestionKey)}
                    onApply={(x) => apply([x])}
                  />
                ))}
              </div>
            </div>

            <div className="group">
              <h3>Chat button</h3>
              <p className="help">The Floating layout's button in the corner of every page.</p>
              <div className="field-grid">
                <PixelField
                  name="theme.launcher.size"
                  label="Size"
                  min={40}
                  max={96}
                  value={pixels(draft.theme.launcher.size)}
                  onChange={(n) => setToken("launcher.size", `${n}px`)}
                  error={errors["theme.launcher.size"]}
                />
                <PixelField
                  name="theme.launcher.offset"
                  label="Distance from the side"
                  value={pixels(draft.theme.launcher.offset)}
                  onChange={(n) => setToken("launcher.offset", `${n}px`)}
                  error={errors["theme.launcher.offset"]}
                />
                <PixelField
                  name="theme.launcher.bottom"
                  label="Distance from the bottom"
                  value={pixels(draft.theme.launcher.bottom)}
                  onChange={(n) => setToken("launcher.bottom", `${n}px`)}
                  error={errors["theme.launcher.bottom"]}
                  help="Above the bottom of the window. The button also lifts above a cookie bar by itself (under Layout)."
                />
              </div>
            </div>

            <TextGroup settings={draft.settings} set={setSetting} errors={errors} strings={strings} />
            <CssGroup settings={draft.settings} set={setSetting} errors={errors} />
          </details>
        </section>

        {auto && <LanguagesSection settings={draft.settings} set={setSetting} errors={errors} scan={scan} />}
        <LeadSection
          settings={draft.settings}
          set={setSetting}
          errors={errors}
          strings={strings}
          language={language}
          leadDestination={props.leadDestination}
          leadsHref={props.leadsHref}
        />
        <CtaSection
          settings={draft.settings}
          set={setSetting}
          errors={errors}
          suggestions={props.buttonSuggestions ?? []}
          fits={props.buttonFits ?? []}
          served={spoken}
        />
        <PrivacySection
          settings={draft.settings}
          set={setSetting}
          errors={errors}
          suggestion={suggest("privacyUrl")}
          apply={(x) => apply([x])}
        />
        <AnalyticsSection settings={draft.settings} set={setSetting} errors={errors} events={events} />

        <div className="save-bar">
          <button className="button" type="submit" disabled={saving || !dirty}>
            {saving ? "Saving…" : "Save widget"}
          </button>
          <button
            type="button"
            className="button secondary"
            disabled={saving || !dirty}
            onClick={() => {
              setDraft(baseline);
              setStartersChosen(false);
            }}
          >
            Discard changes
          </button>
          <span className="help" role="status" tabIndex={-1} ref={savedNotice}>
            {dirty ? "Unsaved changes" : state.saved ? (state.notice ?? "Saved. The site picks up the change within a minute.") : ""}
          </span>
          <button
            ref={previewButton}
            type="button"
            className="button secondary preview-open"
            aria-haspopup="dialog"
            onClick={() => setSheet(true)}
          >
            Preview
          </button>
        </div>
      </form>

      <section
        className={`configurator-preview${sheet ? " sheet" : ""}`}
        aria-labelledby="preview-title"
        {...(sheet ? { role: "dialog", "aria-modal": true } : {})}
      >
        <div className="sheet-head">
          <h2 id="preview-title">Preview</h2>
          {sheet && (
            <button ref={closeSheet} type="button" className="button secondary" onClick={() => setSheet(false)}>
              Close
            </button>
          )}
        </div>
        <PreviewFrame
          src={`${base}/preview${scan ? `?v=${new Date(scan.createdAt).getTime()}` : ""}`}
          config={config}
          canAsk={canAsk}
          siteUrl={siteUrl}
          languages={auto ? (draft.settings.languages ?? []) : []}
          onEvent={(event) => setEvents((list) => [{ id: eventId.current++, event }, ...list].slice(0, 8))}
          onFonts={setMissingFonts}
        />
        {fontNote}
      </section>
    </div>
  );
}

function Repairs({ items }: { items: { path: string; words: string }[] }) {
  if (!items.length) return null;
  return (
    <ul className="repairs">
      {items.map((r) => (
        <li key={r.path + r.words}>{r.words}</li>
      ))}
    </ul>
  );
}

interface RawFieldProps {
  path: string;
  label: string;
  help?: string;
  value: string;
  onChange: (path: string, value: string) => void;
  error?: string;
  scanned: Scanned;
  suggestion?: Suggestion;
  onApply: (s: Suggestion) => void;
}

function RawField({ path, label, help, value, onChange, error, scanned, suggestion, onApply }: RawFieldProps) {
  return (
    <TextField
      name={`theme.${path}`}
      label={label}
      value={value}
      onChange={(e) => onChange(path, e.target.value)}
      error={error}
      spellCheck={false}
      autoComplete="off"
      help={
        help || scanned || suggestion ? (
          <>
            {help} <ScanNote scanned={scanned} />
            <FromScan suggestion={suggestion} label={label} onApply={onApply} />
          </>
        ) : undefined
      }
    />
  );
}

// After a failed save: what to fix, each linked to its field (opening Fine-tune if need be).
function SaveErrors({ errors }: { errors: FormErrors }) {
  const box = useRef<HTMLDivElement>(null);
  const [labels, setLabels] = useState<Record<string, string>>({});
  const keys = Object.keys(errors).filter((k) => k !== "_form");

  useEffect(() => {
    if (!Object.keys(errors).length) return;
    const found: Record<string, string> = {};
    for (const key of Object.keys(errors)) {
      const label = document.querySelector(`label[for="${CSS.escape(key)}"]`)?.textContent?.trim();
      if (label) found[key] = label;
    }
    setLabels(found);
    box.current?.focus();
  }, [errors]);

  if (!Object.keys(errors).length) return null;
  const title = errors._form ?? (keys.length === 1 ? "Fix this before saving:" : `Fix these ${keys.length} things before saving:`);
  return (
    <div ref={box} tabIndex={-1} className="notice error-summary" data-tone="critical" role="alert">
      <p>
        <strong>{title}</strong>
      </p>
      {keys.length > 0 && (
        <ul>
          {keys.map((key) => (
            <li key={key}>
              <a
                href={`#${key}`}
                onClick={(e) => {
                  e.preventDefault();
                  focusField(key);
                }}
              >
                {labels[key] ? `${labels[key]}: ` : ""}
                {errors[key]}
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// Errors on a list (the buttons, the handoff's places) point at the list's section.
const SECTION_OF: [RegExp, string][] = [
  [/^settings\.ctas/, "ctas"],
  [/^settings\.translations/, "languages"],
  [/^settings\.lead/, "form"],
  [/^settings\.liftAboveBars/, "essentials"],
  [/^typedName/, "brand"],
  [/^settings\.(exclude|privacyUrl)/, "privacy"],
  [/^settings\.analytics/, "analytics"],
  [/^settings\.handoff/, "essentials"],
  [/^theme\./, "fine-tune"],
];

function focusField(key: string) {
  const section = SECTION_OF.find(([pattern]) => pattern.test(key))?.[1];
  const target = document.getElementById(key) ?? (section ? document.getElementById(section) : null);
  if (!target) return;
  for (let p: HTMLElement | null = target; p; p = p.parentElement) if (p instanceof HTMLDetailsElement) p.open = true;
  target.scrollIntoView({ block: "center" });
  if (target.matches("input, select, textarea, button")) target.focus();
  else {
    target.tabIndex = -1;
    target.focus();
  }
}
