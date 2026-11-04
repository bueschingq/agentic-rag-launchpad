// The Agentic RAG agents pilot on the deployment page: whether the two agents are on for this
// deployment, each one's state in Agentic RAG, how far its existing pages are through being
// processed again, and the switch. Loads its own data, so the page only mounts it.

import { Fragment } from "react";
import { Badge, type Tone } from "@/components/ui.tsx";
import { augmentationFor, augmentNewDeployments, REPROCESS_BATCH } from "@/lib/augmentation.ts";
import { turnOffAgents, turnOnAgents } from "./augmentation-actions.ts";

const STATUS: Record<string, [Tone, string]> = {
  running: ["good", "Running"],
  configured: ["good", "Set up"],
  done: ["neutral", "Finished"],
  missing: ["critical", "Not found in the Knowledge Box"],
  unknown: ["neutral", "State unknown"],
};

type Props = {
  tenantId: string;
  deploymentId: string;
  admin: boolean;
  // The page's ?agents= after a switch: on, off, or failed:<reason>.
  notice?: string;
};

export async function AugmentationPanel({ tenantId, deploymentId, admin, notice }: Props) {
  const [view, forNew] = await Promise.all([augmentationFor(deploymentId), augmentNewDeployments()]);
  const failed = notice?.startsWith("failed:") ? notice.slice(7) : undefined;
  const r = view.reprocess;

  return (
    <section className="panel" id="agents" aria-labelledby="agents-title">
      <div className="panel-head">
        <h2 id="agents-title">Agentic RAG agents (pilot)</h2>
        {admin && (
          <form action={(view.on ? turnOffAgents : turnOnAgents).bind(null, tenantId, deploymentId)}>
            <button className="button secondary" type="submit">
              {view.on ? "Turn off" : "Turn on for this deployment"}
            </button>
          </form>
        )}
      </div>
      {failed && (
        <p className="notice" data-tone="critical" role="alert">
          That didn't work: {failed}
        </p>
      )}
      {notice === "on" && view.on && (
        <p className="notice" role="status">
          The agents are on.{r && !r.finishedAt ? " This deployment's pages are being processed again." : ""}
        </p>
      )}
      {notice === "off" && !view.on && (
        <p className="notice" role="status">
          The agents are off. What they wrote stays on each page until the page is processed again.
        </p>
      )}
      <p className="muted">
        Two agents on this deployment's Knowledge Box: one writes the questions a visitor might ask about each page, so a question worded
        differently from the page still finds it; the other writes one sentence per page saying which questions it answers. Each adds
        processing time and model use for every page.
      </p>
      {view.on ? (
        <dl className="details">
          {view.tasks.map((t) => {
            const [tone, word] = STATUS[t.status] ?? ["neutral", t.status];
            return (
              <Fragment key={t.id}>
                <dt>{t.label}</dt>
                <dd>
                  <Badge tone={tone}>{word}</Badge> since {t.at.slice(0, 16).replace("T", " ")} UTC
                  {t.model && <span className="sub">Model {t.model}</span>}
                </dd>
              </Fragment>
            );
          })}
          {r && (
            <>
              <dt>Existing pages</dt>
              <dd>
                {r.finishedAt ? (
                  <>
                    <Badge tone={r.failed || r.lastError ? "warning" : "good"}>Done</Badge> {r.sent} sent to be processed again
                    {r.failed ? `, ${r.failed} refused` : ""}.
                  </>
                ) : (
                  <>
                    <Badge tone="neutral">Under way</Badge> {r.sent}
                    {r.total ? ` of about ${r.total}` : ""} sent to be processed again, {REPROCESS_BATCH} a minute.
                  </>
                )}
                {r.lastError && <span className="sub">Last refusal: {r.lastError}</span>}
              </dd>
            </>
          )}
        </dl>
      ) : (
        <p>
          Off for this deployment.{" "}
          {forNew ? "New deployments get them (Settings)." : "New deployments don't get them either; Settings turns them on for those."}{" "}
          Turning them on here also sends its existing pages to be processed again.
        </p>
      )}
      {view.problem && (
        <p className="help">The Knowledge Box's agent list couldn't be read just now ({view.problem}), so their state isn't shown.</p>
      )}
      {!admin && <p className="help">Only admins can turn the agents on or off.</p>}
    </section>
  );
}
