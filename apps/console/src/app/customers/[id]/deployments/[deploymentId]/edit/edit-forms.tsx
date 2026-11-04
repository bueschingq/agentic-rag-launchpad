"use client";

// The edit page's three forms. Domains suggest the www/apex twin of each domain. The prompt
// starts from a template, shows the answering rules the console adds, can be tried against the
// real Knowledge Box before saving, and any earlier version can be restored. Leads go to a
// webhook and/or email.

import type { PreflightResult } from "@launchpad/db";
import { isLanguage } from "@launchpad/theme";
import { startTransition, useActionState, useState, useTransition } from "react";
import { Badge } from "@/components/ui.tsx";
import { isStagingOrigin, missingTwins } from "@/lib/domain-rules.ts";
import { LANGUAGE_OPTIONS } from "@/lib/labels.ts";
import { composeUserPrompt } from "@/lib/prompt.ts";
import { PROMPT_TEMPLATES, type PromptTemplate, promptFromTemplate } from "@/lib/prompt-templates.ts";
import type { EditState } from "./actions.ts";

type Action = (previous: EditState, form: FormData) => Promise<EditState>;

function useForm(action: Action) {
  const [state, run, pending] = useActionState(action, { saved: 0 });
  const submit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    startTransition(() => run(form));
  };
  return { state, submit, pending };
}

function Outcome({ state, saved }: { state: EditState; saved: string }) {
  if (state.error) {
    return (
      <p className="notice" data-tone="critical" role="alert">
        {state.error}
      </p>
    );
  }
  return state.saved > 0 ? (
    <p className="notice" role="status">
      {saved}
    </p>
  ) : null;
}

export function DomainsForm({
  initial,
  initialStaging,
  action,
  check,
  preflight,
}: {
  initial: string[];
  // The domains marked staging or test (questions from them are test traffic).
  initialStaging: string[];
  action: Action;
  check: () => Promise<PreflightResult | undefined>;
  preflight: PreflightResult | null;
}) {
  const { state, submit, pending } = useForm(action);
  const [text, setText] = useState(initial.join("\n"));
  const [staging, setStaging] = useState(() => new Set(initialStaging));
  const [lock, setLock] = useState(preflight);
  const [checking, startCheck] = useTransition();
  const origins = text
    .split(/[\s,]+/)
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [new URL(line.includes("://") ? line : `https://${line}`).origin];
      } catch {
        return [];
      }
    });
  const twins = missingTwins(origins);

  return (
    <form className="form" onSubmit={submit} noValidate>
      <Outcome
        state={state}
        saved="Saved here and in the Knowledge Box's domain lock. The lock takes up to a minute to apply: check it below."
      />
      <div className="field">
        <label htmlFor="domains">Allowed domains</label>
        <textarea
          id="domains"
          name="domains"
          rows={4}
          value={text}
          onChange={(e) => setText(e.target.value)}
          aria-describedby="domains-help"
        />
        <p id="domains-help" className="help">
          One per line: production, staging and any other site that embeds the chat. Only these can show it.
        </p>
      </div>
      {origins.length > 0 && (
        <fieldset className="plain-fieldset">
          <legend className="label">Staging or production</legend>
          <ul className="plain">
            {[...new Set(origins)].map((o) => (
              <li key={o}>
                <label className="inline">
                  <input
                    type="checkbox"
                    name="staging"
                    value={o}
                    checked={staging.has(o) || isStagingOrigin(o, [])}
                    disabled={isStagingOrigin(o, [])}
                    onChange={(e) =>
                      setStaging((prev) => {
                        const next = new Set(prev);
                        if (e.target.checked) next.add(o);
                        else next.delete(o);
                        return next;
                      })
                    }
                  />{" "}
                  <code>{o}</code> is a staging or test site
                </label>
              </li>
            ))}
          </ul>
          <p className="help">
            Questions from staging sites are test traffic, kept out of the client's figures, and a chat answering only there shows "Live on
            staging". Addresses on this machine (localhost) always count as staging.
          </p>
        </fieldset>
      )}
      {twins.length > 0 && (
        <p className="suggest">
          Visitors may also reach the site at{" "}
          {twins.map((t, i) => (
            <span key={t}>
              {i > 0 && " or "}
              <code>{t}</code>
            </span>
          ))}
          .{" "}
          {twins.map((t) => (
            <button key={t} type="button" className="link-button" onClick={() => setText((v) => `${v.trimEnd()}\n${t}`)}>
              Add {twins.length > 1 ? t : "it"}
            </button>
          ))}
          . If it redirects to the other spelling instead, leave it out.
        </p>
      )}
      <div className="actions">
        <button className="button" type="submit" disabled={pending}>
          {pending ? "Saving…" : "Save domains"}
        </button>
        <button
          type="button"
          className="button secondary"
          disabled={checking}
          onClick={() => startCheck(async () => setLock((await check()) ?? null))}
        >
          {checking ? "Checking…" : "Check the domain lock"}
        </button>
      </div>
      {lock && (
        <ul className="plain" aria-live="polite">
          {lock.origins.map((o) => (
            <li key={o.origin}>
              <Badge tone={o.ok ? "good" : "warning"}>{o.ok ? "Locked in" : "Not yet"}</Badge> <code>{o.origin}</code>
            </li>
          ))}
        </ul>
      )}
    </form>
  );
}

