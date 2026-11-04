// One deployment, from first sync to live: where onboarding stands and what to do next,
// content, validation, going live (snippet, install guide, domains), the widget, and what the
// chatbot was set up with. Every status here comes from data, never from a step having run.

import { provisioningProblem, WHO_ACTS, zoneOrigin } from "@launchpad/par-client";
import { defaultWidgetSettings, languageSetting, resolveTheme, widgetMode } from "@launchpad/theme";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AccountBlockNotice } from "@/components/account-block-notice.tsx";
import { CopyButton } from "@/components/copy-button.tsx";
import { DataHandling } from "@/components/data-handling.tsx";
import { FocusNotice } from "@/components/focus.tsx";
import { PageProblem } from "@/components/page-problem.tsx";
import { Badge, type Tone } from "@/components/ui.tsx";
import { currentUser, isAdmin } from "@/lib/auth.ts";
import { capacityMessage, kbAllowance } from "@/lib/capacity.ts";
import { rereadNote } from "@/lib/content.ts";
import { DEFAULT_EXCLUDES } from "@/lib/content-form.ts";
import { countLine, formatPlanDay, planRules } from "@/lib/content-plan.ts";
import { cspSnippet } from "@/lib/csp.ts";
import { loadDeploymentView, modelTextLinks } from "@/lib/deployment-view.ts";
import { isStagingOrigin } from "@/lib/domain-rules.ts";
import { currency, publicBaseUrl } from "@/lib/env.ts";
import { formatAgo, formatMoney } from "@/lib/format.ts";
import { loadHistory } from "@/lib/history.ts";
import { FINISH_LABELS, languageLabel, MODE_LABELS } from "@/lib/labels.ts";
import { checklistSummary, formatMinutes, minutesBetween, throughGate } from "@/lib/onboarding.ts";
import { composeSystemPrompt } from "@/lib/prompt.ts";
import { contentChangeSummary, priceTableState } from "@/lib/review.ts";
import { isRefusalNote, syncHeadline } from "@/lib/site-refusal.ts";
import { contentFromCounts } from "@/lib/validation-rules.ts";
import { allowRefusedOrigin, retryFailed, retryProvisioning, revealWriterKey, saveContent, setPaused, syncNow } from "./actions.ts";
import { AugmentationPanel } from "./augmentation-panel.tsx";
import { Checklist } from "./checklist.tsx";
import { ContentSettings } from "./content-settings.tsx";
import { PriceTableSection } from "./price-table/price-table-section.tsx";
import { ValidationPanel } from "./validation-panel.tsx";
import { WriterKey } from "./writer-key.tsx";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string; deploymentId: string }>; searchParams: Promise<Record<string, string | undefined>> };

export async function generateMetadata({ params }: Params) {
  const { id, deploymentId } = await params;
  const view = await loadDeploymentView(id, deploymentId);
  return { title: view ? `${view.deployment.name} · ${view.tenant.name}` : "Deployment" };
}

const STEP_LABELS: Record<string, string> = {
  kb: "Knowledge Box",
  keys: "Reader, writer and manager keys",
  prompt: "System prompt",
  live: "Ready",
};
const STEP_TONES: Record<string, [Tone, string]> = {
  ok: ["good", "Done"],
  skipped: ["neutral", "Already done"],
  failed: ["critical", "Failed"],
};
const SYNC_TEXT: Record<string, [Tone, string]> = {
  queued: ["neutral", "Starting within a minute"],
  running: ["neutral", "Syncing"],
  ok: ["good", "Synced"],
  partial: ["warning", "Synced, some pages failed"],
  failed: ["critical", "Sync failed"],
};

const stepLabel = (step: string) => STEP_LABELS[step] ?? (step.startsWith("invite ") ? `Invite ${step.slice(7)}` : step);
const day = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : "");

