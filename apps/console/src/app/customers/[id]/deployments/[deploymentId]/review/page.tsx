// Review and sign off: the last step before "Ready to embed". One screen with what visitors will
// see (the saved widget over the site, with a no-answer reply one click away) and a line for each
// thing they'll meet. A named person signs it off, and only then does the chat show on sites.

import { auditLog, users } from "@launchpad/db";
import {
  configStrings,
  confirmedTable,
  defaultWidgetSettings,
  languageSetting,
  type PublicWidgetConfig,
  resolveTheme,
} from "@launchpad/theme";
import { and, asc, desc, eq, gt, inArray, isNull } from "drizzle-orm";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { intentRouting } from "@/app/api/public/deployments/[id]/config/intents.ts";
import { pagePaths } from "@/app/api/public/deployments/[id]/config/pages.ts";
import { AccountBlockNotice } from "@/components/account-block-notice.tsx";
import { ModelText } from "@/components/model-text.tsx";
import { Badge } from "@/components/ui.tsx";
import { accountBlock } from "@/lib/account-block.ts";
import { blockSignOffNote } from "@/lib/ask-refusal.ts";
import { currentUser } from "@/lib/auth.ts";
import { priceTableRead } from "@/lib/content.ts";
import { answersLanguageNote } from "@/lib/content-plan.ts";
import { db } from "@/lib/db.ts";
import { loadDeploymentView, modelTextLinks } from "@/lib/deployment-view.ts";
import { historyActor, typedNear } from "@/lib/history.ts";
import { ANSWERING_RULES } from "@/lib/prompt.ts";
import {
  canSignOff,
  contentChangeWords,
  type LineState,
  priceTableLine,
  type ReviewLine,
  reviewDecisions,
  SKIP_FOR_LINE,
  signOffOffer,
} from "@/lib/review.ts";
import { contentLanguages } from "@/lib/validation.ts";
import { plainQuote, provisionalTable } from "@/lib/validation-rules.ts";
import { previewKey } from "@/lib/widget.ts";
import { changedSinceSignOff, fieldWords } from "@/lib/widget-diff.ts";
import { PriceTableSection } from "../price-table/price-table-section.tsx";
import { runValidationNow, signOffDeployment, skipPart, switchAnsweringRules, undoSkip } from "./actions.ts";
import { ReviewPreview, SignOffForm, SkipForm, SwitchRulesForm } from "./review-forms.tsx";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string; deploymentId: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { id, deploymentId } = await params;
  const view = await loadDeploymentView(id, deploymentId);
  return { title: view ? `Review · ${view.deployment.name} · ${view.tenant.name}` : "Review" };
}

const BADGE: Record<LineState, { tone: "good" | "neutral" | "warning" | "critical"; text: string }> = {
  ok: { tone: "good", text: "Done" },
  skipped: { tone: "neutral", text: "Skipped" },
  todo: { tone: "warning", text: "To do" },
  check: { tone: "warning", text: "Check this" },
  info: { tone: "neutral", text: "For information" },
};

// The changes that touch what visitors see, in words.
const CHANGE_WORDS: Record<string, string> = {
  "deployment.widget": "changed the widget",
  "deployment.prompt": "changed how it answers",
  "deployment.starters": "changed the starter questions",
  "deployment.domains": "changed the domains",
  "content.up-to-date": "applied today's content rules, taking pages out of the chat",
  "deployment.starters.removed": "removed a starter that stopped answering",
  "deployment.price-table.confirm": "confirmed the price table",
  "deployment.price-table.edit": "corrected the price table",
  "deployment.price-table.add": "added to the price table",
  "deployment.price-table.delete": "removed a row from the price table",
  "deployment.price-table.read": "read the pricing page again and found it changed",
};

// Who made a change, for the record, as History says it (lib/history.ts): the signed-in person;
// the name typed in setup mode, marked "(not verified)" once; the automatic re-run; or, for a
// setup-mode change that recorded no name, the name typed in the same sitting (typedNear).
type Entry = { action?: string; at: Date; detail: unknown; name: string | null; email: string | null };
function whoChanged(c: Entry, typed: readonly { at: Date; name: string }[]): string {
  const detail = (c.detail ?? {}) as Record<string, unknown>;
  const user = c.name ?? c.email;
  return historyActor(c.action ?? "", detail, user, user ? undefined : typedNear(typed, c.at));
}
// What a widget save changed, in the partner's words (lib/widget-diff.ts).
function changeWords(action: string, detail: unknown): string {
  const keys = (detail as { changed?: string[] } | null)?.changed;
  const table = detail as { plan?: unknown; changes?: unknown } | null;
  if (action.startsWith("deployment.price-table.")) {
    const said = Array.isArray(table?.changes)
      ? `: ${table.changes.join("; ")}`
      : typeof table?.plan === "string"
        ? ` (${table.plan})`
        : "";
    return `${CHANGE_WORDS[action] ?? action}${said}`;
  }
  if (action !== "deployment.widget" || !keys?.length) return CHANGE_WORDS[action] ?? action;
  return `changed ${fieldWords(keys)}`;
}

