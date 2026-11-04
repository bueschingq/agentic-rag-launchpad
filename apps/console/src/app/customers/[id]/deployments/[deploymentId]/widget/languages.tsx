"use client";

// For deployments that follow each visitor's language: which languages the site serves, and
// the partner's copy in each. The first language is the one the copy in the other sections
// is written in; visitors in a language the site doesn't serve get that one. Buttons and
// handoff contacts can link to each language's own pages (/de/trial, /de/kontakt).

import { COPY_KEYS, LANGUAGES, type Language, type LocalizedCopy, languageName, languageOf, widgetStrings } from "@launchpad/theme";
import { TextAreaField, TextField } from "@/components/fields.tsx";
import { COPY_LABELS } from "@/lib/labels.ts";
import type { ScanSummary } from "@/lib/widget.ts";
import { contactParts, LIMITS, tooManyKeywords } from "@/lib/widget-form.ts";
import { type SectionProps, scanExtras, text } from "./sections.tsx";

// The scan's hreflang alternates and page language, as languages the widget has text for.
function scannedLanguages(scan: ScanSummary | undefined): Language[] {
  const extras = scanExtras(scan);
  const tags = [extras.pageLanguage, ...(extras.languages ?? [])];
  return [...new Set(tags.map(languageOf).filter((l): l is Language => Boolean(l)))];
}

export function LanguagesSection({ settings, set, errors, scan }: SectionProps & { scan?: ScanSummary }) {
  const served = settings.languages ?? [];
  const suggested = scannedLanguages(scan);
  const setServed = (languages: Language[]) => set("languages", languages.length ? languages : undefined);

  return (
    <section id="languages" className="panel" aria-labelledby="languages-title">
      <h2 id="languages-title">Languages</h2>
      <p className="help">
        This deployment answers in each visitor's language: the embed snippet's <code>data-language</code> first, then the page's own
        language (<code>&lt;html lang&gt;</code>), then the browser's. List the languages the site serves to give each its own welcome,
        starter questions and buttons; everything left empty uses the widget's own text in that language.
      </p>
      {suggested.length > 1 && (
        <p className="notice" data-tone="warning">
          The scanned page links to versions in {suggested.map(languageName).join(", ")}.{" "}
          {suggested.some((l) => !served.includes(l)) && (
            <button type="button" className="link-button" onClick={() => setServed([...new Set([...served, ...suggested])])}>
              Serve these languages
            </button>
          )}
        </p>
      )}
      <fieldset className="choices">
        <legend className="label">Languages the site serves</legend>
        {LANGUAGES.map(({ code, name }) => (
          <label key={code} className="inline">
            <input
              type="checkbox"
              checked={served.includes(code)}
              onChange={(e) => setServed(e.target.checked ? [...served, code] : served.filter((l) => l !== code))}
            />{" "}
            {name}
            {served[0] === code && served.length > 1 ? " (main: the copy in the sections above)" : ""}
          </label>
        ))}
      </fieldset>
      {served.length > 1 && (
        <div className="field">
          <label htmlFor="main-language">Main language</label>
          <select
            id="main-language"
            value={served[0]}
            onChange={(e) => setServed([e.target.value as Language, ...served.filter((l) => l !== e.target.value)])}
          >
            {served.map((l) => (
              <option key={l} value={l}>
                {languageName(l)}
              </option>
            ))}
          </select>
          <p className="help">The language the copy above is written in. Visitors in any language not listed get this one.</p>
        </div>
      )}
      {served.slice(1).map((language) => (
        <TranslationFields key={language} language={language} settings={settings} set={set} errors={errors} />
      ))}
    </section>
  );
}

