"use client";

// The new-deployment form: which customer, which site, the content plan, which language, and
// the system prompt, which starts from a template filled in with the customer's name and site.
// Entering the site address reads its sitemaps for the plan and scans the site, side by side;
// Create applies the plan and starts the first sync once the Knowledge Box exists.

import { languageSetting } from "@launchpad/theme";
import Link from "next/link";
import { startTransition, useActionState, useEffect, useRef, useState } from "react";
import { ErrorSummary, SelectField, TextAreaField, TextField } from "@/components/fields.tsx";
import {
  DEFAULT_EXCLUDES,
  DEFAULT_PAGE_BUDGET,
  parsePatterns,
  parseSitemapAddress,
  type SitefinityVersion,
  siteAddress,
} from "@/lib/content-form.ts";
import { type ContentPlan, PLAN_RULES } from "@/lib/content-plan.ts";
import { MAX_PROMPT } from "@/lib/deployment-form.ts";
import { defaultStagingDomains, missingTwins } from "@/lib/domain-rules.ts";
import { emptyForm } from "@/lib/form-state.ts";
import { LANGUAGE_OPTIONS, languageLabel } from "@/lib/labels.ts";
import { PROMPT_TEMPLATES, type PromptTemplate, promptFromTemplate, visitorName } from "@/lib/prompt-templates.ts";
import { saveDeployment } from "./actions.ts";
import { type PlanChoicesState, PlanPanel, type PlanRead, type PlanStatus } from "./plan-panel.tsx";

export interface CustomerOption {
  id: string;
  name: string;
  displayName: string | null;
  language: string;
}

interface Props {
  customers: CustomerOption[];
  customerId?: string;
  // The account's Knowledge Box allowance; full: none left, so Create is off.
  capacity?: { text: string; tone: "good" | "warning" | "critical"; full: boolean };
}

type ScanState =
  | { state: "idle" }
  | { state: "scanning" }
  | { state: "done"; platform: string; siteName?: string; version: SitefinityVersion }
  | { state: "failed"; error: string };

const originOf = (raw: string) => {
  try {
    return new URL(raw.includes("://") ? raw : `https://${raw}`).origin;
  } catch {
    return undefined;
  }
};

const PLATFORMS: Record<string, string> = { sitefinity: "Sitefinity", wordpress: "WordPress", drupal: "Drupal", sitecore: "Sitecore" };

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const json = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(json.error ?? "The console didn't answer.");
  return json;
}