interface Version {
  id: string;
  prompt: string;
  language: string;
  at: Date;
  by: string | null;
  byEmail: string | null;
}

export function AnswersForm({
  initialPrompt,
  initialLanguage,
  client,
  siteUrl,
  versions,
  drift,
  action,
  tryIt,
}: {
  initialPrompt: string;
  initialLanguage: string;
  // The name visitors see; undefined until it's set on the customer.
  client: string | undefined;
  siteUrl: string;
  versions: Version[];
  drift: string | null | undefined;
  action: Action;
  tryIt: (
    prompt: string,
    language: string,
    question: string,
  ) => Promise<{ answer?: string; sources?: { title: string; url: string }[]; error?: string }>;
}) {
  const { state, submit, pending } = useForm(action);
  const [prompt, setPrompt] = useState(initialPrompt || promptFromTemplate("general", client, siteUrl));
  const [language, setLanguage] = useState(initialLanguage);
  const [question, setQuestion] = useState("");
  const [tried, setTried] = useState<{ answer?: string; sources?: { title: string; url: string }[]; error?: string; prompt?: string }>();
  const [trying, startTry] = useTransition();

  return (
    <form className="form" onSubmit={submit} noValidate>
      <Outcome state={state} saved="Saved to the Knowledge Box. The site answers with it from the next question." />
      {drift !== undefined && (
        <p className="notice" data-tone="warning" role="note">
          The Knowledge Box's prompt was changed outside the console. Saving here replaces it.
          {drift && (
            <>
              {" "}
              It currently says: <q>{drift.length > 200 ? `${drift.slice(0, 200)}…` : drift}</q>
            </>
          )}
        </p>
      )}
      <div className="field-grid">
        <div className="field">
          <label htmlFor="language">Answer language</label>
          <select id="language" name="language" value={language} onChange={(e) => setLanguage(e.target.value)}>
            <option value="auto">Each visitor's own language</option>
            {LANGUAGE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="template">Start from a template</label>
          <select
            id="template"
            defaultValue=""
            onChange={(e) => {
              if (e.target.value) setPrompt(promptFromTemplate(e.target.value as PromptTemplate, client, siteUrl));
              e.target.value = "";
            }}
          >
            <option value="">Choose to replace the prompt…</option>
            {PROMPT_TEMPLATES.map((t) => (
              <option key={t.key} value={t.key}>
                {t.label}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="field">
        <label htmlFor="prompt">System prompt</label>
        <textarea
          id="prompt"
          name="prompt"
          rows={9}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          maxLength={4000}
          aria-describedby="prompt-help"
        />
        <p id="prompt-help" className="help">
          Persona, tone and what to refuse. The language rule, today's date (so past events are never "upcoming") and the answering rules
          below are added for you. {prompt.length.toLocaleString("en")} of 4,000 characters.
        </p>
        <details>
          <summary>Answering rules the console adds</summary>
          <p className="help">
            Read with the site's text and each question: answer in the right language, and keep each product's advice to that product. Each
            page's text reaches the chatbot with its title.
          </p>
          <pre className="prompt">{composeUserPrompt(language === "auto" || isLanguage(language) ? language : "en")}</pre>
        </details>
      </div>

      <div className="try-prompt">
        <label htmlFor="try-question" className="label">
          Try it before saving
        </label>
        <div className="inline-field">
          <input
            id="try-question"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="A question a visitor might ask"
            onKeyDown={(e) => {
              if (e.key === "Enter") e.preventDefault();
            }}
          />
          <button
            type="button"
            className="button secondary"
            disabled={trying || !question.trim()}
            onClick={() => startTry(async () => setTried({ ...(await tryIt(prompt, language, question)), prompt }))}
          >
            {trying ? "Asking…" : "Ask with this prompt"}
          </button>
        </div>
        <div aria-live="polite">
          {tried?.error && <p className="field-error">{tried.error}</p>}
          {tried?.answer !== undefined && (
            <div className="tried">
              <p>{tried.answer || <span className="muted">No answer.</span>}</p>
              {tried.sources && tried.sources.length > 0 && (
                <ul className="plain sources-list">
                  {tried.sources.map((s) => (
                    <li key={s.url}>
                      <a href={s.url} target="_blank" rel="noreferrer">
                        {s.title}
                      </a>
                    </li>
                  ))}
                </ul>
              )}
              <p className="help">
                {tried.prompt === prompt
                  ? "Answered with the prompt above, as a partner test (not billed)."
                  : "The prompt changed since: ask again."}
              </p>
            </div>
          )}
        </div>
      </div>

      <button className="button" type="submit" disabled={pending}>
        {pending ? "Saving…" : "Save prompt and language"}
      </button>

      {versions.length > 0 && (
        <details>
          <summary>Earlier versions ({versions.length})</summary>
          <ol className="versions">
            {versions.map((v) => (
              <li key={v.id}>
                <span>
                  {v.at.toISOString().slice(0, 16).replace("T", " ")} UTC · {v.by ?? v.byEmail ?? "Setup admin"} · {v.language}
                </span>
                <pre className="prompt">{v.prompt}</pre>
                <button
                  type="button"
                  className="link-button"
                  onClick={() => {
                    setPrompt(v.prompt);
                    setLanguage(v.language);
                  }}
                >
                  Restore this version<span className="sr-only"> from {v.at.toISOString().slice(0, 10)}</span>
                </button>{" "}
                <span className="help">then save.</span>
              </li>
            ))}
          </ol>
        </details>
      )}
    </form>
  );
}

export function LeadsForm({
  initial,
  action,
  email,
}: {
  initial: { webhookUrl?: string; emails?: string[] };
  action: Action;
  email: boolean;
}) {
  const { state, submit, pending } = useForm(action);
  return (
    <form className="form" onSubmit={submit} noValidate>
      <Outcome state={state} saved="Saved. New leads go there." />
      <div className="field">
        <label htmlFor="leadWebhookUrl">Webhook (the client's CRM, Zapier, Slack, Teams…)</label>
        <input
          id="leadWebhookUrl"
          name="leadWebhookUrl"
          type="url"
          defaultValue={initial.webhookUrl ?? ""}
          autoComplete="off"
          placeholder="https://"
        />
      </div>
      <div className="field">
        <label htmlFor="leadEmails">Email addresses</label>
        <input id="leadEmails" name="leadEmails" defaultValue={initial.emails?.join(", ") ?? ""} aria-describedby="leadEmails-help" />
        <p id="leadEmails-help" className="help">
          Separated by commas. {email ? "" : "Email needs SMTP set up on the console; until then, leads go to the webhook only."} Each lead
          is deleted from the console once delivered, or after 7 days of retries.
        </p>
      </div>
      <button className="button" type="submit" disabled={pending}>
        {pending ? "Saving…" : "Save lead delivery"}
      </button>
    </form>
  );
}
