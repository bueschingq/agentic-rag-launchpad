"use client";

// The content plan on New deployment: what the site's sitemaps hold, by section and language,
// the suggested exclusions (ticked, each with its count), and what the page budget takes. Every
// change reruns the plan on the server over the same sitemap read, so the numbers shown are
// the ones Create stores and the first sync uses. It says which sitemap it read and why, which
// folders' sitemap dates it doesn't trust, and, for a site with no usable sitemap, that the
// first sync follows links instead. Its Key pages line names the pricing, contact, support and
// similar pages it takes first, any it couldn't take and why, and what no address names. Key
// pages come from the sitemaps' addresses alone: the scan doesn't return the header's links.

import { useEffect, useState } from "react";
import { SelectField, TextAreaField, TextField } from "@/components/fields.tsx";
import { DEFAULT_EXCLUDES, MAX_PAGE_BUDGET, type SitefinityVersion } from "@/lib/content-form.ts";
import {
  blockedNote,
  type ContentPlan,
  crawlNote,
  discoveryNote,
  displayTag,
  formatPlanDay,
  incompleteNote,
  intentName,
  keyPagesNote,
  languageGapNote,
  type PlanRule,
  rateLimitNote,
  type SitemapDiscovery,
  sitemapFilesNote,
  stampNote,
} from "@/lib/content-plan.ts";

export interface PlanRead {
  total: number;
  files: number;
  sitemaps: string[];
  truncated: boolean;
  ms: number;
  discovery?: SitemapDiscovery;
  failed?: { url: string; status?: number; reason: string }[];
  unread?: string[];
  blocked?: { url: string; status?: number; by: string };
  rateLimited?: number;
  gzipped?: number;
  found?: string[];
}

