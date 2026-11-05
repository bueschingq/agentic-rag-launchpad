"use client";

// The content settings form: Sitefinity version first (15.4 and later can push content with
// Sitefinity's own connector), then the sitemap sync's sitemap address or start page, page
// budget, path rules and schedule. Saving starts a sync.

import { startTransition, useActionState, useState } from "react";
import { ErrorSummary, SelectField, TextAreaField, TextField } from "@/components/fields.tsx";
import { DEFAULT_EXCLUDES, MAX_PAGE_BUDGET, RESYNC_OPTIONS, type SitefinityVersion } from "@/lib/content-form.ts";
import { isSitemapAddress } from "@/lib/content-plan.ts";
import type { ContentFormState } from "./actions.ts";

interface Props {
  action: (previous: ContentFormState, form: FormData) => Promise<ContentFormState>;
  initial: {
    path: "sitemap" | "sitefinity_connector";
    sitefinityVersion: SitefinityVersion;
    startUrl: string;
    pageBudget: number;
    include: string[];
    exclude: string[];
    resync: string;
  };
  platform?: string;
  // The deployment's site address: the start page while a sitemap address is set (both are kept
  // in one place, sync_sources.sitemapUrl).
  siteUrl?: string;
}

const VERSIONS = [
  { value: "unknown", label: "Not sure" },
  { value: "15.4+", label: "Sitefinity 15.4 or later" },
  { value: "earlier", label: "Sitefinity before 15.4" },
  { value: "none", label: "Not Sitefinity" },
];

export function ContentSettings({ action, initial, platform, siteUrl }: Props) {
  const [state, save, saving] = useActionState(action, { errors: {}, saved: 0 });
  const sitemap = isSitemapAddress(initial.startUrl) ? initial.startUrl : "";
  const startUrl = sitemap ? (siteUrl ?? `${new URL(sitemap).origin}/`) : initial.startUrl;
  const [version, setVersion] = useState<string>(initial.sitefinityVersion);
  const [path, setPath] = useState(initial.path);
  const connectorPossible = version === "15.4+";

  return (
    <form
      className="form content-settings"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        const form = new FormData(e.currentTarget);
        startTransition(() => save(form));
      }}
    >
      <ErrorSummary errors={state.errors} />
      {state.saved > 0 && Object.keys(state.errors).length === 0 && (
        <p className="notice" role="status">
          Saved.{" "}
          {path !== "sitemap"
            ? "The sitemap sync stands down while the connector syncs."
            : state.restarted
              ? "The running sync starts over with these rules within a minute, and pages it already sent that the rules now leave out are taken out of the Knowledge Box."
              : "A sync starts within a minute."}
        </p>
      )}
      <SelectField
        name="sitefinityVersion"
        label="Sitefinity version"
        options={VERSIONS}
        value={version}
        onChange={(e) => {
          setVersion(e.target.value);
          if (e.target.value !== "15.4+") setPath("sitemap");
        }}
        help={
          platform === "sitefinity"
            ? "The scan found Sitefinity. The version isn't public: ask the client's web team, or keep 'Not sure'."
            : "Sitefinity 15.4 and later can push content with its own connector."
        }
      />
      {connectorPossible && (
        <fieldset className="choices">
          <legend className="label">How content gets in</legend>
          <label className="inline">
            <input
              type="radio"
              name="path"
              value="sitefinity_connector"
              checked={path === "sitefinity_connector"}
              onChange={() => setPath("sitefinity_connector")}
            />
            Sitefinity's connector: the CMS pushes pages as they're published
          </label>
          <label className="inline">
            <input type="radio" name="path" value="sitemap" checked={path === "sitemap"} onChange={() => setPath("sitemap")} />
            Sitemap sync from here
          </label>
        </fieldset>
      )}
      {!connectorPossible && <input type="hidden" name="path" value="sitemap" />}
      {path === "sitemap" && (
        <>
          <TextField
            name="sitemap"
            label="Sitemap address (optional)"
            type="url"
            inputMode="url"
            placeholder="https://www.example.com/sitemap.xml"
            defaultValue={sitemap}
            error={state.errors.sitemap}
            help="Read instead of finding one, for example when robots.txt points to another site's sitemap."
            autoComplete="off"
          />
          <div className="field-grid">
            <TextField
              name="startUrl"
              label="Start page"
              defaultValue={startUrl}
              error={state.errors.startUrl}
              help="Without a sitemap address, sitemaps are found from here (robots.txt, /sitemap.xml, Sitefinity's /sitemap/sitemap.xml, /sitemap_index.xml); a site without one is crawled from it."
              autoComplete="off"
            />
            <TextField
              name="pageBudget"
              label="Page budget"
              type="number"
              min={1}
              max={MAX_PAGE_BUDGET}
              defaultValue={initial.pageBudget}
              error={state.errors.pageBudget}
              help="Pages in the served language and specific pages (not listings) first, in turn from each section, newest first. The plan's languages and suggested exclusions still apply."
            />
          </div>
          <div className="field-grid">
            <TextAreaField
              name="include"
              label="Only these paths (optional)"
              rows={3}
              defaultValue={initial.include.join("\n")}
              error={state.errors.include}
              placeholder={"/en/\n/services/*"}
              help="One per line. /en matches /en and everything under it; * matches anything."
            />
            <TextAreaField
              name="exclude"
              label="Leave out"
              rows={3}
              defaultValue={initial.exclude.join("\n")}
              error={state.errors.exclude}
              help={`One per line. Defaults: ${DEFAULT_EXCLUDES.join(", ")}.`}
            />
          </div>
          <SelectField
            name="resync"
            label="Sync again"
            options={Object.entries(RESYNC_OPTIONS).map(([value, label]) => ({ value, label }))}
            defaultValue={initial.resync}
            help="Each sync resends only pages whose text changed, and takes pages that left the site out of the Knowledge Box."
          />
        </>
      )}
      <button className="button" type="submit" disabled={saving}>
        {saving ? "Saving…" : path === "sitemap" ? "Save and sync" : "Save"}
      </button>
    </form>
  );
}