export default async function DeploymentPage({ params, searchParams }: Params) {
  const { id, deploymentId } = await params;
  const query = await searchParams;
  const [view, user, history] = await Promise.all([loadDeploymentView(id, deploymentId), currentUser(), loadHistory(deploymentId)]);
  if (!view) notFound();
  const { deployment: d, tenant, stage, content, contentFacts, base } = view;

  const provisioned = d.status === "live" || d.status === "paused";
  const language = languageSetting(d.language);
  const theme = resolveTheme(d.theme).theme;
  const consoleUrl = publicBaseUrl();
  const consolePublic = consoleUrl.startsWith("https://") && !/localhost|127\.0\.0\.1/.test(consoleUrl);
  const snippet = `<script src="${consoleUrl}/arag-chat.js" data-deployment="${d.id}" async></script>`;
  const source = content.source;
  const [syncTone, syncWord] = syncHeadline(source?.lastJobStatus, {
    failed: content.counts.failed,
    gone: content.gone,
    answerable: content.counts.indexed,
    total: content.total,
    ...(source && { note: source.lastError }),
  }) ??
    SYNC_TEXT[source?.lastJobStatus ?? ""] ?? ["neutral", "Not started"];
  const connector = d.contentPath === "sitefinity_connector";
  const failedInvites = view.steps.filter((s) => s.step.startsWith("invite ") && s.status === "failed");
  const failedStep = view.steps.find((s) => s.status === "failed" && !s.step.startsWith("invite "));
  const problem = d.status === "failed" ? provisioningProblem(failedStep?.detail) : undefined;
  // A Knowledge Box limit can't be fixed by retrying: Retry waits until there's room again.
  const allowance = problem?.kind === "limit" ? await kbAllowance({ fresh: true }) : undefined;
  const blockedByLimit = problem?.kind === "limit" && allowance?.left === 0;
  const canRetry = d.status === "failed" || d.status === "draft" || failedInvites.length > 0;
  const signOff = view.signOff;
  const summary = checklistSummary(view.checklist);
  const soonest = view.keys.reduce<Date | null>((min, k) => (k.expiresAt && (!min || k.expiresAt < min) ? k.expiresAt : min), null);
  const keyDays = soonest ? Math.floor((soonest.getTime() - Date.now()) / 86_400_000) : undefined;

  return (
    <main id="main" className="shell">
      <p className="crumbs">
        <Link href={`/customers/${id}`}>{tenant.name}</Link>
      </p>
      <div className="page-head with-actions">
        <div>
          <h1>{d.name}</h1>
          <p className="muted">
            <Badge tone={stage.tone}>{stage.label}</Badge> {problem ? problem.text : stage.detail}{" "}
            <a href={d.siteUrl} rel="noreferrer" target="_blank">
              {new URL(d.siteUrl).host}
            </a>
          </p>
          {provisioned && (
            <p className="muted sign-off-line">
              {view.olderChecks && signOff.state !== "none" && (
                <>
                  <Badge tone="warning">Signed off under older checks</Badge> Signed off by {signOff.signOff.name},{" "}
                  {signOff.signOff.at.slice(0, 16).replace("T", " ")} UTC, before today's checks. It keeps serving.{" "}
                  <Link href={`${base}/review/up-to-date`}>Bring up to date</Link>
                  <br />
                </>
              )}
              {signOff.state === "signed" ? (
                !view.olderChecks && (
                  <>
                    Signed off by {signOff.signOff.name}, {signOff.signOff.at.slice(0, 16).replace("T", " ")} UTC.{" "}
                    <Link href={`${base}/review`}>Review</Link>
                  </>
                )
              ) : signOff.state === "changed" ? (
                <>
                  <Badge tone="warning">
                    Changed since sign-off
                    {signOff.nameChanged && signOff.contentChanged
                      ? ": the client's name and content"
                      : signOff.nameChanged
                        ? ": the client's name"
                        : signOff.contentChanged
                          ? ": content"
                          : ""}
                  </Badge>{" "}
                  {!view.olderChecks && <>Signed off by {signOff.signOff.name}; </>}
                  {signOff.nameChanged
                    ? `the name visitors see is now "${tenant.displayName}", and sign-off waits until the prompt says it.`
                    : signOff.contentChanged
                      ? `${contentChangeSummary(view.contentChanges)} since. Sign off the changes on Review.`
                      : "something visitors see has changed since."}
                  {signOff.nameChanged && signOff.contentChanged && ` Content changed too: ${contentChangeSummary(view.contentChanges)}.`}{" "}
                  <Link href={`${base}/review`}>Review the changes</Link>
                </>
              ) : (
                <>
                  <Badge tone={d.published ? "warning" : "neutral"}>Not signed off</Badge>{" "}
                  {d.published ? "It's serving visitors without a review." : "The chat stays hidden on sites until a person signs it off."}{" "}
                  <Link href={`${base}/review`}>Review and sign off</Link>
                </>
              )}
            </p>
          )}
        </div>
        <div className="actions">
          {provisioned && (
            <Link className="button secondary" href={`${base}/edit`}>
              Edit
            </Link>
          )}
          {d.status === "live" && (
            <form action={setPaused.bind(null, id, d.id, true)}>
              <button className="button secondary" type="submit">
                Pause
              </button>
            </form>
          )}
          {d.status === "paused" && (
            <form action={setPaused.bind(null, id, d.id, false)}>
              <button className="button" type="submit">
                Resume
              </button>
            </form>
          )}
        </div>
      </div>

      {query.paused && (
        <p className="notice" data-tone="warning" role="status">
          Paused. Within a minute the site shows the offline message, and no new chat sessions start.
        </p>
      )}
      {query.resumed && (
        <p className="notice" role="status">
          Resumed. The chat is back on the site within a minute.
        </p>
      )}
      {!consolePublic && (
        <p className="notice" data-tone="warning" role="note">
          The widget loads from <code>{consoleUrl}</code>, which customer sites can't reach. Set the console's public https address before
          sending the snippet{isAdmin(user) ? " (PUBLIC_BASE_URL)" : ""}.
        </p>
      )}
      {view.budget.stopped && (
        <p className="notice" data-tone="critical" role="alert">
          {tenant.name} is over this month's budget ({formatMoney(view.budget.spentCents, currency())} of{" "}
          {formatMoney(view.budget.budgetCents ?? 0, currency())}) and set to stop at 100%, so the chat is offline until next month or a
          budget change. <Link href={`/customers/${id}/edit`}>Change the budget</Link>
        </p>
      )}
      {keyDays !== undefined && keyDays <= 60 && (
        <p className="notice" data-tone={keyDays <= 7 ? "critical" : "warning"} role="note">
          This deployment's keys expire on {day(soonest)}, in {Math.max(keyDays, 0)} days, and the chat stops answering then. The console
          can't replace keys yet.
        </p>
      )}

      {query.signedoff && (
        <FocusNotice tone="good">
          Signed off. The chat shows on the site's pages within a minute, wherever the snippet is in place.
        </FocusNotice>
      )}
      {stage.key !== "live" ? (
        <Checklist
          steps={view.checklist}
          started={view.started}
          signedOffAt={view.firstSignedOffAt}
          heldAt={view.heldAt}
          liveAt={d.firstSeenAt}
        />
      ) : (
        // Live with steps still open: one line, until every step is done or skipped on purpose.
        summary && (
          <details className="panel checklist-summary">
            <summary>
              <Badge tone="warning">Open</Badge> {summary}
            </summary>
            <Checklist
              steps={view.checklist}
              started={view.started}
              signedOffAt={view.firstSignedOffAt}
              heldAt={view.heldAt}
              liveAt={d.firstSeenAt}
            />
          </details>
        )
      )}
      {stage.key === "live" &&
        view.firstSignedOffAt &&
        throughGate({ start: view.started, signedOff: view.firstSignedOffAt, firstAnswer: d.firstSeenAt }) && (
          <p className="muted onboarded">
            Onboarded: signed off {formatMinutes(minutesBetween(view.started, view.firstSignedOffAt))} after starting, held after the first
            sync {view.heldAt ? `after ${formatMinutes(minutesBetween(view.started, view.heldAt))}` : "not yet"}
            {d.firstSeenAt && d.firstSeenAt >= view.started && (
              <>, first answer on the site after {formatMinutes(minutesBetween(view.started, d.firstSeenAt))}</>
            )}
            .
          </p>
        )}

      <section className="panel" id="content" aria-labelledby="content-title">
        <div className="panel-head">
          <h2 id="content-title">Content</h2>
          {provisioned && !connector && (
            <div className="actions">
              <Link className="button secondary" href={`${base}/content`}>
                All pages
              </Link>
              <form action={syncNow.bind(null, id, d.id)}>
                <button className="button secondary" type="submit" disabled={source?.lastJobStatus === "running"}>
                  Sync now
                </button>
              </form>
            </div>
          )}
        </div>
        {/* The result takes focus: the button it replaces may be disabled while the sync runs. */}
        {query.synced && (
          <FocusNotice>
            Sync requested: it starts within a minute, and reads again every page read under an older extractor or older rules.
          </FocusNotice>
        )}
        {query.retried && <FocusNotice>{query.retried} failed pages queued again.</FocusNotice>}
        {!provisioned ? (
          <p className="muted">Content syncs once the Knowledge Box is provisioned.</p>
        ) : d.contentPath === "manual" && !source ? (
          <>
            <p>
              Content was added to this Knowledge Box outside Launchpad
              {contentFacts.kbResources !== undefined && (
                <>
                  : it holds <strong>{contentFacts.kbResources}</strong> resources
                </>
              )}
              .
            </p>
            <form action={syncNow.bind(null, id, d.id)}>
              <button className="button secondary" type="submit">
                Also sync the site's pages
              </button>
            </form>
          </>
        ) : connector ? (
          <>
            <p>
              Sitefinity's connector pushes pages from the CMS.{" "}
              {contentFacts.kbResources !== undefined && (
                <>
                  The Knowledge Box holds <strong>{contentFacts.kbResources}</strong> resources.
                </>
              )}
            </p>
            <dl className="details">
              <dt>Endpoint</dt>
              <dd>
                <code>{zoneOrigin(d.zone)}</code> <CopyButton text={zoneOrigin(d.zone)} label="Copy" />
                <span className="help"> Without /api: Sitefinity adds it.</span>
              </dd>
              <dt>Knowledge Box ID</dt>
              <dd>
                <code>{d.kbId}</code> <CopyButton text={d.kbId ?? ""} label="Copy" />
              </dd>
              <dt>Writer key</dt>
              <dd>
                <WriterKey reveal={revealWriterKey.bind(null, id, d.id)} />
              </dd>
            </dl>
            <p className="help">
              In Sitefinity: Administration › Settings › Agentic RAG connection. Paste the three values, save, then publish or republish the
              pages to sync. The count above rises as they arrive.
            </p>
          </>
        ) : (
          <>
            <p>
              <Badge tone={syncTone}>{syncWord}</Badge>{" "}
              {content.total > 0 ? (
                <>
                  <strong>{content.counts.indexed}</strong> of {content.total} pages answerable
                  {content.counts.processing > 0 && <>, {content.counts.processing} processing</>}
                  {content.counts.queued > 0 && <>, {content.counts.queued} waiting</>}
                  {content.counts.skipped > 0 && <>, {content.counts.skipped} left out</>}
                  {content.counts.failed > 0 && <>, {content.counts.failed} failed</>}.{rereadNote(content) && <> {rereadNote(content)}</>}
                  {content.rateLimitedNote && <> {content.rateLimitedNote}</>}
                </>
              ) : (
                "No pages yet."
              )}{" "}
              {source && (
                <span className="muted">
                  {countLine({
                    ...(source.plan && { total: source.plan.total }),
                    found: source.pagesFound,
                    budget: source.pageBudget ?? 200,
                    include: source.includePatterns,
                    exclude: source.excludePatterns,
                    languages: source.languages,
                    rules: planRules(source.plan),
                    discovery: source.discovery,
                    pinned: source.pinned.length,
                  })}
                </span>
              )}
            </p>
            {(content.oldestTaken || content.queueAhead !== undefined) && (
              <p className="help">
                {content.oldestTaken && (
                  <>
                    Oldest page taken: {formatPlanDay(content.oldestTaken)}
                    {source?.plan?.oldestTaken && source.plan.oldestTaken !== content.oldestTaken && (
                      <> (the plan expected {formatPlanDay(source.plan.oldestTaken)})</>
                    )}
                    .{" "}
                  </>
                )}
                {content.queueAhead !== undefined &&
                  (content.queueAhead === 0
                    ? "Next in line to load."
                    : `${content.queueAhead.toLocaleString("en")} ${content.queueAhead === 1 ? "page from another deployment loads" : "pages from other deployments load"} first (about ${Math.ceil(content.queueAhead / 60)} min).`)}
                {content.estimate && ` This sync: ${content.estimate.text}.`}
              </p>
            )}
            {source?.lastJobStatus === "failed" && source.lastError && (
              <p className="notice" data-tone="critical" role="alert">
                {source.lastError}
              </p>
            )}
            {isRefusalNote(source?.lastError) && (
              <p className="notice" data-tone="warning" role="status">
                {source?.lastError}
              </p>
            )}
            {source?.lastSyncedAt && (
              <p className="help">
                Last synced {day(source.lastSyncedAt)}.{" "}
                {source.resyncHours ? `Syncs again ${source.resyncHours === 24 ? "daily" : "weekly"}.` : "Syncs only on request."}
              </p>
            )}
            {content.problems.length > 0 && (
              <div className="problems">
                <details>
                  <summary className="h4">
                    {content.gone === content.counts.failed ? "Pages gone from the site" : "Failed pages"} ({content.counts.failed})
                  </summary>
                  <ul className="plain">
                    {content.problems.map((p) => (
                      <li key={p.url}>
                        <a href={p.url} target="_blank" rel="noreferrer">
                          {p.title ?? p.url}
                        </a>
                        <PageProblem detail={p.detail} />
                      </li>
                    ))}
                  </ul>
                </details>
                <form action={retryFailed.bind(null, id, d.id)}>
                  <button type="submit" className="button secondary">
                    Retry failed pages
                  </button>
                </form>
              </div>
            )}
          </>
        )}
        {provisioned && (
          <details className="settings-details" open={!source && d.contentPath !== "manual"}>
            <summary>Content settings</summary>
            <ContentSettings
              action={saveContent.bind(null, id, d.id)}
              siteUrl={d.siteUrl}
              platform={view.scan?.platform.platform}
              initial={{
                path: connector ? "sitefinity_connector" : "sitemap",
                sitefinityVersion: d.sitefinityVersion === "15.4+" || d.sitefinityVersion === "earlier" ? d.sitefinityVersion : "unknown",
                startUrl: source?.sitemapUrl ?? d.siteUrl,
                pageBudget: source?.pageBudget ?? 200,
                include: source?.includePatterns ?? [],
                exclude: source?.excludePatterns ?? DEFAULT_EXCLUDES,
                resync: source?.resyncHours === 168 ? "168" : source?.resyncHours === null ? "off" : "24",
              }}
            />
          </details>
        )}
      </section>

      <section className="panel" id="validate" aria-labelledby="validate-title">
        <h2 id="validate-title">Validate</h2>
        {provisioned && (
          <PriceTableSection
            tenantId={id}
            deploymentId={d.id}
            table={d.priceTable ?? null}
            confirmation={d.priceTableConfirmation ?? null}
            setupMode={user.setupMode}
          />
        )}
        <AccountBlockNotice />
        {provisioned && ["unconfirmed", "changed"].includes(priceTableState(d.priceTable, d.priceTableConfirmation)) && (
          <p className="notice" data-tone="warning" role="note">
            Check the price table above before you run validation: price answers are judged against it, and confirming it later asks them
            again.
          </p>
        )}
        <ValidationPanel
          validation={d.validation}
          preflight={d.preflight}
          canRun={provisioned && (contentFacts.indexed > 0 || (contentFacts.kbResources ?? 0) > 0)}
          content={source ? contentFromCounts(content.counts, source.lastSyncedAt) : null}
          widget={{
            deploymentId: d.id,
            zone: "",
            kbId: "",
            searchConfig: "",
            theme,
            settings: { ...defaultWidgetSettings, ...d.widgetSettings, language },
            online: true,
          }}
          links={await modelTextLinks(d)}
        />
      </section>

      <section className="panel" id="go-live" aria-labelledby="go-live-title">
        <div className="panel-head">
          <h2 id="go-live-title">Go live</h2>
          {provisioned && (
            <div className="actions">
              <Link className="button" href={`${base}/install`}>
                Install guide
              </Link>
            </div>
          )}
        </div>
        {query.allowed && (
          <FocusNotice>
            Domain allowed. Agentic RAG takes a few minutes to apply it (often 1 to 3), and the chat can't answer there until then. The
            domain check runs again by itself until it passes.
          </FocusNotice>
        )}
        {!provisioned ? (
          <p className="muted">The snippet and the install guide are available once provisioning succeeds.</p>
        ) : (
          <>
            <p className="muted">
              One line before the closing &lt;/body&gt;, in the site's layout template or a tag manager.{" "}
              {!d.published && "It can go on now: the chat appears once it's signed off."}
            </p>
            <pre className="snippet">
              <code>{snippet}</code>
            </pre>
            <div className="actions">
              <CopyButton text={snippet} label="Copy snippet" />
            </div>
            <details>
              <summary>Content Security Policy entries (for sites that send a CSP)</summary>
              <pre className="snippet">
                <code>{cspSnippet({ consoleOrigin: consoleUrl, zone: d.zone, avatarUrl: d.widgetSettings.avatar })}</code>
              </pre>
              <p className="help">Add these sources to the site's existing directives. The snippet needs no 'unsafe-inline'.</p>
            </details>
          </>
        )}
        {view.refused.length > 0 && (
          <div className="refused">
            <h3 className="h4">Asked for the chat, but not allowed</h3>
            <ul className="plain">
              {view.refused.map((r) => (
                <li key={r.origin}>
                  <code>{r.origin}</code>{" "}
                  <span className="muted">
                    {r.count} time{r.count === 1 ? "" : "s"}, last {r.lastSeenAt.toISOString().slice(0, 16).replace("T", " ")} UTC
                  </span>{" "}
                  <form action={allowRefusedOrigin.bind(null, id, d.id, r.origin)} className="inline">
                    <button type="submit" className="button secondary">
                      Allow it
                    </button>
                  </form>
                </li>
              ))}
            </ul>
          </div>
        )}
        {d.firstSeenAt && (
          <p>
            <Badge tone="good">Live</Badge> First chat on <code>{d.firstSeenOrigin}</code> on {day(d.firstSeenAt)}.
          </p>
        )}
      </section>

      <section className="panel" aria-labelledby="widget-title">
        <div className="panel-head">
          <h2 id="widget-title">Widget</h2>
          <Link className="button secondary" href={`${base}/widget`}>
            Configure widget
          </Link>
        </div>
        <dl className="details">
          <dt>Layout</dt>
          <dd>
            {MODE_LABELS[widgetMode(d.widgetSettings.mode)][0]}, {FINISH_LABELS[theme.finish.style].toLowerCase()} finish
          </dd>
          <dt>Site scan</dt>
          <dd>
            {view.scan ? `${day(view.scan.at)}, from ${new URL(view.scan.url).host}` : <span className="muted">Not scanned yet</span>}
          </dd>
          <dt>Handoff</dt>
          <dd>
            {d.widgetSettings.handoff?.contacts.length ? (
              `${d.widgetSettings.handoff.contacts.length} contact${d.widgetSettings.handoff.contacts.length === 1 ? "" : "s"}`
            ) : (
              <span className="muted">Not set up</span>
            )}
          </dd>
        </dl>
      </section>

      <section className="panel" aria-labelledby="setup-title">
        <div className="panel-head">
          <h2 id="setup-title">Setup</h2>
          {provisioned && (
            <Link className="button secondary" href={`${base}/edit`}>
              Edit domains, prompt or language
            </Link>
          )}
        </div>
        <dl className="details">
          <dt>Knowledge Box</dt>
          <dd>
            <code>{d.kbSlug}</code>
            {d.kbId && <span className="sub">{d.kbId}</span>}
          </dd>
          <dt>Allowed domains</dt>
          <dd>
            <ul className="plain">
              {d.domains.map((domain) => (
                <li key={domain}>
                  {domain}
                  {isStagingOrigin(domain, d.stagingDomains) && <span className="muted"> · staging (test traffic)</span>}
                </li>
              ))}
            </ul>
          </dd>
          <dt>Language</dt>
          <dd>{languageLabel(language)}</dd>
          <dt>System prompt</dt>
          <dd>
            {d.systemPrompt ? (
              <>
                <pre className="prompt">{composeSystemPrompt(d.systemPrompt, language)}</pre>
                <p className="help">As saved to the Knowledge Box: the prompt, then the language rule the console adds.</p>
              </>
            ) : (
              <span className="muted">The Knowledge Box's own settings: this deployment was imported.</span>
            )}
          </dd>
          <dt>Keys</dt>
          <dd>
            {view.keys.length ? (
              <>
                <ul className="plain">
                  {view.keys.map((k) => (
                    <li key={k.role}>
                      {k.role}: expires {day(k.expiresAt)}
                    </li>
                  ))}
                </ul>
                <p className="help">The chat stops answering when they expire. We'll alert you 60 days before.</p>
              </>
            ) : (
              <span className="muted">None yet</span>
            )}
          </dd>
        </dl>
        <details>
          <summary>Data handling (for privacy and DPO questions)</summary>
          <DataHandling zone={d.zone} consoleHost={new URL(consoleUrl).host} />
        </details>
      </section>

      {provisioned && <AugmentationPanel tenantId={id} deploymentId={d.id} admin={isAdmin(user)} notice={query.agents} />}

      <section className="panel" id="provisioning" aria-labelledby="provisioning-title">
        <div className="panel-head">
          <h2 id="provisioning-title">Provisioning</h2>
          {canRetry && (
            <form action={retryProvisioning.bind(null, id, d.id)}>
              <button className="button secondary" type="submit" disabled={blockedByLimit}>
                {d.status === "draft" ? "Start provisioning" : "Retry provisioning"}
              </button>
            </form>
          )}
        </div>
        {problem && (
          <div className="notice" data-tone="critical" role="alert">
            <p>
              <strong>{WHO_ACTS[problem.who]}.</strong> {failedStep && <>Stopped at {stepLabel(failedStep.step)}. </>}
              {problem.text}
            </p>
            {allowance && <p>{capacityMessage(allowance).text}</p>}
            {blockedByLimit && <p>Retry comes back once the account has room for another Knowledge Box.</p>}
            {failedStep?.detail && (
              <details>
                <summary>See why</summary>
                <p className="step-detail">{failedStep.detail}</p>
              </details>
            )}
          </div>
        )}
        {view.steps.length === 0 ? (
          <p className="muted">{d.status === "draft" ? "Not started." : "No steps recorded: this deployment was imported."}</p>
        ) : (
          <ol className="steps">
            {view.steps.map((s) => {
              const [tone, word] = STEP_TONES[s.status] ?? ["neutral", s.status];
              return (
                <li key={s.step}>
                  <span className="step-name">{stepLabel(s.step)}</span>
                  <Badge tone={tone}>{word}</Badge>
                  {s.detail && s.status !== "skipped" && <span className="step-detail">{s.detail}</span>}
                </li>
              );
            })}
          </ol>
        )}
        <p className="help">Created {day(d.createdAt)}.</p>
      </section>

      <section className="panel" id="history" aria-labelledby="history-title">
        <h2 id="history-title">History</h2>
        {history.length === 0 ? (
          <p className="muted">Nothing recorded yet.</p>
        ) : (
          <details>
            <summary>
              {history.length === 40 ? "The latest 40 changes" : `${history.length} changes`}, the latest{" "}
              {formatAgo(history[0]!.at, new Date())}
            </summary>
            <ol className="plain history">
              {history.map((h) => (
                <li key={`${h.at.toISOString()}-${h.what}`}>
                  <time dateTime={h.at.toISOString()}>{h.at.toISOString().slice(0, 16).replace("T", " ")} UTC</time> {h.who} {h.what}.
                </li>
              ))}
            </ol>
          </details>
        )}
      </section>
    </main>
  );
}
