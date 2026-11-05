// Partner-wide settings: what the console is connected to, the contract terms behind every
// cost, where alerts go, and who can sign in. Members see everything here read-only.

import Link from "next/link";
import { KbLimitForm } from "@/components/capacity.tsx";
import { Badge } from "@/components/ui.tsx";
import { augmentNewDeployments, augmentSettingStored } from "@/lib/augmentation.ts";
import { currentUser, isAdmin } from "@/lib/auth.ts";
import { capacityMessage, kbAllowance, waitingForKb } from "@/lib/capacity.ts";
import { connections } from "@/lib/connections.ts";
import { loadSettings } from "@/lib/dashboard.ts";
import { currency } from "@/lib/env.ts";
import { FIELD_ERRORS, type SettingsField } from "@/lib/settings-form.ts";
import { saveAlerts, saveAugmentation, saveSettings, sendTestAlert } from "./actions.ts";

export const dynamic = "force-dynamic";
export const metadata = { title: "Settings" };

type Props = { searchParams: Promise<{ saved?: string; error?: string; test?: string }> };

const ALERT_ERRORS: Record<string, string> = {
  alertWebhookUrl: "The alert webhook must be an https address.",
  alertEmails: "One of the alert email addresses isn't valid.",
};

export default async function SettingsPage({ searchParams }: Props) {
  const { saved, error, test } = await searchParams;
  const [settings, user, conn] = await Promise.all([loadSettings(), currentUser(), connections()]);
  const [allowance, waiting] = conn.agenticRag.ok ? await Promise.all([kbAllowance(), waitingForKb()]) : [undefined, 0];
  const [augmentOn, augmentStored] = await Promise.all([augmentNewDeployments(), augmentSettingStored()]);
  const admin = isAdmin(user);
  const code = currency();
  const termsError = error && Object.hasOwn(FIELD_ERRORS, error) ? FIELD_ERRORS[error as SettingsField] : undefined;
  const alertError = error ? ALERT_ERRORS[error] : undefined;
  const [testOutcome, testDetail] = test?.split(":") ?? [];

  return (
    <main id="main" className="shell">
      <div className="page-head with-actions">
        <div>
          <h1>Settings</h1>
          <p className="muted">Connections, contract terms, alerts, answer quality and sign-in for the whole console.</p>
        </div>
        <Link className="button secondary" href="/settings/users">
          Users
        </Link>
      </div>
      {!admin && (
        <p className="notice" role="note">
          Only admins can change these settings.
        </p>
      )}

      <section className="panel" aria-labelledby="connections">
        <h2 id="connections">Connections</h2>
        <dl className="details">
          <dt>Agentic RAG</dt>
          <dd>
            {conn.agenticRag.ok ? (
              <>
                <Badge tone="good">Connected</Badge> account <code>{conn.agenticRag.accountId}</code>, region{" "}
                <code>{conn.agenticRag.zone}</code>
              </>
            ) : (
              <>
                <Badge tone="critical">Not connected</Badge> {admin ? conn.agenticRag.problem : "Ask an admin to connect the account."}
              </>
            )}
          </dd>
          {allowance && (
            <>
              <dt>Knowledge Boxes</dt>
              <dd>
                <Badge tone={capacityMessage(allowance, waiting).tone}>
                  {allowance.limit === undefined ? `${allowance.used} used, limit unknown` : `${allowance.used} of ${allowance.limit} used`}
                </Badge>{" "}
                {capacityMessage(allowance, waiting).text} One per deployment.
                {admin && allowance.source !== "pat" && <KbLimitForm allowance={allowance} invalid={error === "kbLimit"} />}
              </dd>
            </>
          )}
          <dt>Site scanner</dt>
          <dd>
            {conn.sniffer.ok ? (
              <Badge tone="good">Reachable</Badge>
            ) : (
              <>
                <Badge tone="critical">Unavailable</Badge> {admin ? conn.sniffer.problem : "Ask an admin to check it."}
              </>
            )}
          </dd>
          <dt>Widget address</dt>
          <dd>
            <code>{conn.publicUrl.url}</code>{" "}
            {conn.publicUrl.ok ? (
              <Badge tone="good">Public</Badge>
            ) : (
              <>
                <Badge tone="warning">Not public</Badge> Customer sites can't load the widget from here
                {admin && " (PUBLIC_BASE_URL must be the console's public https address)"}.
              </>
            )}
          </dd>
          <dt>Sign-in</dt>
          <dd>
            {conn.signIn === "oidc" ? (
              "Work accounts (OIDC), one per person"
            ) : (
              <>
                <Badge tone="warning">Setup mode</Badge> one shared password
              </>
            )}
          </dd>
          <dt>Email</dt>
          <dd>{conn.email ? "Set up" : `Not set up: alerts and leads go to webhooks only${admin ? " (SMTP_URL)" : ""}`}</dd>
        </dl>
      </section>

      <h2>Contract terms</h2>
      {termsError && (
        <p className="notice" data-tone="critical" role="alert">
          {termsError}
        </p>
      )}
      {saved === "1" && !termsError && (
        <p className="notice" role="status">
          Settings saved.
        </p>
      )}
      <form className="panel form" action={saveSettings}>
        <fieldset disabled={!admin} className="plain-fieldset">
          <legend className="sr-only">Contract terms</legend>
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
          <p className="help">Costs are in {code}.</p>
          {admin && (
            <button className="button" type="submit">
              Save settings
            </button>
          )}
        </fieldset>
      </form>

      <h2 id="alerts">Alerts</h2>
      <p className="muted">
        Budgets at 80% and 100%, failed provisioning, syncs and validation, roll-ups that stop, and keys 60, 30 and 7 days before they
        expire. Each alert is sent once.
      </p>
      {alertError && (
        <p className="notice" data-tone="critical" role="alert">
          {alertError}
        </p>
      )}
      {saved === "alerts" && (
        <p className="notice" role="status">
          Alert settings saved.
        </p>
      )}
      {testOutcome === "sent" && (
        <p className="notice" role="status">
          Test alert sent ({testDetail === "nowhere" ? "nowhere: add a webhook or email" : testDetail?.replace("+", " and ")}).
        </p>
      )}
      {testOutcome === "failed" && (
        <p className="notice" data-tone="critical" role="alert">
          The test alert failed: {decodeURIComponent(testDetail ?? "")}
        </p>
      )}
      <form className="panel form" action={saveAlerts}>
        <fieldset disabled={!admin} className="plain-fieldset">
          <legend className="sr-only">Alert destinations</legend>
          <div className="field">
            <label htmlFor="alertWebhookUrl">Webhook (Slack, Teams or any automation)</label>
            <input
              id="alertWebhookUrl"
              name="alertWebhookUrl"
              type="url"
              placeholder="https://hooks.slack.com/services/…"
              defaultValue={settings?.alertWebhookUrl ?? ""}
              autoComplete="off"
            />
          </div>
          <div className="field">
            <label htmlFor="alertEmails">Email addresses</label>
            <input
              id="alertEmails"
              name="alertEmails"
              placeholder="ops@agency.example, accounts@agency.example"
              defaultValue={settings?.alertEmails.join(", ") ?? ""}
              aria-describedby="alertEmails-help"
            />
            <p id="alertEmails-help" className="help">
              Separated by commas. {conn.email ? "" : "Email needs SMTP set up on the console; until then alerts go to the webhook."}
            </p>
          </div>
          {admin && (
            <div className="actions">
              <button className="button" type="submit">
                Save alerts
              </button>
              <button className="button secondary" type="submit" formAction={sendTestAlert}>
                Send a test alert
              </button>
            </div>
          )}
        </fieldset>
      </form>

      <h2 id="agents">Answer quality</h2>
      {error === "augment" && (
        <p className="notice" data-tone="critical" role="alert">
          The setting wasn't saved: the console's database needs an update first.
        </p>
      )}
      {saved === "agents" && (
        <p className="notice" role="status">
          Saved. {augmentOn ? "Deployments created from now on get the agents." : "Deployments created from now on won't get the agents."}
        </p>
      )}
      <form className="panel form" action={saveAugmentation}>
        <fieldset disabled={!admin || !augmentStored} className="plain-fieldset">
          <legend className="sr-only">Agentic RAG agents</legend>
          <label className="inline">
            <input type="checkbox" name="augment" defaultChecked={augmentOn} aria-describedby="augment-what augment-cost augment-when" />{" "}
            Improve answers with Agentic RAG agents (pilot)
          </label>
          <p id="augment-what" className="help">
            Adds two Agentic RAG agents to a deployment's Knowledge Box. One writes the questions a visitor might ask about each page, so a
            question worded differently from the page still finds it. The other writes one sentence per page saying which questions it
            answers.
          </p>
          <p id="augment-cost" className="help">
            Each page then takes longer to process and uses the Knowledge Box's model once per agent: a new deployment's first answers come
            a little later, and model use grows with the number of pages.
          </p>
          <p id="augment-when" className="help">
            Applies to deployments created from now on. For an existing deployment, turn the agents on from its page; its pages are then
            processed again. Off by default while the pilot measures how much it helps.
          </p>
          {!augmentStored && (
            <p className="help">
              Not available yet: the console's database needs an update{admin ? " (a settings column, augment_new_deployments)" : ""}.
            </p>
          )}
          {admin && augmentStored && (
            <button className="button" type="submit">
              Save
            </button>
          )}
        </fieldset>
      </form>
    </main>
  );
}
