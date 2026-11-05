// Bring up to date: a deployment signed off under older checks reaches today's bar. It keeps
// serving throughout. Five steps, each with what changes before and after, and each acting only
// when its button is clicked: read the pages again (its own button) and see what today's rules
// would leave out (Apply, or page by page); the site's key pages joining the sync (Add), with
// every page that joins and leaves; the current prompt
// template with today's no-answer and quote lines, keeping the partner's lines (Update the
// prompt); validation again, with the questions every site gets; then Review and a new sign-off,
// which clears the flag. Opening the page adds nothing to History.

import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { FocusNotice } from "@/components/focus.tsx";
import { Badge } from "@/components/ui.tsx";
import { currentUser } from "@/lib/auth.ts";
import { promptUpdate } from "@/lib/client-name.ts";
import { type KeyPage, keyPageChanges, keyPages, keyPagesState, rereadNote, rereadState, upToDatePreview } from "@/lib/content.ts";
import { FLAG_LABELS, intentName, type PageFlag, takesKeyPages } from "@/lib/content-plan.ts";
import { loadDeploymentView } from "@/lib/deployment-view.ts";
import { NO_ANSWER_LINE, QUOTE_LINE, templateLinesCurrent } from "@/lib/prompt-templates.ts";
import { asRun } from "@/lib/validation-rules.ts";
import { updatePrompt } from "../actions.ts";
import { PromptUpdatePanel } from "../prompt-update.tsx";
import { addKeys, applyContent, keepPrompt, readAgain, validateAgain } from "./actions.ts";
import { KeyPagesForm } from "./key-pages-form.tsx";
import { upToDateSteps } from "./record.ts";

export const dynamic = "force-dynamic";
export const metadata = { title: "Bring up to date" };

type Props = {
  params: Promise<{ id: string; deploymentId: string }>;
  searchParams: Promise<{
    error?: string;
    why?: string;
    applied?: string;
    prompt?: string;
    validated?: string;
    keys?: string;
    reading?: string;
  }>;
};

// A step's result: it takes focus when the step's button brings the page back (7f), so the next
// Tab carries on from the step just done.
function Result({ focus, children }: { focus: boolean; children: ReactNode }) {
  return focus ? <FocusNotice className="step-result">{children}</FocusNotice> : <p>{children}</p>;
}

const when = (at: Date) => `${at.toISOString().slice(0, 16).replace("T", " ")} UTC`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const pathOf = (url: string) => {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
};

// "1 conversion page, 10 older than 2 years": the reasons, most common first.
function reasonCounts(pages: readonly { reason: string }[]): string {
  const counts = new Map<string, number>();
  for (const p of pages) counts.set(p.reason, (counts.get(p.reason) ?? 0) + 1);
  return [...counts]
    .sort((a, b) => b[1] - a[1])
    .map(([reason, n]) => `${n} ${reason.charAt(0).toLowerCase()}${reason.slice(1)}`)
    .join(", ");
}

// What a saved prompt lacks of today's template (templateLinesCurrent): "the no-answer line and
// the quote line".
function missingLines(prompt: string): string {
  const missing = [
    !prompt.includes(NO_ANSWER_LINE) &&
      "the no-answer line (when the website doesn't answer, reply with the console's no-answer sentence word for word, so validation and the widget's handoff recognise it)",
    !prompt.includes(QUOTE_LINE) && "the quote line (when prices are by quote, say so and point to the page to ask for one)",
  ].filter((line): line is string => Boolean(line));
  return missing.length
    ? missing.join(", and ")
    : "today's no-answer line in place of the earlier template's “reply in one sentence that you don't know”";
}

