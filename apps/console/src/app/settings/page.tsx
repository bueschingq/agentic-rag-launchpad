// The partner's contract terms: what Agentic RAG charges them, and the markup they add for
// their customers. Every cost on the dashboard comes from these.

import { loadSettings } from "@/lib/dashboard.ts";
import { currency } from "@/lib/env.ts";
import { FIELD_ERRORS, type SettingsField } from "@/lib/settings-form.ts";
import { saveSettings } from "./actions.ts";

export const dynamic = "force-dynamic";

type Props = { searchParams: Promise<{ saved?: string; error?: string }> };

export default async function SettingsPage({ searchParams }: Props) {
  const { saved, error } = await searchParams;
  const settings = await loadSettings();
  const code = currency();
  const message = error && Object.hasOwn(FIELD_ERRORS, error) ? FIELD_ERRORS[error as SettingsField] : undefined;

  return (
    <main className="shell narrow">
      <div className="page-head">
        <h1>Settings</h1>
        <p className="muted">Contract terms behind every cost on the dashboard.</p>
      </div>

      {message && (
        <p className="notice" data-tone="critical" role="alert">
          {message}
        </p>
      )}
      {saved && !message && (
        <p className="notice" role="status">
          Settings saved.
        </p>
      )}

      <form className="panel form" action={saveSettings}>
        <div className="field">
          <label htmlFor="partnerName">Agency name</label>
          <input
            id="partnerName"
            name="partnerName"
            defaultValue={settings?.partnerName ?? ""}
            maxLength={120}
            autoComplete="organization"
          />
        </div>
        <div className="field">
          <label htmlFor="rate">Contract rate per nuclia token ({code})</label>
          <input
            id="rate"
            name="rate"
            type="number"
            min="0"
            step="any"
            inputMode="decimal"
            defaultValue={settings?.contractRates.nuclia_tokens ?? ""}
            aria-describedby="rate-help"
          />
          <p id="rate-help" className="help">
            Applies to days the worker rolls up from now on. Days already rolled up keep the rate they were priced at.
          </p>
        </div>
        <div className="field">
          <label htmlFor="markupPercent">Markup on customer prices (%)</label>
          <input
            id="markupPercent"
            name="markupPercent"
            type="number"
            min="0"
            max="1000"
            step="any"
            defaultValue={settings?.markupPercent ?? 0}
          />
        </div>
        <p className="help">Costs are in {code}. Set LAUNCHPAD_CURRENCY to change the currency.</p>
        <button className="button" type="submit">
          Save settings
        </button>
      </form>
    </main>
  );
}