export function DeploymentForm({ customers, customerId, capacity }: Props) {
  const [state, action, pending] = useActionState(saveDeployment, emptyForm);
  const { errors, values } = state;
  const value = (name: string, fallback = "") => values[name] ?? fallback;
  const [chosen, setChosen] = useState(() => value("customerId", customerId ?? ""));
  const [filter, setFilter] = useState("");
  const [site, setSite] = useState(() => value("siteUrl"));
  const [extra, setExtra] = useState(() => value("extraDomains"));
  const [language, setLanguage] = useState(() => value("language"));
  const [template, setTemplate] = useState<PromptTemplate>("general");
  const customer = customers.find((c) => c.id === chosen);
  const [prompt, setPrompt] = useState(() => value("systemPrompt"));
  // Until the partner edits it, the prompt follows the template, customer and site.
  const [edited, setEdited] = useState(() => Boolean(values.systemPrompt));
  const shownPrompt = edited
    ? prompt
    : promptFromTemplate(template, customer ? visitorName(customer) : "the organization", site || "its website");
  const inherited = customer ? `Customer's language (${languageLabel(languageSetting(customer.language))})` : "Customer's language";
  const listed = customers.filter((c) => !filter || c.name.toLowerCase().includes(filter.toLowerCase()) || c.id === chosen);
  const siteOrigin = originOf(site);
  const extraOrigins = extra.split(/[\s,]+/).flatMap((x) => originOf(x) ?? []);
  const twins = siteOrigin ? missingTwins([siteOrigin, ...extraOrigins]).filter((t) => !extraOrigins.includes(t)) : [];
  // Each extra domain is a staging or test site unless the partner says otherwise: questions
  // from staging are test traffic, and answering only there is "Live on staging".
  const [stagingChoice, setStagingChoice] = useState<Record<string, boolean>>({});
  const stagingByDefault = siteOrigin ? defaultStagingDomains(siteOrigin, extraOrigins) : extraOrigins;
  const isStaging = (origin: string) => stagingChoice[origin] ?? stagingByDefault.includes(origin);
  const shownOrigins = [...new Set(extraOrigins.filter((o) => o !== siteOrigin))];
  // The plan serves the deployment's language, or the customer's when it inherits it.
  const served = language || customer?.language || "en";

  // ---- the site address brings up the plan and the scan ----
  const [planSite, setPlanSite] = useState<string>();
  const [choices, setChoices] = useState<PlanChoicesState>({
    languages: undefined,
    rules: [...PLAN_RULES],
    budget: String(DEFAULT_PAGE_BUDGET),
    include: "",
    exclude: DEFAULT_EXCLUDES.join("\n"),
    version: "unknown",
    sitemap: value("sitemap"),
  });
  const touched = useRef(new Set<keyof PlanChoicesState>());
  const [planStatus, setPlanStatus] = useState<PlanStatus>({ state: "idle" });
  const [shown, setShown] = useState<{ plan: ContentPlan; read: PlanRead; ms: number }>();
  const [scan, setScan] = useState<ScanState>({ state: "idle" });
  const [scanToken, setScanToken] = useState<string>();
  const planRequest = useRef(0);

  // A settled address (typing paused) starts a fresh plan and scan.
  useEffect(() => {
    const address = siteAddress(site);
    const timer = setTimeout(() => setPlanSite((current) => (address && current !== address ? address : current)), 700);
    return () => clearTimeout(timer);
  }, [site]);

  useEffect(() => {
    if (!planSite) return;
    const path = new URL(planSite).pathname.replace(/\/+$/, "");
    setChoices((c) => ({
      ...c,
      languages: undefined,
      ...(!touched.current.has("include") && { include: path }),
    }));
    setShown(undefined);
    const token = crypto.randomUUID();
    setScanToken(token);
    setScan({ state: "scanning" });
    post<{ platform: { platform: string; version?: string }; siteName?: string; sitefinityVersion: SitefinityVersion }>(
      "/deployments/new/scan",
      { site: planSite, token },
    )
      .then((result) => {
        setScan({
          state: "done",
          platform: result.platform.platform,
          version: result.sitefinityVersion,
          ...(result.siteName && { siteName: result.siteName }),
        });
        if (!touched.current.has("version")) setChoices((c) => ({ ...c, version: result.sitefinityVersion }));
      })
      .catch((err: Error) => setScan({ state: "failed", error: err.message }));
  }, [planSite]);

  // Each change reruns the plan over the same sitemap read (the server keeps it). A sitemap
  // address counts once it's a whole one.
  const languagesKey = choices.languages?.join(",");
  const rulesKey = choices.rules.join(",");
  const sitemap = parseSitemapAddress(choices.sitemap).sitemap;
  useEffect(() => {
    if (!planSite) return;
    const request = ++planRequest.current;
    const started = Date.now();
    const timer = setTimeout(() => {
      setPlanStatus({ state: "loading", since: started });
      post<{ plan: ContentPlan; read: PlanRead }>("/deployments/new/plan", {
        site: planSite,
        ...(sitemap && { sitemap }),
        language: served,
        ...(languagesKey !== undefined && { languages: languagesKey ? languagesKey.split(",") : [] }),
        rules: rulesKey ? rulesKey.split(",") : [],
        include: parsePatterns(choices.include).patterns,
        exclude: parsePatterns(choices.exclude).patterns,
        budget: Number(choices.budget) || DEFAULT_PAGE_BUDGET,
      })
        .then((result) => {
          if (request !== planRequest.current) return;
          const ready = { ...result, ms: Date.now() - started };
          setShown(ready);
          setPlanStatus({ state: "ready", ...ready });
        })
        .catch((err: Error) => {
          if (request === planRequest.current) setPlanStatus({ state: "failed", error: err.message });
        });
    }, 350);
    return () => clearTimeout(timer);
  }, [planSite, sitemap, served, languagesKey, rulesKey, choices.include, choices.exclude, choices.budget]);

  const changePlan = (next: Partial<PlanChoicesState>) => {
    for (const key of Object.keys(next) as (keyof PlanChoicesState)[]) touched.current.add(key);
    setChoices((c) => ({ ...c, ...next }));
  };

  const scanNote =
    scan.state === "scanning"
      ? "Scanning the site for its look at the same time. Nothing from the scan is applied: the widget page shows it to confirm."
      : scan.state === "done"
        ? `Scanned: ${PLATFORMS[scan.platform] ?? "platform not recognised"}${scan.siteName ? `, “${scan.siteName}”` : ""}. The widget page shows the scan's colors, name and logo to confirm.`
        : scan.state === "failed"
          ? `The scan didn't finish (${scan.error}) The widget page can scan again.`
          : undefined;
  const reading = planStatus.state === "loading" && !shown;

  return (
    <form
      className="form wide"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        const form = new FormData(e.currentTarget);
        startTransition(() => action(form));
      }}
    >
      <ErrorSummary errors={errors} />

      <fieldset className="panel">
        <legend>Customer</legend>
        {customers.length > 8 && (
          <div className="field">
            <label htmlFor="customer-filter">Find a customer</label>
            <input id="customer-filter" type="search" value={filter} onChange={(e) => setFilter(e.target.value)} autoComplete="off" />
          </div>
        )}
        <SelectField
          name="customerId"
          label="Customer (required)"
          options={[
            { value: "", label: listed.length ? "Choose a customer" : "No customer matches" },
            ...listed.map((c) => ({ value: c.id, label: c.name })),
          ]}
          value={chosen}
          onChange={(e) => setChosen(e.target.value)}
          error={errors.customerId}
          required
        />
        <p className="help">
          Not listed? <Link href="/customers/new?next=deployment">Add a new customer</Link> and you'll come back here.
        </p>
      </fieldset>

      <fieldset className="panel">
        <legend>Site</legend>
        <TextField
          name="name"
          label="Deployment name (required)"
          defaultValue={value("name")}
          error={errors.name}
          maxLength={120}
          help="Usually the site or section the chat serves, e.g. “Main site” or “Patient portal”."
        />
        <TextField
          name="siteUrl"
          label="Site address (required)"
          type="url"
          inputMode="url"
          placeholder="https://www.example.com"
          value={site}
          onChange={(e) => setSite(e.target.value)}
          onBlur={() => {
            const address = siteAddress(site);
            if (address && address !== planSite) setPlanSite(address);
          }}
          error={errors.siteUrl}
          help="The chatbot is locked to this site's domain, and its pages are synced from here. A section's address (…/sitefinity-cms) limits the plan to it."
        />
        <TextAreaField
          name="extraDomains"
          label="Other domains allowed to embed it (optional)"
          rows={2}
          value={extra}
          onChange={(e) => setExtra(e.target.value)}
          error={errors.extraDomains}
          help="One per line: a staging site, other language sites."
        />
        {shownOrigins.length > 0 && (
          <fieldset className="choices">
            <legend className="label">Staging or test sites</legend>
            <p className="help">
              Questions asked there count as test traffic, not the client's, and a chat that answers only there is “Live on staging”.
            </p>
            <input type="hidden" name="stagingShown" value="1" />
            {shownOrigins.map((origin) => (
              <label key={origin} className="choice">
                <input
                  type="checkbox"
                  name="stagingDomains"
                  value={origin}
                  checked={isStaging(origin)}
                  onChange={(e) => setStagingChoice((c) => ({ ...c, [origin]: e.target.checked }))}
                />
                <span>
                  <code>{origin}</code> is a staging or test site
                </span>
              </label>
            ))}
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
              <button
                key={t}
                type="button"
                className="link-button"
                onClick={() => setExtra((v) => `${v.trim() ? `${v.trimEnd()}\n` : ""}${t}`)}
              >
                Add {twins.length > 1 ? t : "it"}
              </button>
            ))}
            . Leave it out if it redirects to the other spelling.
          </p>
        )}
      </fieldset>

      <PlanPanel
        status={planStatus}
        shown={shown}
        choices={choices}
        onChange={changePlan}
        errors={errors}
        {...(scanNote && { scanNote })}
        {...(planSite && { site: planSite })}
        answers={language}
      />
      {scanToken && <input type="hidden" name="scanToken" value={scanToken} />}

      <fieldset className="panel">
        <legend>Answers</legend>
        <SelectField
          name="language"
          label="Language"
          options={[{ value: "", label: inherited }, { value: "auto", label: "Each visitor's own language" }, ...LANGUAGE_OPTIONS]}
          value={language}
          onChange={(e) => {
            setLanguage(e.target.value);
            // The plan's languages follow the deployment's until the partner picks their own.
            if (!touched.current.has("languages")) setChoices((c) => ({ ...c, languages: undefined }));
          }}
          error={errors.language}
          help="The chatbot answers in this language, and the chat's buttons and messages use it too. The plan syncs pages in it."
        />
        <SelectField
          name="template"
          label="Prompt template"
          options={PROMPT_TEMPLATES.map((t) => ({ value: t.key, label: t.label }))}
          value={template}
          onChange={(e) => {
            setTemplate(e.target.value as PromptTemplate);
            setEdited(false);
          }}
          help="Healthcare and financial services refuse personal advice and point to a person instead."
        />
        <TextAreaField
          name="systemPrompt"
          label="System prompt"
          rows={9}
          maxLength={MAX_PROMPT}
          value={shownPrompt}
          onChange={(e) => {
            setPrompt(e.target.value);
            setEdited(true);
          }}
          error={errors.systemPrompt}
          help={`Filled in from the template with the customer and site; edit it freely. Up to ${MAX_PROMPT.toLocaleString("en-US")} characters; the language rule is added for you.`}
        />
      </fieldset>

      {capacity && (
        <p className="notice" data-tone={capacity.tone === "good" ? undefined : capacity.tone} role={capacity.full ? "alert" : undefined}>
          {capacity.text}
        </p>
      )}
      <button className="button" type="submit" disabled={pending || capacity?.full || reading}>
        {pending ? "Creating the Knowledge Box…" : reading ? "Reading the sitemaps…" : "Create and start sync"}
      </button>
      {pending && (
        <p className="help" role="status">
          Creating the Knowledge Box, its keys and the prompt, then inviting contacts. About 10 seconds; the first sync then starts with the
          plan as shown.
        </p>
      )}
    </form>
  );
}