export default async function UpToDatePage({ params, searchParams }: Props) {
  const { id, deploymentId } = await params;
  const query = await searchParams;
  const view = await loadDeploymentView(id, deploymentId, { servedPrompt: true });
  if (!view) notFound();
  const { deployment: d, tenant, base, signOff } = view;

  if (!view.olderChecks || signOff.state === "none") {
    // The checks are today's, but pages read under an older extractor or rules can still be read
    // again now rather than by the nightly batch.
    const reread = await rereadState(d.id);
    return (
      <main id="main" className="shell">
        <p className="crumbs">
          <Link href={base}>{d.name}</Link>
        </p>
        <h1>Bring up to date</h1>
        <p className="notice" data-tone="good" role="status">
          {signOff.state === "none"
            ? "Not signed off yet: Review and sign off checks it against today's rules."
            : reread.outOfDate
              ? "Signed off under today's checks."
              : "Signed off under today's checks: there's nothing to bring up to date."}{" "}
          <Link href={`${base}/review`}>Review</Link>
        </p>
        {query.reading ? (
          <FocusNotice>
            {plural(reread.reading || reread.outOfDate, "page")} {reread.reading === 1 ? "is" : "are"} being read again with today's
            extractor and rules. They stay in the chat meanwhile; Content shows each as it's read.
          </FocusNotice>
        ) : reread.outOfDate > 0 ? (
          <section className="panel" id="content" aria-labelledby="reread-title">
            <h2 id="reread-title">Pages read under older rules</h2>
            <p>
              {plural(reread.outOfDate, "page")} {reread.outOfDate === 1 ? "was" : "were"} read under an older extractor or older rules
              {reread.reading ? `, ${reread.reading} of them being read again now` : ""}. Reading them again now applies today's (the
              overnight job would, between 00:00 and 06:00 server time); they stay in the chat meanwhile.
            </p>
            {!reread.reading && (
              <form action={readAgain.bind(null, id, d.id)}>
                <button className="button" type="submit">
                  Read the pages again
                </button>
              </form>
            )}
          </section>
        ) : null}
      </main>
    );
  }

  const [steps, user] = await Promise.all([upToDateSteps(d.id, signOff.signOff.at), currentUser()]);
  // Until step 1 is applied: what today's rules would change, from what's stored. Looking reads
  // nothing again: Read the pages again is its own button (readAgain).
  const [preview, keyChanges, keysNow] = await Promise.all([
    steps.content ? undefined : upToDatePreview(d.id).catch(() => undefined),
    // What Add would change: read only (the sitemap and the pages), until Add is clicked.
    steps.keyPages || d.contentPath !== "sitemap" || takesKeyPages(d) ? undefined : keyPageChanges(d.id).catch(() => undefined),
    keyPages(d.id).catch((): KeyPage[] => []),
  ]);
  // A deployment that already takes key pages (not published, or signed off under today's checks).
  const takesKeys = takesKeyPages(d);
  const update = promptUpdate(d, {
    internal: tenant.name,
    visible: tenant.displayName,
    previous: view.nameChanges.flatMap((c) => [c.before, c.after]),
  });
  const linesCurrent = templateLinesCurrent(d.systemPrompt);
  const reextracting = view.reextracting;
  // After Add, the sync that brings the key pages in: validation waits for it, so the questions
  // every site gets answer from them. Done only once that sync has finished and its outcome is
  // recorded (keyPagesState: the worker's settleKeyPages), never while a re-read clicked just
  // before is the sync that's running.
  const syncRunning = ["queued", "running"].includes(view.content.source?.lastJobStatus ?? "");
  const keysState = steps.keyPages ? keyPagesState(steps.keyPages.detail, keysNow, syncRunning) : undefined;
  const keysSyncing = Boolean(keysState && !keysState.settled);
  const canValidate = Boolean(steps.content) && reextracting === 0 && !keysSyncing;
  const validated = steps.validation && d.validation ? { run: steps.validation, result: d.validation } : undefined;
  const intentsAsked = validated ? (asRun(validated.result)?.questions ?? []).filter((q) => q.intent) : [];
  const leftOut = Array.isArray(steps.content?.detail.leftOut) ? steps.content.detail.leftOut.length : 0;
  const proposed = Number(steps.content?.detail.proposed ?? 0);
  // Step 1's outcome in words: "Kept" only for proposed pages the person unticked (7f).
  const appliedWords = !proposed
    ? "nothing to leave out"
    : leftOut >= proposed
      ? `${plural(leftOut, "page")} left out, as proposed`
      : `${plural(leftOut, "page")} left out; ${plural(proposed - leftOut, "proposed page")} kept`;
  const flagged = preview
    ? (Object.entries(preview.flags) as [PageFlag, number][])
        .filter(([, n]) => n > 0)
        .map(([flag, n]) => `${n} ${FLAG_LABELS[flag]?.toLowerCase() ?? flag}`)
    : [];
  const keysInSync = keysNow.filter((k) => ["indexed", "processing", "queued"].includes(k.status));
  const keysDone = steps.keyPages && keysState && (
    <>
      <Badge tone={keysSyncing ? "neutral" : "good"}>{keysSyncing ? "Syncing" : "Done"}</Badge> Added by {steps.keyPages.who},{" "}
      {when(steps.keyPages.at)}.{" "}
      {keysSyncing ? (
        <>
          {keysState.waiting.length
            ? `${plural(keysState.waiting.length, "key page")} still to join: ${keysState.waiting.map(pathOf).join(", ")}.`
            : "The key pages are in; the sync is finishing."}{" "}
          The sync that brings them in is running{view.content.estimate ? ` (${view.content.estimate.text})` : ""}; validation waits for it.
          The chat keeps answering meanwhile.
        </>
      ) : (
        <>
          {keysState.added.length
            ? `${plural(keysState.added.length, "key page")} joined: ${keysState.added.map(pathOf).join(", ")}`
            : "No key page joined"}
          {keysState.joined.length ? `, with ${plural(keysState.joined.length, "other page")}` : ""}
          {keysState.dropped.length ? `; ${plural(keysState.dropped.length, "page")} at the end of the page budget left` : ""}.{" "}
          {keysState.unusable.length > 0 &&
            `${plural(keysState.unusable.length, "key page")} couldn't be used (${keysState.unusable.map(pathOf).join(", ")}): Content says why, and the next page for the same question took its place.`}
          {` ${plural(keysInSync.length, "key page")} in the sync now.`}
        </>
      )}
    </>
  );

  return (
    <main id="main" className="shell">
      <p className="crumbs">
        <Link href={`${base}/review`}>Review and sign off</Link>
      </p>
      <div className="page-head">
        <h1>Bring up to date</h1>
        <p className="muted">
          Signed off by {signOff.signOff.name} on {signOff.signOff.at.slice(0, 10)}, under older checks. The chat keeps serving while you go
          through these steps; nothing changes until you click a step's button, and a new sign-off at the end clears the flag.
        </p>
      </div>

      <section className="panel" id="content" aria-labelledby="content-title">
        <h2 id="content-title">1. Pages, by today's rules</h2>
        {query.error === "content" && (
          <p className="notice" data-tone="critical" role="alert">
            Nothing was applied: the content rules couldn't be run just now. Try again in a minute.
          </p>
        )}
        {steps.content ? (
          <Result focus={Boolean(query.applied)}>
            <Badge tone={reextracting ? "neutral" : "good"}>{reextracting ? "Reading pages again" : "Done"}</Badge> Applied by{" "}
            {steps.content.who}, {when(steps.content.at)}: {appliedWords}.{" "}
            {reextracting
              ? `${plural(reextracting, "page")} still to read again with today's extractor; this page shows the count as it falls.`
              : "Every page has been read again with today's extractor."}
          </Result>
        ) : null}
        {rereadNote(view.content) && (
          <p role="status">
            {rereadNote(view.content)} {plural(view.content.counts.indexed, "page")} answerable.
          </p>
        )}
        {steps.content ? null : !preview ? (
          <p className="notice" data-tone="warning" role="note">
            Today's rules can't be compared with this deployment's pages just now. Try again in a minute.
          </p>
        ) : (
          <form action={applyContent.bind(null, id, d.id)}>
            <p>
              {preview.leaveOut.length
                ? `${plural(preview.leaveOut.length, "page")} would now be left out: ${reasonCounts(preview.leaveOut)}.`
                : "Today's rules leave out no page that's in now."}{" "}
              {preview.reextract && reextracting > 0
                ? `${plural(reextracting, "page")} still to read again with today's extractor and rules; pages whose own date only shows once they're read join this list as they are, so reload it in a few minutes.`
                : preview.reextract
                  ? `${plural(preview.reextract, "page")} ${preview.reextract === 1 ? "was" : "were"} read by an older extractor or older rules: what today's rules make of them shows once they're read again.`
                  : ""}
            </p>
            {flagged.length > 0 && <p className="help">Flagged for a look (they stay in): {flagged.join(", ")}.</p>}
            {preview.leaveOut.length > 0 && (
              <fieldset className="plain-fieldset">
                <legend className="h4">Pages to leave out (untick any to keep)</legend>
                <ul className="plain">
                  {preview.leaveOut.map((p) => (
                    <li key={p.url}>
                      <label className="inline">
                        <input type="checkbox" name="url" value={p.url} defaultChecked /> {p.title || p.url}
                      </label>{" "}
                      <span className="step-detail">
                        {p.detail || p.reason} ·{" "}
                        <a href={p.url} target="_blank" rel="noreferrer">
                          Open<span className="sr-only"> {p.title || p.url}</span>
                        </a>
                      </span>
                    </li>
                  ))}
                </ul>
              </fieldset>
            )}
            <div className="actions">
              {preview.reextract > 0 && reextracting === 0 && (
                <button className="button secondary" type="submit" formAction={readAgain.bind(null, id, d.id)}>
                  Read the pages again first<span className="sr-only"> ({plural(preview.reextract, "page")})</span>
                </button>
              )}
              <button className="button" type="submit" name="all" value="1">
                {preview.leaveOut.length ? `Apply: leave out ${preview.leaveOut.length}` : "Apply: nothing to leave out"}
              </button>
              {reextracting > 0 && (
                <span className="help">
                  The list may still grow: {plural(reextracting, "page")} {reextracting === 1 ? "is" : "are"} still being read again. Apply
                  what's here now, or reload in a few minutes.
                </span>
              )}
              {preview.leaveOut.length > 0 && (
                <button className="button secondary" type="submit">
                  Apply: leave out the ticked pages only
                </button>
              )}
            </div>
          </form>
        )}
      </section>

      <section className="panel" id="keys" aria-labelledby="keys-title">
        <h2 id="keys-title">2. Key pages</h2>
        {steps.keyPages ? (
          // Just added: the result takes focus (the Add button is gone).
          query.keys === "added" ? (
            <FocusNotice>{keysDone}</FocusNotice>
          ) : (
            <p>{keysDone}</p>
          )
        ) : d.contentPath !== "sitemap" ? (
          <p>
            Key pages come with the console's sitemap sync. This deployment's content comes{" "}
            {d.contentPath === "sitefinity_connector" ? "through the Sitefinity connector" : "from outside the console"}, so there's nothing
            to add.
          </p>
        ) : takesKeys ? (
          <p>
            <Badge tone="good">Done</Badge> The sync already takes the site's key pages: {plural(keysInSync.length, "key page")} in it now.
          </p>
        ) : !keyChanges ? (
          <p className="notice" data-tone="warning" role="note">
            The site's sitemap can't be read just now, so the key pages can't be compared. Try again in a minute.
          </p>
        ) : (
          <>
            <p className="help">
              The sync keeps the selection from before key pages until you click Add. Add takes the site's pricing, contact, support and
              similar pages ahead of the sections, never leaves key, FAQ, help or support pages out by age alone, and starts a sync. The key
              pages come in place of the pages at the end of the page budget; every page that joins and every page that leaves is listed
              here, and nothing else changes.
            </p>
            <div className="field-grid">
              <div>
                <h3 className="h4">Before: today's selection</h3>
                <p>
                  {plural(view.content.counts.indexed, "page")} answerable,{" "}
                  {keysInSync.length ? plural(keysInSync.length, "key page") : "no key page"} among them.{" "}
                  {keyChanges.drop.length
                    ? `${plural(keyChanges.drop.length, "page")} at the end of the page budget would leave:`
                    : "No page would leave."}
                </p>
                {keyChanges.drop.length > 0 && (
                  <ul className="plain">
                    {keyChanges.drop.map((p) => (
                      <li key={p.url}>
                        <a href={p.url} target="_blank" rel="noreferrer">
                          {p.title ?? pathOf(p.url)}
                        </a>
                        {p.title && <span className="sub">{pathOf(p.url)}</span>}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <div>
                <h3 className="h4">After: with key pages</h3>
                <p>
                  {keyChanges.add.length || keyChanges.join.length
                    ? `${plural(keyChanges.add.length + keyChanges.join.length, "page")} would join${keyChanges.join.length ? `: ${plural(keyChanges.add.length, "key page")}, and ${plural(keyChanges.join.length, "other page")}` : ""}:`
                    : "No key page is missing from the sync. Add still switches it to today's selection, so key, FAQ, help and support pages are never left out by age alone."}
                </p>
                {keyChanges.add.length + keyChanges.join.length > 0 && (
                  <ul className="plain">
                    {keyChanges.add.map((k) => (
                      <li key={k.url}>
                        <Badge tone="neutral">{intentName(k.intent)}</Badge>{" "}
                        <a href={k.url} target="_blank" rel="noreferrer">
                          {k.title ?? pathOf(k.url)}
                        </a>
                        <span className="sub">
                          {k.title ? `${pathOf(k.url)} · ` : ""}
                          {k.detail ?? "Not synced yet."}
                        </span>
                      </li>
                    ))}
                    {keyChanges.join.map((p) => (
                      <li key={p.url}>
                        <a href={p.url} target="_blank" rel="noreferrer">
                          {p.title ?? pathOf(p.url)}
                        </a>
                        <span className="sub">
                          {p.title ? `${pathOf(p.url)} · ` : ""}
                          {p.why}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
            <KeyPagesForm
              action={addKeys.bind(null, id, d.id)}
              setupMode={user.setupMode}
              label={keyChanges.add.length ? `Add ${plural(keyChanges.add.length, "key page")}` : "Add"}
            />
          </>
        )}
      </section>

      <section className="panel" id="prompt" aria-labelledby="prompt-title">
        <h2 id="prompt-title">3. The prompt</h2>
        {query.error && ["changed", "kb", "name"].includes(query.error) && (
          <p className="notice" data-tone="critical" role="alert">
            {query.error === "changed"
              ? "The prompt changed while you were looking: here it is as saved now."
              : query.error === "name"
                ? "Set Name visitors see on the customer first: the prompt is written with it."
                : "Agentic RAG didn't take the new prompt. Nothing changed; try again in a minute."}
          </p>
        )}
        {steps.prompt && (
          <Result focus={Boolean(query.prompt)}>
            <Badge tone="good">Done</Badge> {steps.prompt.saved ? "Prompt saved" : "Current prompt kept"} by {steps.prompt.who},{" "}
            {when(steps.prompt.at)}.
          </Result>
        )}
        {!linesCurrent && (
          <p className="notice" data-tone="warning" role="note">
            The saved prompt lacks {missingLines(d.systemPrompt)}. Update the prompt adds today's template lines and keeps your own lines;
            the before and after are below.
          </p>
        )}
        {update ? (
          steps.prompt && linesCurrent ? (
            <details>
              <summary>Compare again</summary>
              <PromptUpdatePanel before={d.systemPrompt} update={update} save={updatePrompt.bind(null, id, d.id, "up-to-date")} />
            </details>
          ) : (
            <PromptUpdatePanel
              before={d.systemPrompt}
              update={update}
              save={updatePrompt.bind(null, id, d.id, "up-to-date")}
              {...(!steps.prompt && { keep: keepPrompt.bind(null, id, d.id) })}
              {...(!linesCurrent && { saveLabel: "Update the prompt" })}
            />
          )
        ) : (
          <p>
            Name visitors see isn't set, so there's no name to write the prompt with.{" "}
            <Link href={`/customers/${id}/edit#displayName`}>Set it on the customer</Link>
          </p>
        )}
      </section>

      <section className="panel" id="validate" aria-labelledby="validate-title">
        <h2 id="validate-title">4. Validation again</h2>
        {query.error === "validation" && (
          <p className="notice" data-tone="critical" role="alert">
            Validation didn't run: {query.why ?? "try again in a minute"}.
          </p>
        )}
        {validated ? (
          <Result focus={Boolean(query.validated)}>
            <Badge tone={validated.result.passed ? "good" : "warning"}>{validated.result.passed ? "Passed" : "Needs attention"}</Badge> Run
            by {validated.run.who}, {when(validated.run.at)}: {validated.result.questions.filter((q) => q.answered).length} of{" "}
            {validated.result.questions.length} answered
            {intentsAsked.length > 0 &&
              `, with ${plural(intentsAsked.length, "question")} every site gets (${intentsAsked.filter((q) => q.answered && !q.failure).length} answered)`}
            . <Link href={`${base}#validate`}>See the answers</Link>
          </Result>
        ) : (
          <p className="help">
            Asks the last run's questions again, with the questions every site gets (price, contact and support, and buying and trials where
            the site has pages for them) in place of generated ones it doesn't need, and the starter questions, on the pages as they are
            now. Each of the questions every site gets needs an answer or a decision. About a minute; this page reloads with the result.
          </p>
        )}
        <form action={validateAgain.bind(null, id, d.id)}>
          <button className={validated ? "button secondary" : "button"} type="submit" disabled={!canValidate}>
            {validated ? "Run it again" : "Run validation again"}
          </button>
        </form>
        {!canValidate && (
          <p className="help">
            {!steps.content
              ? "Available once step 1 is applied."
              : reextracting > 0
                ? `Waiting for ${plural(reextracting, "page")} to be read again.`
                : `Waiting for the sync that brings the key pages in${view.content.estimate ? ` (${view.content.estimate.text})` : ""}.`}
          </p>
        )}
      </section>

      <section className="panel" aria-labelledby="signoff-title">
        <h2 id="signoff-title">5. Review and sign off</h2>
        <p>
          Review checks everything again by today's rules, the Client's name and the Content line included. Signing off there records
          today's checks and clears "signed off under older checks".
        </p>
        <Link className={validated ? "button" : "button secondary"} href={`${base}/review`}>
          Review and sign off
        </Link>
      </section>
    </main>
  );
}
