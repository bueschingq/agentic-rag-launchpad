"use client";

// The configurator's settings: name and avatar, welcome, the handoff to a person, the widget's
// own text, the contact form, call-to-action buttons, privacy, Google Analytics and custom CSS.
// Each edits the draft's settings; the configurator arranges them into sections. What the scan
// suggests shows "From the scan" beside the field, with its own Apply.

import {
  avatarFit,
  COPY_KEYS,
  DEFAULT_HANDOFF_PLACES,
  HANDOFF_PLACES,
  type HandoffContact,
  type Language,
  type LanguageSetting,
  LEAD_FIELDS,
  type LeadField,
  type LogoCandidate,
  languageName,
  type WidgetCta,
  type WidgetHandoff,
  type WidgetLead,
  type WidgetSettings,
  type WidgetStrings,
} from "@launchpad/theme";
import { Fragment, useRef, useState } from "react";
import { SelectField, TextAreaField, TextField } from "@/components/fields.tsx";
import { focusSoon } from "@/components/focus.tsx";
import type { FormErrors } from "@/lib/customer-form.ts";
import { COPY_LABELS, CTA_MATCH_LABELS, HANDOFF_PLACE_LABELS, LEAD_FIELD_LABELS } from "@/lib/labels.ts";
import type { ScanSummary } from "@/lib/widget.ts";
import {
  type ContactKind,
  type ContactSuggestion,
  consentGaps,
  contactParts,
  contactUrl,
  LIMITS,
  LOGO_SOURCE_WORDS,
  NAME_SOURCE_WORDS,
  type ScanFindings,
  SUGGESTED_EXCLUDES,
  type Suggestion,
  type SuggestionKey,
  tooManyKeywords,
} from "@/lib/widget-form.ts";
import { AvatarImage } from "./brand.tsx";
import { type ButtonFit, type ButtonSuggestion, ctaFromSuggestion } from "./button-suggestions.ts";
import { FromScan } from "./controls.tsx";
import type { PreviewEvent } from "./preview-frame.tsx";

export interface SectionProps {
  settings: WidgetSettings;
  set: <K extends keyof WidgetSettings>(key: K, value: WidgetSettings[K]) => void;
  errors: FormErrors;
}

// Empty text means "use the default", which the widget fills in per language.
export const text = (value: string) => value || undefined;

// Stable keys for editable rows, so removing one doesn't hand its state to the next.
function useRowKeys(count: number) {
  const next = useRef(count);
  const [keys, setKeys] = useState(() => Array.from({ length: count }, (_, i) => i));
  if (keys.length !== count) {
    // The rows changed from outside (Discard changes): keep the keys still in use.
    const adjusted = keys.slice(0, count);
    while (adjusted.length < count) adjusted.push(next.current++);
    setKeys(adjusted);
  }
  return {
    keys,
    add: () => setKeys((k) => [...k, next.current++]),
    remove: (i: number) => setKeys((k) => k.filter((_, n) => n !== i)),
  };
}

// The scan's suggestions beyond the theme. Older scans have none.
type ScanExtras = Pick<ScanFindings, "siteName" | "nameSources" | "nameCheck" | "logoCandidates" | "bottomBar" | "contactUrl"> & {
  languages?: string[];
  pageLanguage?: string;
};
export const scanExtras = (scan: ScanSummary | undefined): ScanExtras => (scan?.result ?? {}) as ScanExtras;

// Avatar options: the scan's candidates, or for a scan from before candidates existed, its logo
// and icons, all to check, since that scan took logos from anywhere on the page.
function avatarCandidates(scan: ScanSummary | undefined): LogoCandidate[] {
  const listed = scanExtras(scan).logoCandidates;
  if (listed) return listed;
  const found = [scan?.result.logo, ...(scan?.result.icons ?? [])].filter((u): u is string => Boolean(u?.startsWith("https://")));
  return [...new Set(found)].map((url) => ({ url, source: url === scan?.result.logo ? "og:image" : "icon", check: true }));
}

// Where a name, an avatar or a privacy link is to come from, and how the header looks.
export interface BrandingProps extends SectionProps {
  scan?: ScanSummary;
  strings: WidgetStrings;
  suggest: (key: SuggestionKey) => Suggestion | undefined;
  apply: (s: Suggestion) => void;
  header: { background: string; color: string; fontFamily: string };
  // The brand isn't confirmed as it is: the scan's doubts about the name still show.
  unconfirmed: boolean;
  // The customer's "Name visitors see": suggested ahead of the scan's name, which stays an option.
  displayName?: string | null;
}

// How an avatar option will read at the chat's size, when that's a problem.
const FIT_WORDS: Partial<Record<ReturnType<typeof avatarFit>, string>> = {
  wide: "Hard to read at the chat's size: a wide logo's lettering ends up a few pixels tall.",
  small: "Small: it may look blurry at the chat's size.",
};

