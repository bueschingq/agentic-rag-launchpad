// Editing a deployment after provisioning: allowed domains, how it answers (prompt and
// language), and where leads from the chat's contact form go.

import { smtpConfigured } from "@launchpad/notify";
import Link from "next/link";
import { notFound } from "next/navigation";
import { customerVisitorName, loadPromptVersions, promptDrift } from "@/lib/answers.ts";
import { loadDeployment } from "@/lib/provisioning.ts";
import { checkDomainLock, saveAnswersAction, saveDomainsAction, saveLeadsAction, tryPromptAction } from "./actions.ts";
import { AnswersForm, DomainsForm, LeadsForm } from "./edit-forms.tsx";

export const dynamic = "force-dynamic";
export const metadata = { title: "Edit deployment" };

type Params = { params: Promise<{ id: string; deploymentId: string }> };

export default async function EditDeploymentPage({ params }: Params) {
  const { id, deploymentId } = await params;
  const row = await loadDeployment(id, deploymentId);
  if (!row) notFound();
  const d = row.deployment;
  const [versions, drift, client] = await Promise.all([loadPromptVersions(d.id), promptDrift(d.id), customerVisitorName(id)]);
  const base = `/customers/${id}/deployments/${d.id}`;

  return (
    <main id="main" className="shell">
      <p className="crumbs">
        <Link href={base}>{d.name}</Link>
      </p>
      <div className="page-head">
        <h1>Edit {d.name}</h1>
        <p className="muted">Every change takes effect on the site within a minute and is recorded in the audit log.</p>
      </div>

      <section className="panel" aria-labelledby="domains-title">
        <h2 id="domains-title">Domains</h2>
        <DomainsForm
          initial={d.domains}
          initialStaging={d.stagingDomains}
          preflight={d.preflight}
          action={saveDomainsAction.bind(null, id, d.id)}
          check={checkDomainLock.bind(null, id, d.id)}
        />
      </section>

      <section className="panel" aria-labelledby="answers-title">
        <h2 id="answers-title">How it answers</h2>
        {!client && (
          <p className="notice" data-tone="warning" role="note">
            Name visitors see isn't set, so the templates say "the organization".{" "}
            <Link href={`/customers/${id}/edit#displayName`}>Set it</Link> first: the chat should never use your own name for the customer.
          </p>
        )}
        <AnswersForm
          initialPrompt={d.systemPrompt}
          initialLanguage={d.language}
          client={client}
          siteUrl={d.siteUrl}
          versions={versions}
          drift={drift.drifted ? drift.kbPrompt : undefined}
          action={saveAnswersAction.bind(null, id, d.id)}
          tryIt={tryPromptAction.bind(null, id, d.id)}
        />
      </section>

      <section className="panel" id="leads" aria-labelledby="leads-title">
        <h2 id="leads-title">Leads</h2>
        <p className="muted">
          Where the chat's contact form sends what visitors enter. Turn the form on, and choose its fields, on the widget page.
        </p>
        <LeadsForm initial={d.leadDelivery} action={saveLeadsAction.bind(null, id, d.id)} email={smtpConfigured()} />
      </section>
    </main>
  );
}