// What the plan is doing while it loads, with the seconds so far: robots.txt and the sitemaps
// are read and the start page checked for bot protection side by side, then the key pages are
// checked to load. A blocked site is named within seconds; a big or rate-limiting one takes longer.
function PlanProgress({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const seconds = Math.max(0, Math.floor((now - since) / 1000));
  const step =
    seconds < 4
      ? "reading robots.txt and the sitemaps, and checking the start page for bot protection"
      : seconds < 15
        ? "reading the sitemap files, then checking that the key pages load"
        : "still reading: a large sitemap, or a site that rate-limits, is read more slowly (up to about 45 s)";
  return (
    <p className="help">
      Reading the site's sitemaps… {seconds} s: {step}.
    </p>
  );
}

export type PlanStatus =
  | { state: "idle" }
  | { state: "loading"; since: number }
  | { state: "ready"; plan: ContentPlan; read: PlanRead; ms: number }
  | { state: "failed"; error: string };

export interface PlanChoicesState {
  languages: string[] | undefined;
  rules: PlanRule[];
  budget: string;
  include: string;
  exclude: string;
  version: SitefinityVersion;
  sitemap: string;
}

interface Props {
  // The language the chat answers in, as the form has it ("auto", "de"; "" follows the customer's).
  answers?: string;
  status: PlanStatus;
  // The last plan computed, shown (dimmed) while a change is recomputed.
  shown?: { plan: ContentPlan; read: PlanRead; ms: number };
  choices: PlanChoicesState;
  onChange: (next: Partial<PlanChoicesState>) => void;
  errors: Record<string, string>;
  scanNote?: string;
  // The site address the plan was read for: where a crawl would start.
  site?: string;
}

const n = (value: number) => value.toLocaleString("en");
const VERSIONS = [
  { value: "unknown", label: "Not sure" },
  { value: "15.4+", label: "Sitefinity 15.4 or later" },
  { value: "earlier", label: "Sitefinity before 15.4" },
  { value: "none", label: "Not Sitefinity" },
];
const BREAKDOWN: PlanRule[] = ["archive", "year", "versions", "old"];
const SECTION_ROWS = 30;
const STAMP_NOTES = 5;

export function PlanPanel({ status, shown, choices, onChange, errors, scanNote, site, answers = "" }: Props) {
  const plan = shown?.plan;
  const toggle = <T,>(list: readonly T[], item: T, on: boolean) => (on ? [...new Set([...list, item])] : list.filter((x) => x !== item));
  const selectedLanguages = choices.languages ?? plan?.languages.filter((l) => l.selected).map((l) => l.tag) ?? [];
  const found = discoveryNote(shown?.read.discovery);
  // Files that failed or weren't reached: the counts and languages may be short.
  const incomplete = shown ? incompleteNote(shown.read) : undefined;
  // An incomplete read can't say which languages the site has: until the partner chooses, none is
  // sent, and the sync takes every language it finds that the deployment answers in.
  const submitLanguages = !incomplete || choices.languages !== undefined;
  // No page in any sitemap: the first sync crawls from the site address instead.
  const crawl = plan?.total === 0;
  // Plans computed before key pages existed (a console older than the route) have none.
  const keys = plan?.keyPages && !crawl ? keyPagesNote(plan.keyPages) : undefined;
  // The largest sections first; the rest on request.
  const [allSections, setAllSections] = useState(false);
  const rows = allSections ? Number.POSITIVE_INFINITY : SECTION_ROWS;

  return (
    <fieldset className="panel" aria-describedby="plan-status">
      <legend>Content plan</legend>
      <div id="plan-status" role="status">
        {status.state === "idle" && !plan && (
          <p className="help">
            Enter the site address above. The plan reads the site's sitemaps (no page is loaded) and shows here within seconds.
          </p>
        )}
        {status.state === "loading" && <PlanProgress since={status.since} />}
        {status.state === "failed" && (
          <p className="notice" data-tone="warning">
            {status.error} Without a sitemap, the first sync follows links from the site address, up to the page budget.
          </p>
        )}
        {plan && shown && !crawl && (
          <p>
            The site's sitemaps list <strong>{n(plan.total)}</strong> pages
            {shown.read.truncated && ` (they list more: the plan reads the first ${n(plan.total)}, in sitemap order)`}.{" "}
            {plan.scope && (
              <>
                <strong>{n(plan.inScope)}</strong> {plan.scope}.{" "}
              </>
            )}
            <span className="muted">
              Read in {(shown.read.ms / 1000).toFixed(1)} s from {sitemapFilesNote(shown.read.files, shown.read.gzipped)}.
              {shown.read.found?.length
                ? ` Not in the sitemaps, found from the home page or a common address: ${shown.read.found.map((url) => new URL(url).pathname).join(", ")}.`
                : ""}
            </span>
          </p>
        )}
        {shown?.read.blocked && (
          <p className="notice" data-tone="critical">
            {blockedNote(shown.read.blocked)}
          </p>
        )}
        {plan && crawl && !shown?.read.blocked && (
          <p className="notice">
            {crawlNote(site ?? "the site address", Number(choices.budget) || 0)} Create works as usual; the first sync reports how many
            pages the crawl found.
          </p>
        )}
        {found && <p className="help">{found}</p>}
        {shown?.read.rateLimited && !incomplete ? <p className="help">{rateLimitNote(shown.read.rateLimited)}</p> : null}
        {incomplete && (
          <p className="notice" data-tone="warning">
            {incomplete}
          </p>
        )}
      </div>
      {scanNote && <p className="help">{scanNote}</p>}

      <TextField
        name="sitemap"
        label="Sitemap address (optional)"
        type="url"
        inputMode="url"
        placeholder="https://www.example.com/sitemap.xml"
        value={choices.sitemap}
        onChange={(e) => onChange({ sitemap: e.target.value })}
        error={errors.sitemap}
        help="Leave empty to find it: the sitemaps robots.txt lists, else /sitemap.xml, /sitemap/sitemap.xml or /sitemap_index.xml on the site. A sitemap entered here is read instead."
        autoComplete="off"
      />

      {plan && !crawl && plan.dated === 0 && (
        <p className="notice" data-tone="warning">
          This sitemap has no dates. The year-in-URL rules still apply, and each page's own date is read as it loads. Check the sections by
          hand.
        </p>
      )}
      {plan && plan.stamped.length > 0 && (
        <div className="notice" data-tone="warning">
          <p>
            Sitemap dates these folders share aren't the pages' own, so the plan treats them as unknown and goes by dates in the addresses;
            each page's own date is read as it loads:
          </p>
          <ul>
            {plan.stamped.slice(0, STAMP_NOTES).map((s) => (
              <li key={`${s.section} ${s.day}`}>{stampNote(s)}.</li>
            ))}
            {plan.stamped.length > STAMP_NOTES && (
              <li>
                <details>
                  <summary>
                    And {n(plan.stamped.length - STAMP_NOTES)} more, with{" "}
                    {n(plan.stamped.slice(STAMP_NOTES).reduce((t, s) => t + s.pages, 0))} pages
                  </summary>
                  <ul>
                    {plan.stamped.slice(STAMP_NOTES).map((s) => (
                      <li key={`${s.section} ${s.day}`}>{stampNote(s)}.</li>
                    ))}
                  </ul>
                </details>
              </li>
            )}
          </ul>
        </div>
      )}

      {plan && plan.languages.length > 0 && (
        <fieldset className="choices">
          <legend className="label">Languages to sync</legend>
          {/* The languages error can only name this control when it's on the page. */}
          {submitLanguages && <input type="hidden" name="languagesShown" value="1" />}
          {!submitLanguages && (
            <p className="help">
              The sitemap read is incomplete, so this list may lack languages. Unless you choose here, the sync takes every language it
              finds that the deployment answers in.
            </p>
          )}
          {plan.languages.map((l, i) => (
            <label key={l.tag} className="choice">
              <input
                type="checkbox"
                name={submitLanguages ? "languages" : undefined}
                value={l.tag}
                id={i === 0 ? "languages" : undefined}
                checked={selectedLanguages.includes(l.tag)}
                onChange={(e) => onChange({ languages: toggle(selectedLanguages, l.tag, e.target.checked) })}
              />
              <span>
                <span>
                  {l.label}
                  {l.tag !== "und" && <span className="muted"> ({displayTag(l.tag)})</span>}: {n(l.pages)} pages
                </span>
                {l.tag === "und" && <span className="help">The sitemap gives no language: taken to be the site's own.</span>}
                {!l.supported && <span className="help">The widget doesn't support this language.</span>}
              </span>
            </label>
          ))}
          {errors.languages && <p className="field-error">{errors.languages}</p>}
          {(() => {
            const gap = languageGapNote(answers, plan.languages, selectedLanguages);
            return gap ? (
              <p className="notice" data-tone="warning" role="note">
                {gap}
              </p>
            ) : null;
          })()}
        </fieldset>
      )}

      {plan && !crawl && (
        <fieldset className="choices">
          <legend className="label">Suggested exclusions</legend>
          <p className="help">
            Ticked to leave out. Untick any you want the chatbot to answer from. As each page loads, the date rules go by the page's own
            date, and articles (blog, news, webinars…) that state a price, offer or version and were published over 12 months ago are left
            out.
          </p>
          {plan.suggestions.map((s) => (
            <label key={s.rule} className="choice">
              <input
                type="checkbox"
                name="rules"
                value={s.rule}
                checked={choices.rules.includes(s.rule)}
                onChange={(e) => onChange({ rules: toggle(choices.rules, s.rule, e.target.checked) })}
              />
              <span>
                <span>
                  {s.label}: <strong>{n(s.pages)}</strong> {s.pages === 1 ? "page" : "pages"}
                </span>
                {s.rule === "duplicate" && <span className="help">Canonical URLs are checked as each page loads.</span>}
                {s.wholeSections.length > 0 && <span className="help">Whole sections: {s.wholeSections.join(", ")}</span>}
                {BREAKDOWN.includes(s.rule) && s.bySection.length > 0 && (
                  <span className="help">
                    Most in {s.bySection.map((b) => `${b.path} (${n(b.pages)})`).join(", ")}
                    {s.bySection.length === 8 ? ", …" : ""}
                  </span>
                )}
              </span>
            </label>
          ))}
        </fieldset>
      )}

      <div className="field-grid">
        <TextField
          name="pageBudget"
          label="Page budget"
          type="number"
          min={1}
          max={MAX_PAGE_BUDGET}
          value={choices.budget}
          onChange={(e) => onChange({ budget: e.target.value })}
          error={errors.pageBudget}
          help="Served-language, specific pages first, newest first, in turn from each section."
        />
        <SelectField
          name="sitefinityVersion"
          label="Sitefinity version"
          options={VERSIONS}
          value={choices.version}
          onChange={(e) => onChange({ version: e.target.value as SitefinityVersion })}
          help="From the scan where the site says; the version is often hidden, so ask the client's web team if unsure."
        />
      </div>
      <div className="field-grid">
        <TextAreaField
          name="include"
          label="Only these paths (optional)"
          rows={3}
          value={choices.include}
          onChange={(e) => onChange({ include: e.target.value })}
          error={errors.include}
          placeholder={"/en/\n/services/*"}
          help="One per line. /en matches /en and everything under it; * matches anything."
        />
        <TextAreaField
          name="exclude"
          label="Leave out"
          rows={3}
          value={choices.exclude}
          onChange={(e) => onChange({ exclude: e.target.value })}
          error={errors.exclude}
          help={`One per line. Defaults: ${DEFAULT_EXCLUDES.join(", ")}.`}
        />
      </div>

      {plan && !crawl && (
        <p className="callout" aria-live="polite">
          The budget takes about <strong>{n(plan.taken)}</strong> of the {n(plan.eligible)} pages left in the plan.{" "}
          {/* With no sitemap dates, every date the plan has is one in an address. */}
          {plan.oldestTaken ? (
            <>
              Oldest page taken, by the {plan.dated ? "sitemaps and addresses" : "addresses"}:{" "}
              <strong>{formatPlanDay(plan.oldestTaken)}</strong>.
            </>
          ) : plan.dated ? (
            "None of them has a date in the sitemaps or addresses."
          ) : (
            "None of them has a date in its address."
          )}
          {plan.oldestTaken && plan.undatedTaken > 0 && ` ${n(plan.undatedTaken)} have no date there.`}{" "}
          <span className="muted">
            Estimates: each page's own date is read as it loads, and a page the date rules then leave out is replaced by the next one.
          </span>
        </p>
      )}

      {plan && keys && (
        <div className="callout" aria-live="polite">
          <p>
            {keys.taken}
            {plan.keyPages.taken.length > 0 && (
              <span className="muted">
                {" "}
                Each is checked as it loads: one with almost no text, gone, or an error page gives its place to the next page for the same
                question, and Content lists the ones that couldn't be used, and why.
              </span>
            )}
          </p>
          {keys.notTaken && <p className="help">{keys.notTaken}</p>}
          {keys.none && (
            <p className="notice" data-tone="warning">
              {keys.none}
            </p>
          )}
          {plan.keyPages.taken.length > 0 && (
            <details>
              <summary>
                The {plan.keyPages.taken.length === 1 ? "key page" : `${n(plan.keyPages.taken.length)} key pages`}, by what they answer
              </summary>
              <ul className="plain">
                {plan.keyPages.taken.map((k) => (
                  <li key={k.path} className="sub" style={{ overflowWrap: "anywhere" }}>
                    {k.path} <span className="muted">· {intentName(k.intent)}</span>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}

      {plan && plan.sections.length > 0 && (
        <details className="settings-details">
          <summary>
            Sections ({n(plan.sections.length)}
            {plan.scope ? `, ${plan.scope}` : ""}, in the languages chosen)
          </summary>
          <p className="help">Open a section to see the pages the budget takes from it.</p>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">Section</th>
                  <th scope="col" className="num">
                    Pages
                  </th>
                  <th scope="col">Newest</th>
                  <th scope="col">Oldest</th>
                  <th scope="col" className="num">
                    Not updated in 2 years
                  </th>
                  <th scope="col" className="num">
                    Taken
                  </th>
                  <th scope="col">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {plan.sections.slice(0, rows).map((s) => (
                  <tr key={s.path}>
                    <td style={{ whiteSpace: "normal" }}>
                      {s.takes.length > 0 ? (
                        <details>
                          <summary>
                            <code>{s.path}</code>
                            <span className="sr-only">: the {s.takes.length === 1 ? "page" : `${n(s.takes.length)} pages`} it takes</span>
                          </summary>
                          <ul className="plain">
                            {s.takes.map((t) => (
                              <li key={t.path} className="sub" style={{ overflowWrap: "anywhere" }}>
                                {t.path}
                                {t.date && <span className="muted"> · {formatPlanDay(t.date)}</span>}
                              </li>
                            ))}
                          </ul>
                        </details>
                      ) : (
                        <code>{s.path}</code>
                      )}
                    </td>
                    <td className="num">{n(s.pages)}</td>
                    <td>{s.newest ? formatPlanDay(s.newest) : "—"}</td>
                    <td>{s.oldest ? formatPlanDay(s.oldest) : "—"}</td>
                    <td className="num">{s.old ? n(s.old) : ""}</td>
                    <td className="num">{s.taken ? n(s.taken) : ""}</td>
                    <td>
                      {s.path !== "/" && !choices.exclude.split(/\n/).includes(s.path) && (
                        <button
                          type="button"
                          className="link-button"
                          onClick={() => onChange({ exclude: `${choices.exclude.trimEnd()}\n${s.path}`.trim() })}
                        >
                          Leave out<span className="sr-only"> {s.path}</span>
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {plan.sections.length > rows && (
            <p className="help">
              And {n(plan.sections.length - SECTION_ROWS)} smaller sections, with{" "}
              {n(plan.sections.slice(SECTION_ROWS).reduce((t, s) => t + s.pages, 0))} pages.{" "}
              <button type="button" className="link-button" onClick={() => setAllSections(true)}>
                Show them
              </button>
            </p>
          )}
        </details>
      )}
      {plan && <input type="hidden" name="planShown" value="1" />}
    </fieldset>
  );
}
