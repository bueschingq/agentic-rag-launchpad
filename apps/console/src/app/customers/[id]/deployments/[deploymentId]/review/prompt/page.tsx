// "Update the prompt", from Review's Client's name line: the prompt before and after, keeping the
// partner's own lines. Saving returns to Review, which checks the saved prompt again.

import Link from "next/link";
import { notFound } from "next/navigation";
import { promptUpdate } from "@/lib/client-name.ts";
import { loadDeploymentView } from "@/lib/deployment-view.ts";
import { updatePrompt } from "../actions.ts";
import { PromptUpdatePanel } from "../prompt-update.tsx";

export const dynamic = "force-dynamic";
export const metadata = { title: "Update the prompt" };

type Props = { params: Promise<{ id: string; deploymentId: string }>; searchParams: Promise<{ error?: string }> };

const ERRORS: Record<string, string> = {
  changed: "The prompt changed while you were looking: here it is as saved now.",
  name: "Set Name visitors see on the customer first: the prompt is written with it.",
  kb: "Agentic RAG didn't take the new prompt. Nothing changed; try again in a minute.",
};

export default async function UpdatePromptPage({ params, searchParams }: Props) {
  const { id, deploymentId } = await params;
  const { error } = await searchParams;
  const view = await loadDeploymentView(id, deploymentId, { servedPrompt: true });
  if (!view) notFound();
  const { deployment: d, tenant, base } = view;
  const name = view.review.find((l) => l.key === "name");
  const update = promptUpdate(d, {
    internal: tenant.name,
    visible: tenant.displayName,
    previous: view.nameChanges.flatMap((c) => [c.before, c.after]),
  });

  return (
    <main id="main" className="shell">
      <p className="crumbs">
        <Link href={`${base}/review`}>Review and sign off</Link>
      </p>
      <div className="page-head">
        <h1>Update the prompt</h1>
        <p className="muted">
          The current template, speaking as {tenant.displayName ? `"${tenant.displayName}"` : "the client"}, with every line you added to
          it.
        </p>
      </div>
      {error && ERRORS[error] && (
        <p className="notice" data-tone="critical" role="alert">
          {ERRORS[error]}
        </p>
      )}
      {name && name.state !== "ok" && (
        <p className="notice" data-tone="warning" role="note">
          {name.detail}
        </p>
      )}
      <section className="panel" id="prompt" aria-labelledby="prompt-title">
        <h2 id="prompt-title">Before and after</h2>
        {update ? (
          <PromptUpdatePanel before={d.systemPrompt} update={update} save={updatePrompt.bind(null, id, d.id, "review")} />
        ) : (
          <p>
            Name visitors see isn't set, so there's no name to write the prompt with.{" "}
            <Link href={`/customers/${id}/edit#displayName`}>Set it on the customer</Link>
          </p>
        )}
        <p className="help">
          To write it yourself instead, <Link href={`${base}/edit`}>edit how it answers</Link>.
        </p>
      </section>
    </main>
  );
}