export function BrandingGroup({ settings, set, errors, scan, strings, suggest, apply, header, unconfirmed, displayName }: BrandingProps) {
  const candidates = avatarCandidates(scan);
  const listed = (url: string | undefined) => candidates.some((c) => c.url === url);
  const [custom, setCustom] = useState(false);
  // The avatar in use when the scan's options don't include it (an older scan's logo, one typed
  // earlier): offered as "Current", selected, so the list always says what's in use.
  const [kept, setKept] = useState(() => (settings.avatar && !listed(settings.avatar) ? settings.avatar : undefined));
  if (!custom && settings.avatar && !listed(settings.avatar) && kept !== settings.avatar) setKept(settings.avatar);
  const current = kept && !listed(kept) ? kept : undefined;
  const choice = custom ? "custom" : (settings.avatar ?? "");
  const { nameSources = [], nameCheck, siteName } = scanExtras(scan);
  // Each spelling once, with every source that uses it, in the scan's order (proposed first).
  const spellings = new Map<string, string[]>();
  for (const s of nameSources.filter((n) => n.source !== "domain"))
    spellings.set(s.value, [...(spellings.get(s.value) ?? []), NAME_SOURCE_WORDS[s.source]]);
  const suggestedLogo = suggest("avatar");
  const name = settings.nickname || strings.title;
  // With the customer's own name suggested, the scan's name is the alternative.
  const scanName = displayName?.trim() && siteName && siteName !== displayName.trim() ? siteName : undefined;
  const scanNameFrom = nameSources.find((n) => n.value === siteName)?.source;

  return (
    <div className="group">
      <h3>Name and avatar</h3>
      <TextField
        name="settings.nickname"
        label="Chat name"
        value={settings.nickname ?? ""}
        placeholder={strings.title}
        onChange={(e) => set("nickname", text(e.target.value))}
        maxLength={LIMITS.nickname}
        error={errors["settings.nickname"]}
        help={
          <>
            Shown in the chat header, and read out with the chat button.
            <FromScan suggestion={suggest("nickname")} label="Chat name" onApply={apply} />
            {scanName && settings.nickname !== scanName && (
              <span style={{ display: "block", marginTop: 4 }}>
                Or the scan's: “{scanName}”{scanNameFrom ? `, from ${NAME_SOURCE_WORDS[scanNameFrom]}` : ""}.{" "}
                <button type="button" className="link-button" onClick={() => set("nickname", scanName)}>
                  Use<span className="sr-only"> “{scanName}”</span>
                </button>
              </span>
            )}
          </>
        }
      />
      {nameCheck && unconfirmed && spellings.size > 1 && (
        <div className="notice" data-tone="warning">
          <p>
            <strong>Check this:</strong> the site names itself in different ways.
          </p>
          <ul className="plain">
            {[...spellings].map(([value, where]) => (
              <li key={value}>
                “{value}” in {where.join(" and ")}{" "}
                {settings.nickname !== value && (
                  <button type="button" className="link-button" onClick={() => set("nickname", value)}>
                    Use<span className="sr-only"> “{value}”</span>
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      <fieldset className="choices">
        <legend className="label">Avatar</legend>
        <p className="help">
          Shown beside the chat name, at this size on the header.{" "}
          {scan
            ? "The scan suggests the option that reads best that small: a square icon or logo before a wide one."
            : "Scan the site to offer its logo and icons."}
        </p>
        {current && (
          <label className="choice">
            <input
              type="radio"
              name="avatar-choice"
              checked={!custom && choice === current}
              onChange={() => {
                setCustom(false);
                set("avatar", current);
              }}
            />
            <span>
              <span
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  width: "fit-content",
                  maxWidth: "100%",
                  padding: "8px 12px",
                  borderRadius: 6,
                  fontWeight: 600,
                  ...header,
                }}
              >
                <AvatarImage src={current} />
                <span>{name}</span>
              </span>
              <span className="help">Current: in use now, and not among the scan's options</span>
            </span>
          </label>
        )}
        {[{ url: "", source: undefined } as const, ...candidates].map((c) => (
          <label key={c.url || "none"} className="choice">
            <input
              type="radio"
              name="avatar-choice"
              checked={!custom && choice === c.url}
              onChange={() => {
                setCustom(false);
                set("avatar", text(c.url));
              }}
            />
            {c.source === undefined ? (
              <span>No avatar</span>
            ) : (
              <span>
                <span
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    width: "fit-content",
                    maxWidth: "100%",
                    padding: "8px 12px",
                    borderRadius: 6,
                    fontWeight: 600,
                    ...header,
                  }}
                >
                  <AvatarImage src={c.url} />
                  <span>{name}</span>
                </span>
                <span className="help">
                  {((c as LogoCandidate).check || FIT_WORDS[avatarFit(c as LogoCandidate)]) && (
                    <span className="scan-note" data-confidence="low">
                      Check this.
                    </span>
                  )}{" "}
                  {LOGO_SOURCE_WORDS[c.source]}
                  {(c as LogoCandidate).width ? `, ${(c as LogoCandidate).width}×${(c as LogoCandidate).height} px` : ""}
                  {FIT_WORDS[avatarFit(c as LogoCandidate)] && ` · ${FIT_WORDS[avatarFit(c as LogoCandidate)]}`}
                  {suggestedLogo?.value === c.url && " · Suggested by the scan, not applied yet"}
                </span>
              </span>
            )}
          </label>
        ))}
        <label className="choice">
          <input type="radio" name="avatar-choice" checked={custom} onChange={() => setCustom(true)} />
          <span>Another image address</span>
        </label>
      </fieldset>
      {custom && (
        <TextField
          name="settings.avatar"
          label="Image address"
          type="url"
          placeholder="https://www.example.com/logo.svg"
          value={settings.avatar ?? ""}
          onChange={(e) => set("avatar", text(e.target.value.trim()))}
          error={errors["settings.avatar"]}
          help={settings.avatar ? <AvatarImage src={settings.avatar} /> : "Logos made for dark backgrounds may vanish on a light header."}
        />
      )}
    </div>
  );
}

interface WelcomeProps extends SectionProps {
  strings: WidgetStrings;
  auto: boolean;
  // Who chose the starter questions last, and whether this person has, unsaved.
  startersBy?: { name: string; at: string };
  chosen: boolean;
  choose: () => void;
}

export function WelcomeGroup({ settings, set, errors, strings, auto, startersBy, chosen, choose }: WelcomeProps) {
  const starters = (settings.starters ?? []).filter((q) => q.trim());
  return (
    <div className="group">
      <h3>Welcome</h3>
      <p className="help">
        {auto
          ? "Empty fields use the widget's own text in each visitor's language. Add other languages' copy under Languages."
          : "Empty fields use the widget's own text, shown here in grey."}
      </p>
      <TextAreaField
        name="settings.welcome"
        label="Welcome message"
        rows={2}
        value={settings.welcome ?? ""}
        placeholder={strings.welcome}
        onChange={(e) => set("welcome", text(e.target.value))}
        maxLength={LIMITS.welcome}
        error={errors["settings.welcome"]}
      />
      <TextAreaField
        name="settings.starters"
        label="Starter questions"
        rows={4}
        value={settings.starters?.join("\n") ?? ""}
        onChange={(e) => {
          set("starters", e.target.value ? e.target.value.split("\n") : undefined);
          choose();
        }}
        error={errors["settings.starters"]}
        help={
          <>
            One per line, up to {LIMITS.starters}. Shown as buttons when the chat opens.{" "}
            {chosen ? (
              "Saving records them as chosen by you."
            ) : startersBy ? (
              `Chosen by ${startersBy.name}, ${startersBy.at.slice(0, 10)}.`
            ) : (
              <>
                <span className="scan-note" data-confidence="low">
                  Check this.
                </span>{" "}
                {starters.length
                  ? "Nobody has chosen these yet: edit them, or "
                  : "No starter questions, and nobody has chosen that: add some, or "}
                <button type="button" className="link-button" onClick={choose}>
                  {starters.length ? "keep these" : "keep none"}
                </button>
                .
              </>
            )}
          </>
        }
      />
    </div>
  );
}

const CONTACT_KINDS: Record<ContactKind, { label: string; input: string; placeholder: string }> = {
  page: { label: "Web page", input: "url", placeholder: "https://www.example.com/contact" },
  phone: { label: "Phone", input: "tel", placeholder: "+1 555 123 4567" },
  email: { label: "Email", input: "email", placeholder: "help@example.com" },
};
const CONTACT_OPTIONS = Object.entries(CONTACT_KINDS).map(([value, k]) => ({ value, label: k.label }));
const BLANK_CONTACT: HandoffContact = { kind: "link", url: "" };

export function HandoffGroup({
  settings,
  set,
  errors,
  strings,
  suggestions,
}: SectionProps & { strings: WidgetStrings; suggestions: ContactSuggestion[] }) {
  // A new handoff shows on a reply with no answer and in the header; the line under every
  // answer is opt-in, so visitors aren't offered a person three times at once.
  const handoff: WidgetHandoff = settings.handoff ?? { contacts: [], show: [...DEFAULT_HANDOFF_PLACES] };
  const update = (patch: Partial<WidgetHandoff>) => set("handoff", { ...handoff, ...patch });
  const contacts = handoff.contacts.length ? handoff.contacts : [BLANK_CONTACT];
  const rows = useRowKeys(contacts.length);
  const setContact = (i: number, patch: Partial<HandoffContact>) =>
    update({ contacts: contacts.map((c, n) => (n === i ? { ...c, ...patch } : c)) });
  const defaultLabel = { page: strings.contactPage, phone: strings.callUs, email: strings.emailUs };
  const filled = handoff.contacts.filter((c) => contactParts(c.url).value.trim());
  const unused = suggestions.filter((s) => !filled.some((c) => c.url === s.contact.url));

  return (
    <div className="group" id="handoff">
      <h3>Handoff to a person</h3>
      <p className="help">How visitors reach the customer's team when the chatbot isn't enough. The contact form is set up below.</p>
      {unused.length > 0 && filled.length < LIMITS.contacts && (
        <div className="suggestions">
          <p className="label">Suggested</p>
          <ul className="plain">
            {unused.map((s) => (
              <li key={s.contact.url}>
                <button
                  type="button"
                  className="button secondary"
                  onClick={() => {
                    rows.add();
                    update({ contacts: [...filled, s.contact] });
                    focusSoon(`settings.handoff.contacts.${filled.length}.url`);
                  }}
                >
                  Add<span className="sr-only"> {contactParts(s.contact.url).value} as a contact</span>
                </button>{" "}
                {contactParts(s.contact.url).value} <span className="muted">· {s.why}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {contacts.map((contact, i) => {
        const { type, value } = contactParts(contact.url);
        const kind = CONTACT_KINDS[type];
        const f = (field: string) => `settings.handoff.contacts.${i}.${field}`;
        return (
          <fieldset className="contact" key={rows.keys[i]}>
            <legend>Contact {i + 1}</legend>
            <div className="field-grid">
              <SelectField
                name={f("type")}
                label="Type"
                options={CONTACT_OPTIONS}
                value={type}
                onChange={(e) => setContact(i, { url: contactUrl(e.target.value as ContactKind, value) })}
              />
              <TextField
                name={f("url")}
                label={kind.label}
                type={kind.input}
                placeholder={kind.placeholder}
                value={value}
                onChange={(e) => setContact(i, { url: contactUrl(type, e.target.value) })}
                error={errors[f("url")]}
                autoComplete="off"
              />
              <TextField
                name={f("label")}
                label="Label (optional)"
                placeholder={defaultLabel[type]}
                value={contact.label ?? ""}
                onChange={(e) => setContact(i, { label: text(e.target.value) })}
                maxLength={LIMITS.label}
                error={errors[f("label")]}
              />
            </div>
            {(contacts.length > 1 || value) && (
              <div>
                <button
                  type="button"
                  className="link-button"
                  onClick={() => {
                    rows.remove(i);
                    update({ contacts: contacts.filter((_, n) => n !== i) });
                  }}
                >
                  Remove contact {i + 1}
                </button>
              </div>
            )}
          </fieldset>
        );
      })}
      {contacts.length < LIMITS.contacts && (
        <div>
          <button
            type="button"
            className="button secondary"
            onClick={() => {
              rows.add();
              update({ contacts: [...contacts, BLANK_CONTACT] });
            }}
          >
            Add a contact
          </button>
        </div>
      )}
      <TextField
        name="settings.handoff.message"
        label="Message"
        value={handoff.message ?? ""}
        placeholder={strings.handoff}
        onChange={(e) => update({ message: text(e.target.value) })}
        maxLength={LIMITS.handoffMessage}
        error={errors["settings.handoff.message"]}
        help="Introduces the contacts."
      />
      <fieldset className="choices" aria-describedby={errors["settings.handoff.show"] ? "settings.handoff.show-error" : undefined}>
        <legend className="label">Show it</legend>
        {HANDOFF_PLACES.map((place, i) => (
          <label key={place} className="inline">
            <input
              type="checkbox"
              id={i === 0 ? "settings.handoff.show" : undefined}
              checked={handoff.show.includes(place)}
              onChange={(e) => update({ show: e.target.checked ? [...handoff.show, place] : handoff.show.filter((p) => p !== place) })}
            />{" "}
            {HANDOFF_PLACE_LABELS[place]}
          </label>
        ))}
        {errors["settings.handoff.show"] && (
          <p id="settings.handoff.show-error" className="field-error">
            {errors["settings.handoff.show"]}
          </p>
        )}
      </fieldset>
    </div>
  );
}

// The widget's own words, which the partner can reword. Fine-tune, as defaults usually do.
export function TextGroup({ settings, set, errors, strings }: SectionProps & { strings: WidgetStrings }) {
  const copy = settings.copy ?? {};
  return (
    <div className="group">
      <h3>Text</h3>
      <p className="help">Empty fields use the widget's own text, shown in grey.</p>
      <div className="field-grid">
        <TextField
          name="settings.placeholder"
          label="Question box placeholder"
          value={settings.placeholder ?? ""}
          placeholder={strings.placeholder}
          onChange={(e) => set("placeholder", text(e.target.value))}
          maxLength={LIMITS.placeholder}
          error={errors["settings.placeholder"]}
        />
        {COPY_KEYS.map((key) => (
          <TextField
            key={key}
            name={`settings.copy.${key}`}
            label={COPY_LABELS[key][0]}
            value={copy[key] ?? ""}
            placeholder={strings[key]}
            onChange={(e) => set("copy", { ...copy, [key]: text(e.target.value) })}
            maxLength={LIMITS.copy}
            error={errors[`settings.copy.${key}`]}
            help={COPY_LABELS[key][1]}
          />
        ))}
      </div>
      <TextAreaField
        name="settings.disclosure"
        label="AI disclosure"
        rows={2}
        value={settings.disclosure ?? ""}
        placeholder={strings.disclosure}
        onChange={(e) => set("disclosure", text(e.target.value))}
        maxLength={LIMITS.disclosure}
        error={errors["settings.disclosure"]}
        help="Under the question box. It can be reworded but not removed; the privacy notice link goes after it."
      />
      <TextField
        name="settings.offlineMessage"
        label="Offline message"
        value={settings.offlineMessage ?? ""}
        placeholder={strings.offline}
        onChange={(e) => set("offlineMessage", text(e.target.value))}
        maxLength={LIMITS.offlineMessage}
        error={errors["settings.offlineMessage"]}
        help="Shown instead of the chat while the deployment or the customer is paused, or over budget when the customer is set to stop at 100%."
      />
      <label className="inline">
        <input type="checkbox" checked={settings.showSources !== false} onChange={(e) => set("showSources", e.target.checked)} /> Show
        source links under answers
      </label>
      <label className="inline">
        <input type="checkbox" checked={settings.feedback !== false} onChange={(e) => set("feedback", e.target.checked)} /> Ask visitors
        whether each answer helped (thumbs up or down)
      </label>
      <label className="inline">
        <input type="checkbox" checked={settings.poweredBy === true} onChange={(e) => set("poweredBy", e.target.checked)} /> Show “
        {strings.poweredBy}”
      </label>
    </div>
  );
}

const BLANK_LEAD: WidgetLead = { enabled: false, fields: ["name", "email", "message"], requiredFields: ["email"] };

interface LeadProps extends SectionProps {
  strings: WidgetStrings;
  language: LanguageSetting;
  // A webhook or email is set for leads (on the deployment's Edit page, at leadsHref).
  leadDestination: boolean;
  leadsHref: string;
}

export function LeadSection({ settings, set, errors, strings, language, leadDestination, leadsHref }: LeadProps) {
  const lead = settings.lead ?? BLANK_LEAD;
  const generic = consentGaps(settings, language);
  const update = (patch: Partial<WidgetLead>) => set("lead", { ...lead, ...patch });
  const toggle = (field: LeadField, on: boolean) =>
    update({
      fields: LEAD_FIELDS.filter((f) => (f === field ? on : lead.fields.includes(f))),
      requiredFields: on ? lead.requiredFields : lead.requiredFields.filter((f) => f !== field),
    });
  return (
    <section id="form" className="panel" aria-labelledby="lead-title">
      <h2 id="lead-title">Contact form</h2>
      <p className="help">
        A short form inside the chat, so a visitor who wants a person can leave their details without leaving the page. It opens from “Talk
        to a person”, from a reply with no answer, and from buttons set to open it. Leads go to the webhook or email set on the deployment
        page; Launchpad keeps only their count.
      </p>
      <label className="inline">
        <input type="checkbox" id="settings.lead.enabled" checked={lead.enabled} onChange={(e) => update({ enabled: e.target.checked })} />{" "}
        Offer the contact form
      </label>
      {lead.enabled && !leadDestination && (
        <p className="notice" data-tone="warning">
          <strong>Leads have nowhere to go yet.</strong> Visitors can send the form, but no webhook or email is set for this deployment's
          leads. <a href={leadsHref}>Set where leads go</a> on the Edit page.
        </p>
      )}
      {lead.enabled && (
        <>
          <fieldset className="choices" aria-describedby={errors["settings.lead.fields"] ? "settings.lead.fields-error" : undefined}>
            <legend className="label">Fields</legend>
            {LEAD_FIELDS.map((field, i) => (
              <div key={field} className="lead-field-row">
                <label className="inline">
                  <input
                    type="checkbox"
                    id={i === 0 ? "settings.lead.fields" : undefined}
                    checked={lead.fields.includes(field)}
                    onChange={(e) => toggle(field, e.target.checked)}
                  />{" "}
                  {LEAD_FIELD_LABELS[field]}
                </label>
                {lead.fields.includes(field) && (
                  <label className="inline">
                    <input
                      type="checkbox"
                      checked={lead.requiredFields.includes(field)}
                      onChange={(e) =>
                        update({
                          requiredFields: e.target.checked
                            ? [...lead.requiredFields, field]
                            : lead.requiredFields.filter((f) => f !== field),
                        })
                      }
                    />{" "}
                    Required
                  </label>
                )}
              </div>
            ))}
            {errors["settings.lead.fields"] && (
              <p id="settings.lead.fields-error" className="field-error">
                {errors["settings.lead.fields"]}
              </p>
            )}
          </fieldset>
          <TextAreaField
            name="settings.lead.intro"
            label="Intro"
            rows={2}
            value={lead.intro ?? ""}
            placeholder={strings.leadIntro}
            onChange={(e) => update({ intro: text(e.target.value) })}
            maxLength={LIMITS.leadText}
            error={errors["settings.lead.intro"]}
          />
          <TextAreaField
            name="settings.lead.consentText"
            label="Consent checkbox"
            rows={2}
            value={lead.consentText ?? ""}
            placeholder={strings.consent}
            onChange={(e) => update({ consentText: text(e.target.value) })}
            maxLength={LIMITS.leadText}
            error={errors["settings.lead.consentText"]}
            help={
              <>
                {settings.privacyUrl
                  ? "Visitors must tick it to send. The privacy notice is linked under it, and the lead records this wording."
                  : "Visitors must tick it to send, and the lead records this wording. Add the client's privacy notice under Privacy to link it here."}
                {generic.length > 0 && (
                  <span style={{ display: "block", marginTop: 4 }}>
                    <span className="scan-note" data-confidence="low">
                      Check this.
                    </span>{" "}
                    {generic.map(languageName).join(", ")} consent text is the generic default
                    {generic.length > 1 || language === "auto" ? " (other languages' wording is under Languages)" : ""}.
                  </span>
                )}
              </>
            }
          />
          <label className="inline">
            <input type="checkbox" checked={lead.transcript !== false} onChange={(e) => update({ transcript: e.target.checked })} /> Offer “
            {strings.includeConversation}”, so the team sees what was asked. Without the visitor's tick, no conversation is sent.
          </label>
        </>
      )}
    </section>
  );
}

const BLANK_CTA: WidgetCta = { label: "", url: "", keywords: [] };

const pathOf = (url: string) => {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
};

const samePage = (a: string, b: string) => a.replace(/[?#].*$/, "").replace(/\/+$/, "") === b.replace(/[?#].*$/, "").replace(/\/+$/, "");

export function CtaSection({
  settings,
  set,
  errors,
  suggestions = [],
  served = ["en"],
  fits = [],
}: SectionProps & { suggestions?: ButtonSuggestion[]; served?: Language[]; fits?: ButtonFit[] }) {
  const ctas = settings.ctas ?? [];
  const rows = useRowKeys(ctas.length);
  const leadOn = Boolean(settings.lead?.enabled);
  const setCta = (i: number, patch: Partial<WidgetCta>) =>
    set(
      "ctas",
      ctas.map((c, n) => (n === i ? { ...c, ...patch } : c)),
    );
  // Suggestions for pages no button opens yet, with a page in the main language.
  const offered = suggestions.flatMap((s) => {
    const made = ctaFromSuggestion(s, served);
    return made && !ctas.some((c) => c.url && samePage(c.url, s.url)) ? [{ s, made }] : [];
  });
  // One click: the button in the main language, and its label, keywords and page in each further
  // served language that has its own page (paired by position), then focus on its label to check it.
  const add = ({ cta, translations }: NonNullable<ReturnType<typeof ctaFromSuggestion>>) => {
    rows.add();
    set("ctas", [...ctas, cta]);
    const languages = Object.keys(translations) as Language[];
    if (languages.length) {
      const next = { ...settings.translations };
      for (const language of languages) {
        const copy = next[language] ?? {};
        const local = [...(copy.ctas ?? [])];
        while (local.length < ctas.length) local.push({});
        local[ctas.length] = translations[language]!;
        next[language] = { ...copy, ctas: local };
      }
      set("translations", next);
    }
    focusSoon(`settings.ctas.${ctas.length}.label`);
  };

  return (
    <section id="ctas" className="panel" aria-labelledby="buttons-title">
      <h2 id="buttons-title">Call-to-action buttons</h2>
      <p className="help">
        A button appears under a reply when the visitor's question or the answer mentions one of its keywords, such as “Book an appointment”
        for appointment or booking. At most two per reply.
      </p>
      {offered.length > 0 && ctas.length < LIMITS.ctas && (
        <div className="suggestions">
          <p className="label">Suggested from the site's key pages and the scan</p>
          <ul className="plain">
            {offered.map(({ s, made }) => {
              const label = made.cta.label;
              const languages = [served[0]!, ...(Object.keys(made.translations) as Language[])];
              return (
                <li key={s.url}>
                  <button type="button" className="button secondary" onClick={() => add(made)}>
                    Add<span className="sr-only"> the button {label}</span>
                  </button>{" "}
                  “{label}” → {s.path} <span className="muted">· {s.why}</span>
                  {served.length > 1 && (
                    <span className="muted">
                      {" "}
                      · In {languages.map((l) => languageName(l)).join(", ")}
                      {languages.length < served.length && ": not shown in languages without such a page"}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
          {served.length > 1 && <p className="help">Each language opens its own language's page, with its own label and keywords.</p>}
        </div>
      )}
      {fits.length > 0 && (
        <div className="notice" data-tone="warning" role="note">
          <p>Some saved buttons link to another language's page. Visitors get them like this:</p>
          <ul className="plain">
            {fits.map((fit) => (
              <li key={`${fit.index}-${fit.language}`}>
                “{ctas[fit.index]?.label || `Button ${fit.index + 1}`}” in {languageName(fit.language)}:{" "}
                {fit.action === "relinked" && fit.url
                  ? `opens ${pathOf(fit.url)}`
                  : "not shown: the site has no such page in this language"}
              </li>
            ))}
          </ul>
          <p className="help">Set each language's link under Languages, or remove the button, to change this.</p>
        </div>
      )}
      {errors["settings.ctas"] && <p className="field-error">{errors["settings.ctas"]}</p>}
      {ctas.map((cta, i) => {
        const f = (field: string) => `settings.ctas.${i}.${field}`;
        const opensForm = cta.action === "lead";
        return (
          <fieldset className="contact" key={rows.keys[i]}>
            <legend>Button {i + 1}</legend>
            <div className="field-grid">
              <TextField
                name={f("label")}
                label="Label"
                placeholder="Book an appointment"
                value={cta.label}
                onChange={(e) => setCta(i, { label: e.target.value })}
                maxLength={LIMITS.label}
                error={errors[f("label")]}
              />
              <SelectField
                name={f("action")}
                label="It opens"
                options={[
                  { value: "link", label: "A link" },
                  { value: "lead", label: leadOn ? "The contact form" : "The contact form (turn it on first)" },
                ]}
                value={opensForm ? "lead" : "link"}
                onChange={(e) => setCta(i, e.target.value === "lead" ? { action: "lead", url: "" } : { action: undefined })}
                error={errors[f("action")]}
              />
              {!opensForm && (
                <TextField
                  name={f("url")}
                  label="Link"
                  placeholder="https://www.example.com/book"
                  value={cta.url}
                  onChange={(e) => setCta(i, { url: e.target.value.trim() })}
                  error={errors[f("url")]}
                  autoComplete="off"
                  help="A web page, or tel: or mailto:"
                />
              )}
            </div>
            <TextField
              name={f("keywords")}
              label="Keywords"
              placeholder="appointment, booking, schedule"
              value={cta.keywords.join(",")}
              onChange={(e) => setCta(i, { keywords: e.target.value.split(",") })}
              error={errors[f("keywords")] ?? tooManyKeywords(cta.keywords)}
              help={`Separated by commas, up to ${LIMITS.keywords}. Matching ignores case and accents.`}
            />
            <SelectField
              name={f("match")}
              label="Match keywords"
              options={[
                { value: "word", label: CTA_MATCH_LABELS.word },
                { value: "contains", label: CTA_MATCH_LABELS.contains },
              ]}
              value={cta.match ?? "word"}
              onChange={(e) => setCta(i, { match: e.target.value === "contains" ? "contains" : undefined })}
            />
            <div>
              <button
                type="button"
                className="link-button"
                onClick={() =>
                  set(
                    "ctas",
                    ctas.filter((_, n) => n !== i),
                  )
                }
              >
                Remove button {i + 1}
              </button>
            </div>
          </fieldset>
        );
      })}
      {ctas.length < LIMITS.ctas && (
        <div>
          <button
            type="button"
            className="button secondary"
            onClick={() => {
              rows.add();
              set("ctas", [...ctas, BLANK_CTA]);
              // On to the new button's label (round 5: focus stayed on Add a button).
              focusSoon(`settings.ctas.${ctas.length}.label`);
            }}
          >
            Add a button
          </button>
        </div>
      )}
    </section>
  );
}

export function PrivacySection({
  settings,
  set,
  errors,
  suggestion,
  apply,
}: SectionProps & { suggestion?: Suggestion; apply: (s: Suggestion) => void }) {
  const exclude = settings.exclude ?? [];
  const missing = SUGGESTED_EXCLUDES.filter((p) => !exclude.includes(p));
  return (
    <section id="privacy" className="panel" aria-labelledby="privacy-title">
      <h2 id="privacy-title">Privacy</h2>
      <TextField
        name="settings.privacyUrl"
        label="Privacy notice"
        type="url"
        placeholder="https://www.example.com/privacy"
        value={settings.privacyUrl ?? ""}
        onChange={(e) => set("privacyUrl", text(e.target.value.trim()))}
        error={errors["settings.privacyUrl"]}
        autoComplete="off"
        help={
          <>
            The client's notice, linked after the AI disclosure line and from the contact form's consent box.
            <FromScan suggestion={suggestion} label="Privacy notice" onApply={apply} />
          </>
        }
      />
      <TextAreaField
        name="settings.exclude"
        label="Pages where the chat doesn't appear"
        rows={4}
        className="code"
        spellCheck={false}
        value={exclude.join("\n")}
        onChange={(e) => set("exclude", e.target.value ? e.target.value.split("\n") : undefined)}
        error={errors["settings.exclude"]}
        help={
          <>
            One page path per line. <code>/login</code> covers /login and every page under it; <code>*</code> matches anything, so{" "}
            <code>/checkout/*</code> or <code>*/account/*</code> (any language prefix) work too.
          </>
        }
      />
      {missing.length > 0 && (
        <div>
          <button type="button" className="button secondary" onClick={() => set("exclude", [...exclude.filter(Boolean), ...missing])}>
            Add {missing.join(", ")}
          </button>
        </div>
      )}
    </section>
  );
}

const EVENTS: [string, string][] = [
  [
    "arag_chat_open",
    "The chat is opened. In the Embedded and Chat layouts, which are always on the page: the first time a visitor clicks into it.",
  ],
  ["arag_chat_question", "A question is asked: question_length, starter, language."],
  [
    "arag_chat_answer",
    "A reply arrives: answered (false when there was nothing on the site to answer with), sources, duration_ms, language.",
  ],
  ["arag_chat_source_click", "A source link is followed: link_url."],
  ["arag_chat_cta_click", "A call-to-action button is used: cta_label, link_url."],
  ["arag_chat_handoff_click", "A contact is used: contact_type (page, phone, email or form), placement."],
  ["arag_chat_feedback", "Thumbs on an answer: value (up or down)."],
  ["arag_chat_lead_submit", "The contact form is sent: placement, language. Never what the visitor typed."],
];

// GA4 needs these set up by hand before the events are useful in its reports.
const DIMENSIONS = ["answered", "sources", "cta_label", "contact_type", "placement", "value", "language", "conversation_id"];

export function AnalyticsSection({ settings, set, errors, events }: SectionProps & { events: { id: number; event: PreviewEvent }[] }) {
  const analytics = settings.analytics ?? { googleAnalytics: false };
  return (
    <section id="analytics" className="panel" aria-labelledby="analytics-title">
      <h2 id="analytics-title">Google Analytics</h2>
      <label className="inline">
        <input
          type="checkbox"
          checked={analytics.googleAnalytics}
          onChange={(e) => set("analytics", { ...analytics, googleAnalytics: e.target.checked })}
        />{" "}
        Send chat events to the site's Google Analytics
      </label>
      <p className="help">
        Through the gtag or Tag Manager already on the site; the widget loads nothing itself. Question and answer text is never sent, as
        visitors type personal details into chats. The client report counts the same events whether this is on or not.
      </p>
      <TextField
        name="settings.analytics.measurementId"
        label="GA4 measurement ID (optional)"
        placeholder="G-1A2B3C4D5E"
        value={analytics.measurementId ?? ""}
        onChange={(e) => set("analytics", { ...analytics, measurementId: text(e.target.value.trim()) })}
        error={errors["settings.analytics.measurementId"]}
        help="Sends the events to this property only, when the site's gtag reports to several."
        autoComplete="off"
      />
      <details>
        <summary>Set up GA4 for these events</summary>
        <ol className="checklist">
          <li>
            In GA4, <strong>Admin › Custom definitions › Create custom dimension</strong>, scope <em>Event</em>, one for each parameter:{" "}
            {DIMENSIONS.map((d, i) => (
              <Fragment key={d}>
                {i > 0 && ", "}
                <code>{d}</code>
              </Fragment>
            ))}
            . conversation_id has many values: use it in Explorations to count conversations, not in standard reports.
          </li>
          <li>
            In <strong>Admin › Events</strong>, mark <code>arag_chat_lead_submit</code> as a key event, and <code>arag_chat_cta_click</code>{" "}
            and <code>arag_chat_handoff_click</code> too if the client counts them as conversions.
          </li>
          <li>
            Consent: with gtag, the events follow the site's Consent Mode like its other events. With Tag Manager, they arrive on the
            dataLayer; the GA4 event tag that forwards them must use the container's consent settings (built-in consent checks for{" "}
            <code>analytics_storage</code>).
          </li>
          <li>
            Tag Manager only: add a <em>Custom Event</em> trigger matching <code>^arag_chat_</code> as a regex, and a GA4 event tag with
            Event name <code>{"{{Event}}"}</code> that sends the parameters above from Data Layer Variables.
          </li>
          <li>Check it: open the site with GA4 DebugView, ask a question, and see the events arrive within a minute.</li>
        </ol>
      </details>
      <details>
        <summary>Events</summary>
        <dl className="details events">
          {EVENTS.map(([name, what]) => (
            <Fragment key={name}>
              <dt>
                <code>{name}</code>
              </dt>
              <dd>{what}</dd>
            </Fragment>
          ))}
        </dl>
        <p className="help">
          Every event also carries deployment_id and conversation_id, and is dispatched on the page as an arag-chat:event DOM event.
        </p>
      </details>
      <div aria-live="polite">
        <p className="help">From the preview{events.length ? "" : ": nothing yet. Open the chat or ask something."}</p>
        {events.length > 0 && (
          <ul className="event-log">
            {events.map(({ id, event }) => {
              const { name, deployment_id: _, conversation_id: __, ...params } = event;
              const detail = Object.entries(params)
                .map(([k, v]) => `${k}=${String(v)}`)
                .join(", ");
              return (
                <li key={id}>
                  <code>{name}</code> {detail}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}

const CLASSES =
  ".launcher .panel .header .title .avatar .name .talk .talk-label .close .log .message.user .message.assistant .answer .sources .sources-label .ctas .cta .handoff .contact .still .feedback .thumb .retry .lead .starters .starter .form .input .send .disclosure .powered-by .intro .trigger .modal";

export function CssGroup({ settings, set, errors }: SectionProps) {
  return (
    <div className="group">
      <h3>Custom CSS</h3>
      <TextAreaField
        name="settings.customCss"
        label="CSS"
        className="code"
        rows={8}
        spellCheck={false}
        value={settings.customCss ?? ""}
        onChange={(e) => set("customCss", text(e.target.value))}
        error={errors["settings.customCss"]}
        help={
          <>
            Added inside the widget after its own styles, so it can't change the rest of the page. Target its classes:{" "}
            <code>{CLASSES}</code>. Use <code>:host([data-mode="floating"])</code> for one layout. No <code>@import</code>.
          </>
        }
      />
    </div>
  );
}