export default async function ReviewPage({
  params,
  searchParams,
}: Params & { searchParams: Promise<{ prompt?: string; run?: string; rules?: string }> }) {
  const { id, deploymentId } = await params;
  const { prompt: promptSaved } = await searchParams;
  // The Client's name line reads the prompt the Knowledge Box answers with too.
  const view = await loadDeploymentView(id, deploymentId, { servedPrompt: true });
  if (!view) notFound();
  const { deployment: d, signOff, base } = view;
  const { run: ran, rules: switched } = await searchParams;
  // Pages kept by hand and key pages the sync couldn't use have their own lines, after Content
  // (deployment-view passes keptByHand and keyPagesUnused to reviewLines).
  // With the price table's line (round 6): confirming it holds up sign-off only when there's a table.
  const review: ReviewLine[] = [
    ...view.review,
    {
      ...priceTableLine(base, d.priceTable, d.priceTableConfirmation, d.priceTable ? true : await priceTableRead(d.id)),
      href: "#price-table",
    },
  ];
  const user = await currentUser();
  const provisioned = Boolean(d.kbId) && (d.status === "live" || d.status === "paused");
  const ready = canSignOff(review);
  // Sign-off during a block says why it's unavailable: answers can't be checked (fix cycle 7d).
  const blocked = await accountBlock(db()).catch(() => undefined);
  const required = review.filter((l) => l.required);
  const open = required.filter((l) => l.state !== "ok" && l.state !== "skipped").length;
  const decisions = reviewDecisions(view.notes);
  // No new sign-off while the last one stands, so the button never offers changes there aren't.
  const offer = signOffOffer(signOff.state, Boolean(view.olderChecks));
  // Changes of the name visitors see since the sign-off: the customer's, so not in the hash.
  const renamed = signOff.state === "changed" ? view.nameChanges.filter((c) => c.at > new Date(signOff.signOff.at)) : [];
  // Pages added, kept or left out by hand since the sign-off (and key pages and content
  // settings), where they still differ: not in the hash either, so listed the same way.
  const contentChanged = signOff.state === "changed" ? view.contentChanges : [];

  const changes =
    signOff.state === "changed"
      ? await db()
          .select({ action: auditLog.action, at: auditLog.at, detail: auditLog.detail, name: users.name, email: users.email })
          .from(auditLog)
          .leftJoin(users, eq(users.id, auditLog.actorUserId))
          .where(
            and(
              eq(auditLog.targetId, d.id),
              inArray(auditLog.action, Object.keys(CHANGE_WORDS)),
              gt(auditLog.at, new Date(signOff.signOff.at)),
            ),
          )
          .orderBy(desc(auditLog.at))
          // A re-read that left the table standing changed nothing.
          .then((all) =>
            all.filter((c) => c.action !== "deployment.price-table.read" || (c.detail as { confirmAgain?: unknown } | null)?.confirmAgain),
          )
      : [];
  // Answers an automatic re-run opened since the sign-off: "nothing has changed" isn't so then (round 7).
  const rerunOpened =
    signOff.state === "signed"
      ? (
          await db()
            .select({ detail: auditLog.detail })
            .from(auditLog)
            .where(
              and(eq(auditLog.targetId, d.id), eq(auditLog.action, "deployment.validate"), gt(auditLog.at, new Date(signOff.signOff.at))),
            )
        ).some((e) => {
          const detail = (e.detail ?? {}) as { auto?: unknown; opened?: unknown };
          return Boolean(detail.auto) && Array.isArray(detail.opened) && detail.opened.length > 0;
        })
      : false;
  // Names typed in setup mode, oldest first, for changes that recorded none.
  const typed =
    signOff.state === "changed"
      ? (
          await db()
            .select({ at: auditLog.at, detail: auditLog.detail })
            .from(auditLog)
            .where(and(eq(auditLog.targetId, d.id), isNull(auditLog.actorUserId)))
            .orderBy(asc(auditLog.at))
        ).flatMap((e) => {
          const detail = (e.detail ?? {}) as { name?: unknown; verified?: unknown; auto?: unknown };
          return typeof detail.name === "string" && detail.name.trim() && detail.verified === false && !detail.auto
            ? [{ at: e.at, name: detail.name.trim() }]
            : [];
        })
      : [];
  // The widget fields that still differ from the signed-off version (a field changed and changed
  // back drops out), from every save since, oldest first.
  const stillDifferent = changedSinceSignOff(
    changes
      .filter((c) => c.action === "deployment.widget")
      .reverse()
      .map((c) => c.detail),
  );

  const priceTable = confirmedTable(d);
  const pricingFacts = priceTable ? undefined : provisionalTable(d.priceTable?.rows ?? []);
  const config: PublicWidgetConfig = {
    deploymentId: d.id,
    zone: "",
    kbId: "",
    searchConfig: "",
    theme: resolveTheme(d.theme).theme,
    settings: { ...defaultWidgetSettings, ...d.widgetSettings, language: languageSetting(d.language) },
    online: true,
    // Live answers here are asked as the site asks them: in the question's language first.
    contentLanguages: await contentLanguages(d.id),
    // And intent questions with their intent's configuration and pages, as the site's chat routes them.
    ...(await intentRouting(d).catch(() => ({}))),
    // As the public config serves them: the confirmed price table the chat checks price answers
    // against, and the synced pages a model-written link may open.
    ...(priceTable && { priceTable }),
    // And the same two the published chat has beside it, or the preview shows another chat (round 7):
    // the pricing page's rows while no table is confirmed (a denial's card), and the widget's text in
    // this chat's languages (German no-answers came back in English).
    ...(pricingFacts && { pricingFacts }),
    strings: configStrings(languageSetting(d.language), d.widgetSettings.languages ?? []),
    ...(await pagePaths(d.id).catch(() => ({}))),
  };
  const links = await modelTextLinks(d);
  const languageNote = answersLanguageNote(d.language, config.contentLanguages ?? []);
  const canAsk = Boolean(d.kbId && (await previewKey(d.id)));
  // Newer answering rules the rollout's re-check held for this signed-off chat (item 6): its last
  // validation answers under the rules it runs, against the same questions under the latest.
  const [heldEntry] =
    d.answeringRules < ANSWERING_RULES
      ? await db()
          .select({ at: auditLog.at, detail: auditLog.detail })
          .from(auditLog)
          .where(and(eq(auditLog.targetId, d.id), eq(auditLog.action, "deployment.rules.held")))
          .orderBy(desc(auditLog.at))
          .limit(1)
      : [];
  const heldDetail = (heldEntry?.detail ?? {}) as {
    to?: unknown;
    from?: unknown;
    total?: unknown;
    worse?: unknown;
    why?: unknown;
    changes?: unknown;
  };
  const held =
    heldEntry && Number(heldDetail.to) === ANSWERING_RULES
      ? {
          at: heldEntry.at,
          from: Number(heldDetail.from ?? d.answeringRules),
          total: typeof heldDetail.total === "number" ? heldDetail.total : undefined,
          why: typeof heldDetail.why === "string" ? heldDetail.why : undefined,
          changes: typeof heldDetail.changes === "string" ? heldDetail.changes : "",
          worse: (Array.isArray(heldDetail.worse) ? heldDetail.worse : []).flatMap((w) => {
            const r = (w ?? {}) as Record<string, unknown>;
            const str = (v: unknown) => (typeof v === "string" ? v : "");
            return str(r.question) ? [{ question: str(r.question), before: str(r.before), after: str(r.after), was: str(r.was) }] : [];
          }),
        }
      : undefined;

  return (
    <main id="main" className="shell">
      <p className="crumbs">
        <Link href={base}>{d.name}</Link>
      </p>
      <div className="page-head">
        <h1>Review and sign off</h1>
        <p className="muted">
          What visitors to {new URL(d.siteUrl).host} will see. Once a person signs it off, the chat shows on the site's pages; until then
          the snippet can already be in place, and nothing appears.
        </p>
      </div>

      <AccountBlockNotice />

      {languageNote && (
        <p className="notice" data-tone="warning" role="note">
          {languageNote}
        </p>
      )}

      {signOff.state === "signed" && (
        <p className="notice" data-tone="good" role="status">
          Signed off by {signOff.signOff.name}, {signOff.signOff.at.slice(0, 16).replace("T", " ")} UTC.
          {rerunOpened
            ? " An automatic re-run has changed answers since: see the Validation line."
            : " Nothing visitors see has changed since."}
        </p>
      )}
      {signOff.state === "changed" && (
        <div className="notice" data-tone="warning" role="status">
          <p>
            Signed off by {signOff.signOff.name} ({signOff.signOff.at.slice(0, 16).replace("T", " ")} UTC), and what visitors see has
            changed since. The chat keeps serving; check the changes and sign off again.
          </p>
          {(changes.length > 0 || renamed.length > 0 || contentChanged.length > 0) && (
            <ul className="plain">
              {renamed.map((c) => (
                <li key={`name-${c.at.toISOString()}`}>
                  {whoChanged({ at: c.at, detail: c.typed ? { name: c.typed } : {}, name: c.by, email: null }, typed)} changed the client's
                  name from "{c.before}" to "{c.after}", {c.at.toISOString().slice(0, 16).replace("T", " ")} UTC
                </li>
              ))}
              {contentChanged.map((c) => (
                <li key={`content-${c.kind}-${c.url ?? c.label}-${c.at}`}>
                  {whoChanged({ at: new Date(c.at), detail: c.name ? { name: c.name } : {}, name: c.byName ?? null, email: null }, typed)}{" "}
                  {contentChangeWords(c)}, {c.at.slice(0, 16).replace("T", " ")} UTC
                </li>
              ))}
              {stillDifferent.size > 0 && <li>Still different from the signed-off version: {fieldWords([...stillDifferent])}.</li>}
              {changes.slice(0, 6).map((c) => (
                <li key={`${c.action}-${c.at.toISOString()}`}>
                  {whoChanged(c, typed)} {changeWords(c.action, c.detail)}, {c.at.toISOString().slice(0, 16).replace("T", " ")} UTC
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {view.rulesChanges.length > 0 && (
        <div className="notice" role="status">
          <p>Answering-rules changes since the sign-off (they don't need a new sign-off):</p>
          <ul className="plain">
            {view.rulesChanges.map((c) => (
              <li key={`rules-${c.at}`}>
                {c.text.charAt(0).toUpperCase() + c.text.slice(1)}, {c.at.slice(0, 16).replace("T", " ")} UTC
              </li>
            ))}
          </ul>
        </div>
      )}
      {view.olderChecks && (
        <p className="notice" data-tone="warning" role="status">
          Signed off under older checks: the review checks more now than when {signOff.state !== "none" && signOff.signOff.name} signed it
          off. It keeps serving. <Link href={`${base}/review/up-to-date`}>Bring up to date</Link>, then sign off again.
        </p>
      )}
      {switched && (
        <p className="notice" data-tone="good" role="status">
          Switched to answering rules v{switched}. History records who switched it and when.
        </p>
      )}
      {held && (
        <section className="notice" data-tone="warning" aria-labelledby="rules-held-title">
          <h2 id="rules-held-title">Newer answering rules are on hold</h2>
          <p>
            This chat still answers under answering rules v{held.from}. On {held.at.toISOString().slice(0, 16).replace("T", " ")} UTC the
            re-check asked its last validation questions under v{ANSWERING_RULES}
            {held.why
              ? `, and couldn't compare them: ${held.why}`
              : `, and ${held.worse.length} of ${held.total ?? held.worse.length} answers got worse`}
            . Visitors keep the current answers until a person switches.
          </p>
          {held.changes && (
            <p className="help">
              What v{ANSWERING_RULES} changes: {held.changes}
            </p>
          )}
          {held.worse.length > 0 && (
            // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling region must take focus to scroll by keyboard (WCAG 2.1.1).
            <section className="table-wrap" tabIndex={0} aria-label="Answers under the current and the newer answering rules">
              <table>
                <caption className="sr-only">Answers under the current rules and under the newer ones</caption>
                <thead>
                  <tr>
                    <th scope="col">Question</th>
                    <th scope="col">Now (v{held.from})</th>
                    <th scope="col">With v{ANSWERING_RULES}</th>
                  </tr>
                </thead>
                <tbody>
                  {held.worse.map((w) => (
                    <tr key={w.question}>
                      <th scope="row">{w.question}</th>
                      <td>{w.before ? <ModelText text={w.before} links={links} /> : "—"}</td>
                      <td>
                        {w.after ? <ModelText text={w.after} links={links} /> : "—"}
                        {w.was && <span className="sub">{w.was}</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}
          <SwitchRulesForm action={switchAnsweringRules.bind(null, id, d.id)} setupMode={user.setupMode} version={ANSWERING_RULES} />
        </section>
      )}
      {ran && (
        <p className="notice" data-tone={ran === "done" ? "good" : "critical"} role="status">
          {ran === "done" ? "Validation ran again: the Validation line below has the result." : `Validation didn't run: ${ran}`}
        </p>
      )}
      {promptSaved && (
        <p className="notice" data-tone="good" role="status">
          Prompt saved to the Knowledge Box and checked again below.
        </p>
      )}
      {!d.published && signOff.state === "none" && (
        <p className="notice" data-tone="neutral" role="status">
          Not published yet: the chat stays hidden on every site until this is signed off.
        </p>
      )}
      {d.published && signOff.state === "none" && (
        <p className="notice" data-tone="warning" role="status">
          This chat was already serving before sign-off existed. It keeps serving; sign it off once you've checked it.
        </p>
      )}

      <div className="review-layout">
        <section className="panel" aria-labelledby="see-title">
          <h2 id="see-title">What visitors see</h2>
          <p className="help">Switch to Phone, and to "No answer found" to see what a visitor gets when the chatbot can't help.</p>
          {provisioned ? (
            <ReviewPreview
              src={`${base}/widget/preview${view.scan ? `?v=${new Date(view.scan.at).getTime()}` : ""}`}
              config={config}
              canAsk={canAsk}
              siteUrl={d.siteUrl}
            />
          ) : (
            <p className="muted">Shown once the deployment is provisioned.</p>
          )}
        </section>

        <section className="panel" aria-labelledby="lines-title">
          <h2 id="lines-title">Checks</h2>
          <p className="muted">
            {open ? `${open} of ${required.length} still to do.` : `All ${required.length} done or skipped on purpose.`} The lines marked
            "For information" don't hold up sign-off.
          </p>
          <ul className="review-lines plain">
            {review.map((line) => (
              <li key={line.key} data-state={line.state}>
                <div className="review-line-head">
                  <Badge tone={BADGE[line.state].tone}>{BADGE[line.state].text}</Badge> <strong>{line.label}</strong>
                </div>
                <p className="step-detail">{line.detail}</p>
                <div className="actions">
                  {line.href && (line.state !== "ok" || line.key === "content") && (
                    <Link href={line.href}>{line.state === "info" || line.state === "ok" ? "Open" : (line.fix ?? "Fix it")}</Link>
                  )}
                  {line.runNow && provisioned && (
                    <form action={runValidationNow.bind(null, id, d.id)}>
                      <button type="submit" className="button secondary">
                        Run it now
                      </button>
                    </form>
                  )}
                  {line.skip && (
                    <SkipForm
                      id={`skip-${line.key}`}
                      action={skipPart.bind(null, id, d.id, line.skip.kind)}
                      consequence={line.skip.consequence}
                      setupMode={user.setupMode}
                    />
                  )}
                  {line.state === "skipped" && SKIP_FOR_LINE[line.key] && (
                    <form action={undoSkip.bind(null, id, d.id, SKIP_FOR_LINE[line.key]!)}>
                      <button type="submit" className="link-button">
                        Undo
                      </button>
                    </form>
                  )}
                </div>
              </li>
            ))}
          </ul>
          {provisioned && (
            <PriceTableSection
              tenantId={id}
              deploymentId={d.id}
              table={d.priceTable ?? null}
              confirmation={d.priceTableConfirmation ?? null}
              setupMode={user.setupMode}
            />
          )}
          {decisions.length > 0 && (
            <div className="review-decisions">
              <h3 className="h4">Decisions on the way</h3>
              <ul className="plain">
                {decisions.map((text) => (
                  <li key={text}>{plainQuote(text)}</li>
                ))}
              </ul>
            </div>
          )}
          {offer ? (
            <SignOffForm
              action={signOffDeployment.bind(null, id, d.id)}
              enabled={ready && provisioned && !blocked}
              {...(blocked && { unavailable: blockSignOffNote(blocked.state) })}
              setupMode={user.setupMode}
              offer={offer}
            />
          ) : (
            <p className="help">
              Nothing to sign off again: {rerunOpened ? "no setting has changed" : "nothing visitors see has changed"} since the sign-off,
              so it still stands. If a line above isn't done, fixing it is enough.
            </p>
          )}
        </section>
      </div>
    </main>
  );
}