function TranslationFields({ language, settings, set, errors }: SectionProps & { language: Language }) {
  const copy: LocalizedCopy = settings.translations?.[language] ?? {};
  const strings = widgetStrings(language);
  const name = languageName(language);
  const update = (patch: Partial<LocalizedCopy>) => set("translations", { ...settings.translations, [language]: { ...copy, ...patch } });
  const f = (field: string) => `settings.translations.${language}.${field}`;
  const ctas = settings.ctas ?? [];
  const contacts = (settings.handoff?.contacts ?? []).filter((c) => contactParts(c.url).value.trim());
  const filled = Object.values(copy).filter((v) => v !== undefined).length;

  return (
    <details className="translation" open={Object.keys(errors).some((k) => k.startsWith(f("")))}>
      <summary>
        {name} copy <span className="help">({filled ? "partly filled in" : "the widget's own text only"})</span>
      </summary>
      <div className="translation-fields" lang={language}>
        <TextField
          name={f("nickname")}
          label={`Chat name in ${name}`}
          value={copy.nickname ?? ""}
          placeholder={settings.nickname ?? strings.title}
          onChange={(e) => update({ nickname: text(e.target.value) })}
          maxLength={LIMITS.nickname}
          error={errors[f("nickname")]}
        />
        <TextAreaField
          name={f("welcome")}
          label={`Welcome message in ${name}`}
          rows={2}
          value={copy.welcome ?? ""}
          placeholder={strings.welcome}
          onChange={(e) => update({ welcome: text(e.target.value) })}
          maxLength={LIMITS.welcome}
          error={errors[f("welcome")]}
        />
        <TextAreaField
          name={f("starters")}
          label={`Starter questions in ${name}`}
          rows={3}
          value={copy.starters?.join("\n") ?? ""}
          onChange={(e) => update({ starters: e.target.value ? e.target.value.split("\n") : undefined })}
          error={errors[f("starters")]}
          help={`One per line, up to ${LIMITS.starters}.`}
        />
        {ctas.map((cta, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: translations pair with the buttons by position.
          <div className="field-grid" key={i}>
            <TextField
              name={f(`ctas.${i}.label`)}
              label={`“${cta.label || `Button ${i + 1}`}” in ${name}`}
              value={copy.ctas?.[i]?.label ?? ""}
              onChange={(e) => update({ ctas: patchAt(copy.ctas, i, { label: text(e.target.value) }) })}
              maxLength={LIMITS.label}
              error={errors[f(`ctas.${i}.label`)]}
              help="Left empty, the button isn't shown in this language."
            />
            <TextField
              name={f(`ctas.${i}.keywords`)}
              label="Its keywords"
              value={copy.ctas?.[i]?.keywords?.join(",") ?? ""}
              onChange={(e) =>
                update({ ctas: patchAt(copy.ctas, i, { keywords: e.target.value ? e.target.value.split(",") : undefined }) })
              }
              error={errors[f(`ctas.${i}.keywords`)] ?? tooManyKeywords(copy.ctas?.[i]?.keywords ?? [])}
              help={`The words ${name} visitors use, separated by commas, up to ${LIMITS.keywords}. The main keywords match too.`}
            />
            {cta.action !== "lead" && (
              <TextField
                name={f(`ctas.${i}.url`)}
                label={`Its link in ${name}`}
                value={copy.ctas?.[i]?.url ?? ""}
                placeholder={cta.url}
                onChange={(e) => update({ ctas: patchAt(copy.ctas, i, { url: text(e.target.value.trim()) }) })}
                error={errors[f(`ctas.${i}.url`)]}
                autoComplete="off"
                help={`The ${name} page, if the site has one. Left empty, it opens the link above.`}
              />
            )}
          </div>
        ))}
        <TextField
          name={f("handoffMessage")}
          label={`Handoff message in ${name}`}
          value={copy.handoffMessage ?? ""}
          placeholder={strings.handoff}
          onChange={(e) => update({ handoffMessage: text(e.target.value) })}
          maxLength={LIMITS.handoffMessage}
          error={errors[f("handoffMessage")]}
        />
        {contacts.map((contact, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: translations pair with the contacts by position.
          <div className="field-grid" key={`contact-${i}`}>
            <TextField
              name={f(`handoffContacts.${i}.url`)}
              label={`Contact ${i + 1} in ${name}`}
              value={copy.handoffContacts?.[i]?.url ?? ""}
              placeholder={contact.url}
              onChange={(e) => update({ handoffContacts: patchAt(copy.handoffContacts, i, { url: text(e.target.value.trim()) }) })}
              error={errors[f(`handoffContacts.${i}.url`)]}
              autoComplete="off"
              help="A page, tel: number or mailto: address for these visitors. Left empty, the one above."
            />
            <TextField
              name={f(`handoffContacts.${i}.label`)}
              label="Its label"
              value={copy.handoffContacts?.[i]?.label ?? ""}
              placeholder={
                contactParts(contact.url).type === "phone"
                  ? strings.callUs
                  : contactParts(contact.url).type === "email"
                    ? strings.emailUs
                    : strings.contactPage
              }
              onChange={(e) => update({ handoffContacts: patchAt(copy.handoffContacts, i, { label: text(e.target.value) }) })}
              maxLength={LIMITS.label}
              error={errors[f(`handoffContacts.${i}.label`)]}
            />
          </div>
        ))}
        <TextField
          name={f("placeholder")}
          label={`Question box placeholder in ${name}`}
          value={copy.placeholder ?? ""}
          placeholder={strings.placeholder}
          onChange={(e) => update({ placeholder: text(e.target.value) })}
          maxLength={LIMITS.placeholder}
          error={errors[f("placeholder")]}
        />
        <TextAreaField
          name={f("disclosure")}
          label={`AI disclosure in ${name}`}
          rows={2}
          value={copy.disclosure ?? ""}
          placeholder={strings.disclosure}
          onChange={(e) => update({ disclosure: text(e.target.value) })}
          maxLength={LIMITS.disclosure}
          error={errors[f("disclosure")]}
        />
        <TextField
          name={f("offlineMessage")}
          label={`Offline message in ${name}`}
          value={copy.offlineMessage ?? ""}
          placeholder={strings.offline}
          onChange={(e) => update({ offlineMessage: text(e.target.value) })}
          maxLength={LIMITS.offlineMessage}
          error={errors[f("offlineMessage")]}
        />
        {settings.lead?.enabled && (
          <>
            <TextAreaField
              name={f("leadIntro")}
              label={`Contact form intro in ${name}`}
              rows={2}
              value={copy.leadIntro ?? ""}
              placeholder={strings.leadIntro}
              onChange={(e) => update({ leadIntro: text(e.target.value) })}
              maxLength={LIMITS.leadText}
              error={errors[f("leadIntro")]}
            />
            <TextAreaField
              name={f("leadConsent")}
              label={`Consent checkbox in ${name}`}
              rows={2}
              value={copy.leadConsent ?? ""}
              placeholder={strings.consent}
              onChange={(e) => update({ leadConsent: text(e.target.value) })}
              maxLength={LIMITS.leadText}
              error={errors[f("leadConsent")]}
            />
          </>
        )}
        <div className="field-grid">
          {COPY_KEYS.map((key) => (
            <TextField
              key={key}
              name={f(`copy.${key}`)}
              label={`${COPY_LABELS[key][0]} in ${name}`}
              value={copy.copy?.[key] ?? ""}
              placeholder={strings[key]}
              onChange={(e) => update({ copy: { ...copy.copy, [key]: text(e.target.value) } })}
              maxLength={LIMITS.copy}
              error={errors[f(`copy.${key}`)]}
            />
          ))}
        </div>
      </div>
    </details>
  );
}

function patchAt<T extends object>(rows: T[] | undefined, i: number, patch: Partial<T>): T[] {
  const next = [...(rows ?? [])];
  while (next.length <= i) next.push({} as T);
  next[i] = { ...next[i]!, ...patch };
  return next;
}
