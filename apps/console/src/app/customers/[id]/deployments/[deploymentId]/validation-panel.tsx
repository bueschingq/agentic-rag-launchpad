"use client";

// Validation: questions a visitor would ask, asked of the real chatbot, with the answer and
// sources for each, and the domain-lock check per allowed domain. Four questions are generated
// from the site and the partner adds at least two of their own; the widget's starter questions
// are asked in every run too. The list is edited before the run, and kept in this browser until
// it runs, so a reload doesn't lose it. Answers are judged as the widget judges them; one that
// talks about how it works, or clearly comes back in another language than it was asked in,
// fails, and one that states a price or a date, rests on overview pages only, or may be in
// another language, needs a person to check it: each figure shows beside the sentence or table
// row that states it in the synced pages, with that page to open. A No answer can be fixed from
// here: the site's pages that may answer it, added in one click and asked again once they're
// in, or "The site doesn't cover this" with a reason. Removing a question that had a problem asks
// why. The run streams its progress, and runs again by itself once half the pages are answerable
// and when the first sync finishes. Questions asked here are partner tests: never billed.
//
// Round 4: every run asks the intent questions (price, contact and support, and buy and trial or
// demo where the site has a key page for them), and each of those, the starters and the partner's
// own questions needs a decision when it gets No answer. A reply that says in its own words that
// the site lacks it is No answer, shown as written; a very short answer, or one whose sources
// aren't about the question, is Check this and counts once someone clicks I checked it. Add these
// pages asks first before keeping a page a date or stale-price rule leaves out.

import type { PreflightResult, ValidationResult } from "@launchpad/db";
import type { LinkContext, PublicWidgetConfig } from "@launchpad/theme";
import { useParams, useRouter } from "next/navigation";
import { type ReactNode, useEffect, useRef, useState, useTransition } from "react";
import { focusSoon, useFocusOnChange } from "@/components/focus.tsx";
import { ModelText } from "@/components/model-text.tsx";
import { useTypedName } from "@/components/typed-name.ts";
import { Badge } from "@/components/ui.tsx";
import { isRefusalFailure, plainFailure } from "@/lib/ask-refusal.ts";
import type { KeepAsk } from "@/lib/validation.ts";
import {
  aboutSeconds,
  asRun,
  CHECK_TEXT,
  type ContentAtRun,
  chosenStarters,
  type DraftQuestion,
  draftProblem,
  estimateSeconds,
  FALLBACK_NOTE,
  type FigureCheck,
  figureList,
  GENERATED_QUESTIONS,
  halfwayNote,
  isFallbackQuestion,
  LEAK_FAILURE,
  MAX_OWN_AND_GENERATED,
  needsCheck,
  OWN_QUESTIONS,
  openHold,
  PASS_SHARE,
  partialContentNote,
  passedNote,
  passReasons,
  plainQuote,
  QUESTION_STUBS,
  type QuestionIntent,
  questionKey,
  questionWords,
  quotedReason,
  type RunQuestion,
  removedProblems,
  rerunsItself,
  runCounts,
  STARTER_FAILURE,
  thinRun,
  type ValidationRun,
  validationPassed,
} from "@/lib/validation-rules.ts";
import { FindPage } from "./content/find-page.tsx";
import { StarterPicker } from "./starter-picker.tsx";
import {
  acknowledgeAnswer,
  addPages,
  answeringPages,
  generateTestQuestions,
  panelContext,
  runItNow,
  siteDoesntCover,
} from "./validation-actions.ts";

interface Props {
  validation: ValidationResult | null;
  preflight: PreflightResult | null;
  canRun: boolean;
  // How much is answerable now, as the Content card counts it (null: not synced by the console).
  // From the page, so every refresh brings it up to date.
  content: ContentAtRun | null;
  // The saved widget, for the starter picker's preview.
  widget?: PublicWidgetConfig;
  // The links an answer may keep, as the chat's (track C's modelTextLinks): answers render as the
  // chat renders them, with a note when their formatting couldn't be shown.
  links?: LinkContext;
}

// What each intent question asks about, under it in the list.
const INTENT_LABEL: Record<QuestionIntent, string> = {
  price: "price",
  contact: "contacting the team",
  support: "support",
  buy: "where to buy",
  trial: "a trial or demo",
  events: "upcoming events",
};

const FLAG_TEXT: Record<string, string> = {
  price: "it states a price",
  date: "it states a date or a deadline",
  "overview-sources": "the sources are overview pages",
  "stale-source": "it cites a page flagged as out of date (an old price or offer, over 2 years old, or a thank-you page)",
};

const utc = (at: string) => `${new Date(at).toISOString().slice(0, 16).replace("T", " ")} UTC`;

// Kept in this browser only (per person, never shared): the unrun question list with the
// reasons for removals, and the name typed in setup mode, so acknowledging and choosing starters
// don't ask for it again.
const draftKey = (deploymentId: string) => `launchpad:validation-draft:${deploymentId}`;
interface SavedDraft {
  draft: DraftQuestion[];
  note?: string;
  reasons?: Record<string, string>;
  // The run it was edited after: a newer run makes it stale.
  after: string | null;
}
const readStored = <T,>(key: string): T | undefined => {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : undefined;
  } catch {
    return undefined;
  }
};
const writeStored = (key: string, value: unknown) => {
  try {
    if (value === undefined) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Private windows and blocked storage: the draft just isn't kept.
  }
};

interface Progress {
  done: number;
  total: number;
  started: number;
  estimate: number;
}

// What a person does to one answer: check it, add pages for it, or say the site doesn't cover it.
type Doing = "generate" | "run" | "now" | `ack:${number}` | `pages:${number}` | `cover:${number}` | `keep:${number}`;

export function ValidationPanel({ validation: saved, preflight, canRun, content, widget, links }: Props) {
  const validation = asRun(saved);
  const { id: tenantId, deploymentId } = useParams<{ id: string; deploymentId: string }>();
  const router = useRouter();
  const [who, setWho] = useState<Awaited<ReturnType<typeof panelContext>>>();
  const [typedName, rememberName] = useTypedName();
  const [editing, setEditing] = useState(!validation);
  // The saved run's list: what Edit starts from and Cancel goes back to, undoing removals and new
  // generated questions (round 5: a cancelled "New generated questions" was run next time).
  const savedList = (): DraftQuestion[] =>
    validation?.questions
      .filter((q) => !q.starterOnly)
      .map((q) => ({
        question: q.question,
        own: !!q.own,
        ...(q.intent && { intent: q.intent }),
        ...(q.intent && q.wording && { wording: q.wording }),
      })) ?? [];
  const [draft, setDraft] = useState<DraftQuestion[]>(savedList);
  const [note, setNote] = useState(validation?.generationNote);
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [restored, setRestored] = useState(false);
  const [error, setError] = useState<{ text: string; at?: number }>();
  const [pending, start] = useTransition();
  const [doing, setDoing] = useState<Doing>();
  const [progress, setProgress] = useState<Progress>();
  const [now, setNow] = useState(() => Date.now());
  // Generate, and Edit the questions, put focus on the list; a finished run, on its result.
  const [generations, setGenerations] = useState(0);
  const editorHeading = useFocusOnChange<HTMLHeadingElement>(editing && generations + 1);
  const resultBlock = useFocusOnChange<HTMLDivElement>(!editing && validation?.at);
  // The answer a person just decided about (checked it, added pages, doesn't cover): its result
  // takes focus.
  const [decided, setDecided] = useState<{ kind: "ack" | "pages" | "cover" | "keep"; index: number }>();
  // Pages a date or stale-price rule leaves out, waiting for Keep it anyway, by answer.
  const [keepAsk, setKeepAsk] = useState<{ index: number; asks: KeepAsk[] }>();
  const focusNext = useRef<number | null>(null);
  const inputs = useRef<(HTMLInputElement | null)[]>([]);
  // What's happening while a run or a generation is out: focus goes here as it starts, not to <body>
  // when the button it was on is disabled.
  const statusLine = useRef<HTMLParagraphElement>(null);
  const focusStatus = () => requestAnimationFrame(() => statusLine.current?.focus());
  const ranFrom = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    panelContext(tenantId, deploymentId)
      .then(setWho)
      .catch(() => {});
  }, [tenantId, deploymentId]);

  // After a reload: the list as it was, if it was edited after the latest run.
  // biome-ignore lint/correctness/useExhaustiveDependencies: once, on mount
  useEffect(() => {
    const kept = readStored<SavedDraft>(draftKey(deploymentId));
    if (kept?.draft?.length && kept.after === (validation?.at ?? null)) {
      setDraft(kept.draft);
      setNote(kept.note);
      setReasons(kept.reasons ?? {});
      setEditing(true);
      setRestored(true);
    } else if (kept) writeStored(draftKey(deploymentId), undefined);
  }, [deploymentId]);

  useEffect(() => {
    if (!editing || doing === "run") return;
    writeStored(draftKey(deploymentId), { draft, note, reasons, after: validation?.at ?? null } satisfies SavedDraft);
  }, [draft, note, reasons, editing, doing, deploymentId, validation?.at]);

  // A finished run shows once the page brings its result.
  useEffect(() => {
    if (doing !== "run" || ranFrom.current === undefined || validation?.at === ranFrom.current) return;
    ranFrom.current = undefined;
    setDoing(undefined);
    setProgress(undefined);
    setEditing(false);
    setRestored(false);
    setReasons({});
  }, [validation?.at, doing]);

  // The clock while a run is out.
  useEffect(() => {
    if (!progress) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [progress]);

  // While the worker owes this page something, the page looks again: every 10 s for a question
  // asked again once its added pages are in, every 30 s for the run again after the first sync.
  const pagesAdded = Boolean(validation?.questions.some((q) => q.added && !q.added.askedAgain));
  const waitEvery = pagesAdded ? 10_000 : rerunsItself(validation) ? 30_000 : 0;
  useEffect(() => {
    if (!waitEvery || editing) return;
    const timer = setInterval(() => router.refresh(), waitEvery);
    return () => clearInterval(timer);
  }, [waitEvery, editing, router]);

  // A decision on an answer that failed: its button was disabled while it worked, so focus goes to
  // what went wrong, under that answer.
  useEffect(() => {
    if (error?.at !== undefined) document.getElementById(`answer-error-${error.at}`)?.focus();
  }, [error]);

  useEffect(() => {
    if (focusNext.current === null) return;
    const input = inputs.current[focusNext.current];
    focusNext.current = null;
    if (!input) return;
    input.focus();
    const at = input.value.indexOf("…");
    if (at >= 0) input.setSelectionRange(at, at + 1);
  });

  const starters = who?.allStarters ?? [];
  const generated = draft.filter((q) => !q.own && !isFallbackQuestion(q.question));
  const filled = draft.filter((q) => q.question.trim());
  const filledKeys = new Set(filled.map((q) => questionKey(q.question)));
  const startersToo = starters.filter((q) => !filledKeys.has(questionKey(q)));
  // Questions the last run had a problem with that this list no longer asks: each needs a reason.
  const dropped = editing ? removedProblems(validation, filled) : [];
  const unexplained = dropped.filter((r) => !reasons[r.question]?.trim());
  const problem =
    draftProblem(draft) ??
    (unexplained.length
      ? `Say why ${unexplained.length === 1 ? "the removed question is" : `${unexplained.length} removed questions are`} gone`
      : dropped.length && who?.setupMode && !typedName.trim()
        ? "Type your name to record the removal"
        : undefined);
  const estimate = estimateSeconds(filled.length + startersToo.length, validation);
  const update = (i: number, question: string) => setDraft((all) => all.map((q, n) => (n === i ? { ...q, question } : q)));
  // Removing a question the last run had a problem with asks why: focus goes to that reason field.
  // Otherwise to the question that took its place, or the one before.
  const remove = (i: number) => {
    const gone = draft[i];
    const next = draft.filter((_, n) => n !== i);
    setDraft(next);
    const reasonAt = gone
      ? removedProblems(
          validation,
          next.filter((q) => q.question.trim()),
        ).findIndex((r) => questionKey(r.question) === questionKey(gone.question))
      : -1;
    requestAnimationFrame(() =>
      (reasonAt >= 0
        ? document.getElementById(`removed-${reasonAt}`)
        : (document.getElementById(`question-${i}`) ?? document.getElementById(`question-${i - 1}`))
      )?.focus(),
    );
  };
  const addOwn = (question = "") => {
    focusNext.current = draft.length;
    setDraft((all) => [...all, { question, own: true }]);
  };

  const generate = () => {
    setError(undefined);
    setDoing("generate");
    focusStatus();
    start(async () => {
      const result = await generateTestQuestions(tenantId, deploymentId);
      if ("error" in result) setError({ text: result.error });
      else {
        // The intent questions, then new generated ones; the partner's own stay.
        setDraft((all) => [
          ...result.intents.map((i) => ({ question: i.question, own: false, intent: i.intent, wording: i.wording })),
          ...result.questions.map((question) => ({ question, own: false })),
          ...all.filter((q) => q.own),
        ]);
        setNote(result.note);
        setEditing(true);
        setGenerations((n) => n + 1);
      }
      setDoing(undefined);
    });
  };

  const run = async () => {
    setError(undefined);
    setDoing("run");
    focusStatus();
    setProgress({ done: 0, total: filled.length + startersToo.length, started: Date.now(), estimate });
    const fail = (message: string) => {
      setError({ text: message });
      setDoing(undefined);
      setProgress(undefined);
    };
    try {
      const res = await fetch(`/customers/${tenantId}/deployments/${deploymentId}/validation/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          draft: filled,
          note,
          reasons: dropped.map((r) => ({ question: r.question, reason: reasons[r.question] ?? "" })),
          typedName,
        }),
      });
      if (!res.ok || !res.body) {
        const body = (await res.json().catch(() => undefined)) as { error?: string } | undefined;
        return fail(body?.error ?? `Validation didn't start (${res.status}).`);
      }
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffered = "";
      let end: { finished?: boolean; error?: string } | undefined;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffered += value;
        const lines = buffered.split("\n");
        buffered = lines.pop() ?? "";
        for (const line of lines.filter(Boolean)) {
          const event = JSON.parse(line) as { done?: number; total?: number; finished?: boolean; error?: string };
          const { done: answered, total } = event;
          if (typeof answered === "number") setProgress((p) => p && { ...p, done: answered, total: total ?? p.total });
          if (event.finished || event.error) end = event;
        }
      }
      if (end?.error) return fail(end.error);
      if (!end?.finished)
        return fail("The connection dropped before the run finished. Its result shows here once it's saved: reload in a minute.");
      writeStored(draftKey(deploymentId), undefined);
      ranFrom.current = validation?.at ?? null;
      router.refresh();
      // Should the refresh not bring the new run, stop waiting for it.
      setTimeout(() => {
        if (ranFrom.current === undefined) return;
        ranFrom.current = undefined;
        setDoing(undefined);
        setProgress(undefined);
      }, 15_000);
    } catch (err) {
      fail(`Validation didn't finish: ${err instanceof Error ? err.message : err}`);
    }
  };

  // One of the decisions on an answer, with its error shown under that answer. Pages that need a
  // reason before they're kept come back for the Keep it anyway step.
  const decide = (
    kind: "ack" | "pages" | "cover" | "keep",
    index: number,
    act: () => Promise<{ error?: string; needsReason?: KeepAsk[] }>,
  ) => {
    setError(undefined);
    setDoing(`${kind}:${index}`);
    start(async () => {
      const result: { error?: string; needsReason?: KeepAsk[] } = await act().catch((err: unknown) => ({
        error: err instanceof Error ? err.message : String(err),
      }));
      const asks = result.needsReason ?? [];
      if (kind === "pages") setKeepAsk(asks.length ? { index, asks } : undefined);
      if (result.error && !asks.length) setError({ text: result.error, at: index });
      else if (!result.error) setDecided({ kind, index });
      setDoing(undefined);
      router.refresh();
    });
  };

  // "Run it now": the last run's questions, without waiting for half the pages.
  const runNow = () => {
    setError(undefined);
    setDoing("now");
    focusStatus();
    start(async () => {
      const result: { error?: string } = await runItNow(tenantId, deploymentId).catch((err: unknown) => ({
        error: err instanceof Error ? err.message : String(err),
      }));
      if (result.error) setError({ text: result.error });
      setDoing(undefined);
      router.refresh();
    });
  };

  const busy = pending || doing === "run" || doing === "now";
  // Before any page is answerable, Generate and the picker have nothing to read: why, and when.
  const notYet = content
    ? `Generate questions and starter suggestions work once some pages are answerable: now ${content.answerable} of ${content.total}. The first pages are usually answerable within a few minutes of Create; Content shows the progress.`
    : "Generate questions and starter suggestions work once some pages are answerable.";
  const elapsed = progress ? Math.max(0, Math.round((now - progress.started) / 1000)) : 0;
  const nameField = (id: string) =>
    who?.setupMode && (
      <input
        id={id}
        aria-label="Your name (setup mode, not verified)"
        placeholder="Your name (setup mode)"
        value={typedName}
        onChange={(e) => rememberName(e.target.value)}
        maxLength={80}
        style={{ width: "auto" }}
      />
    );

  return (
    <div className="validation">
      {error && error.at === undefined && (
        <p className="notice" data-tone="critical" role="alert">
          {error.text}
        </p>
      )}

      {validation && !editing && (
        <div tabIndex={-1} ref={resultBlock}>
          <Results
            validation={validation}
            now={content}
            chosen={widget ? chosenStarters(widget.settings) : undefined}
            onRunNow={canRun ? runNow : undefined}
            running={doing === "now"}
            busy={busy}
          />
        </div>
      )}
      {validation && !editing && (
        <ol className="test-questions">
          {validation.questions.map((q, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: a run can ask the same question twice; its position is what's acknowledged
            <li key={`${i}:${q.question}`} data-answered={q.answered}>
              <p className="label">
                {q.question} {q.own && <span className="muted">(your question)</span>}
                {q.starter && <span className="muted"> (starter question)</span>}
                {q.intent && (
                  <span className="muted">
                    {" "}
                    (asked of every site: {INTENT_LABEL[q.intent]}
                    {q.wording === "generic" ? ", in a visitor's own words" : q.wording === "named" ? ", by name" : ""})
                  </span>
                )}
              </p>
              <p className="answer">
                <Badge
                  tone={
                    q.failure
                      ? "critical"
                      : openHold(q)
                        ? "warning"
                        : q.answered
                          ? q.checks?.length && !q.acknowledged
                            ? "warning"
                            : "good"
                          : q.notCovered
                            ? "neutral"
                            : "warning"
                  }
                >
                  {q.failure
                    ? "Failed"
                    : openHold(q)
                      ? "Check this"
                      : q.answered
                        ? q.checks?.length && !q.acknowledged
                          ? "Check this"
                          : "Answered"
                        : q.notCovered
                          ? "Not on the site"
                          : "No answer"}
                </Badge>{" "}
                {isFallbackQuestion(q.question) && <Badge tone="warning">Not counted</Badge>}{" "}
                {q.tableMatched && !q.holds?.length && <Badge tone="good">Matches the price table</Badge>}{" "}
                {!q.answer && <span className="muted">Visitors get the no-answer reply and the handoff.</span>}
              </p>
              {q.answer && <ModelText text={q.answer} {...(links && { links })} className="answer model-text" note />}
              {q.visitorGets && (
                <div className="notice" data-tone="warning">
                  <strong>Visitors don't read that. They get:</strong>{" "}
                  <ModelText text={q.visitorGets.answer} {...(links && { links })} className="answer model-text" note />
                </div>
              )}
              {q.declined && (
                <p className="help">
                  {q.verdict === "deflection"
                    ? "It only points elsewhere (a page, a form, “contact us”), with nothing from the site about what was asked."
                    : q.verdict === "substituted"
                      ? "It answers something else than what was asked, and gives no step for the thing asked."
                      : "It may not answer: the reply says something is missing or over and gives nothing of what was asked."}{" "}
                  Visitors read it as written, with the handoff under it.
                </p>
              )}
              {(q.holds?.length || q.keyFacts?.length) && (
                <HoldView
                  q={q}
                  {...(links && { links })}
                  busy={busy}
                  doing={doing === `keep:${i}`}
                  nameField={nameField(`keep-name-${i}`)}
                  onKeep={(reason) =>
                    decide("keep", i, () => acknowledgeAnswer(tenantId, deploymentId, i, q.question, typedName, undefined, reason))
                  }
                />
              )}
              {isFallbackQuestion(q.question) && (
                <p className="notice" data-tone="warning">
                  {FALLBACK_NOTE}
                </p>
              )}
              {q.failure && <FailureAdvice q={q} promptCurrent={validation.promptCurrent} />}
              {q.sources.length > 0 && (
                <ul className="plain sources-list">
                  {q.sources.map((s) => (
                    <li key={s.url}>
                      <a href={s.url} target="_blank" rel="noreferrer">
                        {s.title}
                      </a>
                    </li>
                  ))}
                </ul>
              )}
              {/* Not on a price table contradiction: only asking again, rewording or a named reason clears it. */}
              {(q.flags?.length || q.languageCheck || (q.checks?.length && !q.notCovered)) && !q.holds?.some((h) => h.by === "price") && (
                <CheckView
                  q={q}
                  index={i}
                  busy={busy}
                  doing={doing === `ack:${i}`}
                  focusResult={decided?.kind === "ack" && decided.index === i}
                  nameField={nameField(`ack-name-${i}`)}
                  onCheck={(foundAt) =>
                    decide("ack", i, () => acknowledgeAnswer(tenantId, deploymentId, i, q.question, typedName, foundAt))
                  }
                />
              )}
              {/* Under a No answer, and under a Check this answer nobody has checked ("Contact Support."). */}
              {((!q.answered && !isRefusalFailure(q.failure)) || (q.answered && q.checks?.length && !q.acknowledged) || openHold(q)) &&
                !isFallbackQuestion(q.question) && (
                  <NoAnswerFix
                    q={q}
                    index={i}
                    focusResult={decided !== undefined && decided.kind !== "ack" && decided.index === i}
                    busy={busy}
                    doing={doing}
                    nameField={nameField(`fix-name-${i}`)}
                    keepAsk={keepAsk?.index === i ? keepAsk.asks : undefined}
                    onAdd={(urls, keep) => decide("pages", i, () => addPages(tenantId, deploymentId, i, q.question, urls, typedName, keep))}
                    onCancelKeep={() => setKeepAsk(undefined)}
                    setupMode={Boolean(who?.setupMode)}
                    onNotCovered={(reason) =>
                      decide("cover", i, () => siteDoesntCover(tenantId, deploymentId, i, q.question, reason, typedName))
                    }
                  />
                )}
              {error?.at === i && (
                <p className="notice" data-tone="critical" role="alert" id={`answer-error-${i}`} tabIndex={-1}>
                  {error.text}
                </p>
              )}
            </li>
          ))}
        </ol>
      )}
      {validation && !editing && <Removals validation={validation} />}

      {!validation && !editing && (
        <p className="muted">
          {canRun
            ? "Asks the questions every site gets (price, contact, support, and buying and trials where the site has pages for them), generates a few more from the site's pages, adds two of your own and the widget's starter questions, and asks the chatbot each one as a visitor would."
            : notYet}
        </p>
      )}

      {editing && (
        <div className="question-editor">
          <h3 className="h4" tabIndex={-1} ref={editorHeading}>
            Questions to ask
          </h3>
          {restored && (
            <p className="notice" role="status">
              Your list from before the page reloaded, not run yet.
            </p>
          )}
          {note && (
            <p className="notice" data-tone="warning" role="status">
              {note}
            </p>
          )}
          {generated.length === 0 && !note && (
            <p className="muted">
              Generate the questions every site gets (price, contact, support, buying, trials) and up to {GENERATED_QUESTIONS} more about
              what visitors come to do, then add at least {OWN_QUESTIONS} of your own, such as what the client is asked most.
            </p>
          )}
          <ol className="test-questions">
            {draft.map((q, i) => {
              const fallback = isFallbackQuestion(q.question);
              return (
                // biome-ignore lint/suspicious/noArrayIndexKey: rows are edited in place; the index is their identity
                <li key={i}>
                  <div className="inline-field">
                    <label className="sr-only" htmlFor={`question-${i}`}>
                      {q.own ? "Your question" : q.intent ? "Question every site gets" : "Generated question"} {i + 1}
                    </label>
                    <input
                      id={`question-${i}`}
                      ref={(el) => {
                        inputs.current[i] = el;
                      }}
                      value={q.question}
                      onChange={(e) => update(i, e.target.value)}
                      maxLength={300}
                      disabled={busy}
                      aria-describedby={`question-${i}-help`}
                      placeholder={q.own ? "Type a question the client's visitors ask" : undefined}
                    />
                    <button type="button" className="link-button" onClick={() => remove(i)} disabled={busy}>
                      Remove
                      <span className="sr-only">
                        {" "}
                        {q.question.trim() ? `“${q.question.trim()}”` : `${q.own ? "your question" : "question"} ${i + 1}`}
                      </span>
                    </button>
                  </div>
                  <p className="help" id={`question-${i}-help`}>
                    {fallback
                      ? FALLBACK_NOTE
                      : q.own
                        ? "Your question"
                        : q.intent
                          ? `Asked of every site (${INTENT_LABEL[q.intent]}), worded from its key pages: a No answer needs a decision`
                          : "Generated from the site"}
                  </p>
                </li>
              );
            })}
          </ol>
          {startersToo.length > 0 && (
            <p className="help">
              Also asked, as in every run: the widget's starter question{startersToo.length === 1 ? "" : "s"}{" "}
              {startersToo.map((q) => `“${q}”`).join(", ")}. Change them in Starter questions below.
            </p>
          )}
          {dropped.length > 0 && (
            <fieldset className="notice" data-tone="warning">
              <legend className="label">Why are these no longer asked?</legend>
              <p className="help">
                The last run had a problem with {dropped.length === 1 ? "this question" : "these questions"}. Review shows each removal with
                your name and reason to the person who signs off.
              </p>
              {dropped.map((r, n) => (
                <div className="field" key={r.question}>
                  <label htmlFor={`removed-${n}`}>
                    “{r.question}” ({r.was.toLowerCase()})
                  </label>
                  <input
                    id={`removed-${n}`}
                    value={reasons[r.question] ?? ""}
                    onChange={(e) => setReasons((all) => ({ ...all, [r.question]: e.target.value }))}
                    maxLength={300}
                    placeholder="For example: the client confirmed visitors don't ask this"
                    disabled={busy}
                  />
                </div>
              ))}
              {who?.setupMode && (
                <div className="field">
                  <label htmlFor="removed-name">Your name</label>
                  <input
                    id="removed-name"
                    value={typedName}
                    onChange={(e) => rememberName(e.target.value)}
                    maxLength={80}
                    autoComplete="name"
                  />
                </div>
              )}
            </fieldset>
          )}
          <p className="label">Add one of your own</p>
          <div className="actions">
            {QUESTION_STUBS.map((s) => (
              <button key={s.label} type="button" className="button secondary" onClick={() => addOwn(s.text)} disabled={busy}>
                {s.label}
              </button>
            ))}
            <button type="button" className="button secondary" onClick={() => addOwn()} disabled={busy}>
              Blank question
            </button>
          </div>
          <p className="help">The chips insert a question to finish: replace the … with the client's product, place or service.</p>
          <div className="actions">
            <button type="button" className="button" disabled={!canRun || busy || !!problem} onClick={run}>
              {doing === "run"
                ? "Asking…"
                : (problem ?? `Run validation (${filled.length + startersToo.length} questions, ${aboutSeconds(estimate)})`)}
            </button>
            <button type="button" className="button secondary" disabled={!canRun || busy} onClick={generate}>
              {doing === "generate" ? "Generating…" : generated.length ? "New generated questions" : "Generate questions"}
            </button>
            {validation && (
              <button
                type="button"
                className="link-button"
                onClick={() => {
                  setEditing(false);
                  setRestored(false);
                  setReasons({});
                  setDraft(savedList());
                  setNote(validation?.generationNote);
                  writeStored(draftKey(deploymentId), undefined);
                }}
                disabled={busy}
              >
                Cancel
              </button>
            )}
          </div>
          {progress && (
            <div role="status">
              <progress max={progress.total} value={progress.done} aria-label="Questions answered" /> {progress.done} of {progress.total}{" "}
              answered · {elapsed} s
              {elapsed <= progress.estimate
                ? `, ${aboutSeconds(progress.estimate - elapsed)} left`
                : ": taking longer than usual, as Agentic RAG is slow to answer right now. The run keeps going; each question stops after a minute."}
            </div>
          )}
          <p className="help">
            The questions every site gets, up to {MAX_OWN_AND_GENERATED} more (generated and your own) and the starters, asked three at a
            time. Passing needs {Math.round(PASS_SHARE * 100)}% answered, an answer to every starter, a decision on every No answer to a
            question every site gets or one of yours, answers in the language they were asked in, nothing that talks about how it works, and
            every flagged price, date, very short or off-source answer checked.
          </p>
        </div>
      )}

      {!canRun && (validation || editing) && (
        <p className="help" role="status">
          {notYet}
        </p>
      )}
      {validation && !editing && (
        <div className="actions">
          <button
            type="button"
            className="button"
            disabled={!canRun || busy}
            onClick={() => {
              setDraft(savedList());
              setNote(validation?.generationNote);
              setEditing(true);
            }}
          >
            Edit the questions and run again
          </button>
          <button type="button" className="button secondary" disabled={!canRun || busy} onClick={generate}>
            {doing === "generate" ? "Generating…" : "New generated questions"}
          </button>
        </div>
      )}
      {!validation && !editing && (
        <div className="actions">
          <button type="button" className="button" disabled={!canRun || busy} onClick={generate}>
            {doing === "generate" ? "Generating…" : "Generate questions"}
          </button>
        </div>
      )}

      {preflight && (
        <div>
          <h3 className="h4">Domain lock</h3>
          <ul className="plain">
            {preflight.origins.map((o) => (
              <li key={o.origin}>
                <Badge tone={o.ok ? "good" : "critical"}>{o.ok ? "Allowed" : "Not yet"}</Badge> <code>{o.origin}</code>
                {!o.ok && <span className="help"> The lock can take a minute to apply after a change. Run validation again.</span>}
              </li>
            ))}
          </ul>
        </div>
      )}

      {who && (
        <StarterPicker
          tenantId={tenantId}
          deploymentId={deploymentId}
          setupMode={who.setupMode}
          current={who.starters}
          status={who.starterStatus}
          typedName={typedName}
          onTypedName={rememberName}
          widget={widget}
          waitingFor={canRun ? undefined : notYet}
          {...(links && { links })}
        />
      )}

      <p className="help" aria-live="polite" tabIndex={-1} ref={statusLine}>
        {doing === "run" || doing === "now"
          ? "Asking the chatbot each question, as a visitor would. These are partner tests: they don't count toward usage."
          : doing === "generate"
            ? "Reading the site's pages for questions visitors ask. A partner test: it doesn't count toward usage."
            : ""}
      </p>
    </div>
  );
}

// What to do about a failed answer: only what would change the result.
function FailureAdvice({ q, promptCurrent }: { q: RunQuestion; promptCurrent?: boolean }) {
  const failure = q.failure ?? "";
  const language = failure.match(/Answered in (\w+)/)?.[1];
  return (
    <p className="notice" data-tone="critical">
      {plainFailure(failure).replace(/\.$/, "")}.
      {failure.includes(LEAK_FAILURE) &&
        " Visitors shouldn't read about context, documents or “the page”: adjust the prompt (Edit › How it answers) and run again."}
      {failure.includes(STARTER_FAILURE) &&
        " Visitors click starter questions first: remove it in Starter questions below, or add the pages that answer it."}
      {language &&
        (promptCurrent === false
          ? " Visitors get answers in the language they ask in. The saved prompt predates the console's current answering rules: save it on Edit › How it answers, then run again."
          : promptCurrent === true
            ? ` The saved prompt already has the current answering rules, so saving it again won't change this. Check the sources: if they're ${language} pages, leave those out on Content, then run again.`
            : ` Visitors get answers in the language they ask in. Check the sources: if they're ${language} pages, leave those out on Content, then run again.`)}
    </p>
  );
}

// A held answer (round 5): why it's held (a claim that something is missing or over, the judge's
// one-line reason, the key pages' facts it contradicts, or an answer visitors won't see), with the
// key pages' lines, and "Keep this answer" with a reason and a name. For a No answer, what the key
// pages state that the answer didn't use. Asking again and getting an answer, or rewording,
// clears it too; "The site doesn't cover this" sits under it (NoAnswerFix).
function HoldView(props: {
  q: RunQuestion;
  busy: boolean;
  doing: boolean;
  nameField: ReactNode;
  onKeep: (reason: string) => void;
  links?: LinkContext;
}) {
  const { q, busy, doing } = props;
  const [reason, setReason] = useState("");
  const open = openHold(q);
  // Keep this answer gives way to the line saying who kept it, which takes focus (round 6).
  const kept = useRef<HTMLParagraphElement>(null);
  const keptBy = q.holds?.length ? q.acknowledged?.reason : undefined;
  const wasOpen = useRef(open);
  useEffect(() => {
    if (keptBy && wasOpen.current) kept.current?.focus();
    wasOpen.current = open;
  }, [keptBy, open]);
  const pages = [...(q.holds ?? []).flatMap((h) => h.pages ?? []), ...(q.keyFacts ?? [])];
  const unique = pages.filter((p, i) => pages.findIndex((x) => x.url === p.url) === i).slice(0, 3);
  return (
    <div className="notice" data-tone={open ? "warning" : "neutral"}>
      {q.holds?.length ? (
        <ul className="plain">
          {q.holds.map((h) => (
            <li key={`${h.by}:${h.text}`}>Check this: {plainQuote(h.text)}</li>
          ))}
        </ul>
      ) : (
        <p>The answer didn't use the site's key pages, which state:</p>
      )}
      {q.hiddenAnswer && (
        <div>
          <p className="muted">The answer visitors won't see:</p>
          <ModelText text={q.hiddenAnswer} {...(props.links && { links: props.links })} />
        </div>
      )}
      {unique.map((p) => (
        <div key={p.url}>
          <p className="label">
            <a href={p.url} target="_blank" rel="noreferrer">
              {p.title || p.url}
            </a>
          </p>
          <ul className="plain">
            {p.lines.slice(0, 4).map((line) => (
              <li key={line} className="muted">
                {line}
              </li>
            ))}
          </ul>
        </div>
      ))}
      {q.holds?.length && q.acknowledged?.reason && (
        <p className="muted" tabIndex={-1} ref={kept}>
          Kept by {q.acknowledged.name}: {quotedReason(q.acknowledged.reason)}
        </p>
      )}
      {open && (
        <form
          className="inline-form"
          onSubmit={(e) => {
            e.preventDefault();
            props.onKeep(reason);
          }}
        >
          <label>
            Why this answer is right
            <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} />
          </label>
          {props.nameField}
          <button type="submit" className="button secondary" disabled={busy || reason.trim().length < 3}>
            {doing ? "Saving…" : "Keep this answer"}
          </button>
        </form>
      )}
    </div>
  );
}

// "Check this against the site": each figure beside the sentence or table row that states it on
// a synced page, highlighted, with that page to open; a figure no synced page states asks where
// the person found it.
function CheckView(props: {
  q: RunQuestion;
  index: number;
  busy: boolean;
  doing: boolean;
  nameField: ReactNode;
  onCheck: (foundAt?: string) => void;
  // Just checked: the result takes focus (the button is gone).
  focusResult?: boolean;
}) {
  const { q, index, busy, doing } = props;
  const [foundAt, setFoundAt] = useState("");
  const result = useRef<HTMLParagraphElement>(null);
  const checked = Boolean(q.acknowledged);
  useEffect(() => {
    if (props.focusResult && checked) result.current?.focus();
  }, [props.focusResult, checked]);
  const figures = q.figures ?? [];
  const unstated = figures.filter((f) => !f.page);
  const why = [
    ...(q.flags ?? []).map((f) => FLAG_TEXT[f] ?? f),
    ...(q.checks ?? []).map((c) => CHECK_TEXT[c]),
    ...(q.languageCheck ? [q.languageCheck.replace(/^It/, "it")] : []),
  ];
  // A very short or off-source answer is checked against the question; figures against the site.
  const answersIt = !q.flags?.length && !q.languageCheck;
  return (
    <div className="notice" data-tone={q.acknowledged ? undefined : "warning"}>
      <p>
        <strong>Check this against the site:</strong> {why.join(", and ")}.{!figures.some((f) => f.page) && <CheckLink q={q} />}
      </p>
      {figures.length > 0 && (
        <ul className="plain">
          {figures.map((f) => (
            <li key={f.figure}>
              <Figure f={f} />
            </li>
          ))}
        </ul>
      )}
      {q.acknowledged ? (
        <p tabIndex={-1} ref={result}>
          <Badge tone="good">Checked</Badge> by {q.acknowledged.name}, {utc(q.acknowledged.at)}
          {!q.acknowledged.verified && !/not verified/.test(q.acknowledged.name) && " (setup mode, not verified)"}
          {q.acknowledged.foundAt && (
            <>
              {" "}
              · found on{" "}
              <a href={q.acknowledged.foundAt} target="_blank" rel="noreferrer">
                {q.acknowledged.foundAt}
              </a>
            </>
          )}
        </p>
      ) : (
        <div className="inline-field">
          {props.nameField}
          {unstated.length > 0 && (
            <>
              <label className="sr-only" htmlFor={`found-at-${index}`}>
                Where you found {figureList(unstated)}
              </label>
              <input
                id={`found-at-${index}`}
                type="url"
                value={foundAt}
                onChange={(e) => setFoundAt(e.target.value)}
                placeholder={`Address of the page that states ${figureList(unstated)}`}
                style={{ width: "auto", flex: "1 1 18rem" }}
              />
            </>
          )}
          <button
            type="button"
            className="button secondary"
            disabled={busy || (unstated.length > 0 && !/^https?:\/\/\S+\.\S+/.test(foundAt.trim()))}
            onClick={() => props.onCheck(unstated.length ? foundAt.trim() : undefined)}
          >
            {doing ? "Saving…" : answersIt ? "I checked it: it answers the question" : "I checked it: it matches the site"}
          </button>
        </div>
      )}
    </div>
  );
}

// One figure: "$ 1,149" highlighted in "DevCraft UI › … $ 1,149", on the page that states it.
function Figure({ f }: { f: FigureCheck }) {
  if (!f.page) {
    return (
      <>
        No page we synced states <strong>{f.figure}</strong>. Find where it's stated, and give that page's address below.
      </>
    );
  }
  const text = f.excerpt ?? "";
  const [from, to] = f.mark ?? [-1, -1];
  return (
    <>
      <strong>{f.figure}</strong> on{" "}
      <a href={f.page.url} target="_blank" rel="noreferrer">
        {f.page.title}
      </a>
      {f.more ? <span className="muted"> (and {f.more} more synced pages)</span> : null}:{" "}
      <q>
        {f.label && <strong>{f.label}: </strong>}
        {from >= 0 ? (
          <>
            {text.slice(0, from)}
            <mark>{text.slice(from, to)}</mark>
            {text.slice(to)}
          </>
        ) : (
          text
        )}
      </q>{" "}
      <a href={f.page.url} target="_blank" rel="noreferrer">
        Open
      </a>
    </>
  );
}

// Where to compare a flag without figures: the page that shows it, or a warning that none does.
function CheckLink({ q }: { q: RunQuestion }) {
  const target = q.check ?? (q.sources[0] && { ...q.sources[0], found: true });
  if (!target) return null;
  const link = (
    <a href={target.url} target="_blank" rel="noreferrer">
      {target.title}
    </a>
  );
  return target.found ? (
    <> Open {link} to compare.</>
  ) : (
    <> None of the pages the chatbot read shows this figure, so check it carefully: start with {link}.</>
  );
}

// Under a No answer: the site's pages that may answer it, added in one click and asked again once
// they're answerable, or "The site doesn't cover this" with a reason. What was decided shows
// instead.
function NoAnswerFix(props: {
  q: RunQuestion;
  index: number;
  busy: boolean;
  doing: Doing | undefined;
  nameField: ReactNode;
  onAdd: (urls: string[], keep?: string) => void;
  onNotCovered: (reason: string) => void;
  focusResult?: boolean;
  // Ticked pages a date or stale-price rule leaves out: added once the person keeps them anyway.
  keepAsk?: KeepAsk[];
  onCancelKeep: () => void;
  setupMode?: boolean;
}) {
  const { q, index, busy } = props;
  const result = useRef<HTMLParagraphElement>(null);
  const keepField = useRef<HTMLInputElement>(null);
  const [keepReason, setKeepReason] = useState("");
  const asking = props.keepAsk?.length ? props.keepAsk : undefined;
  useEffect(() => {
    if (asking) keepField.current?.focus();
  }, [asking]);
  // While pages are being added, focus sits on the status saying so.
  const adding = useRef<HTMLParagraphElement>(null);
  const isAdding = props.doing === `pages:${index}`;
  useEffect(() => {
    if (isAdding) adding.current?.focus();
  }, [isAdding]);
  const { id: tenantId, deploymentId } = useParams<{ id: string; deploymentId: string }>();
  const [pages, setPages] = useState<Awaited<ReturnType<typeof answeringPages>>>();
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [covering, setCovering] = useState(false);
  const [reason, setReason] = useState("");
  const decided = q.notCovered || (q.added && !q.added.askedAgain);
  useEffect(() => {
    if (props.focusResult && decided) result.current?.focus();
  }, [props.focusResult, decided]);

  useEffect(() => {
    if (decided) return;
    let live = true;
    answeringPages(tenantId, deploymentId, q.question)
      .then((result) => {
        if (!live) return;
        setPages(result);
        // Nothing ticked: a match on the question's words isn't a page that answers it, and an added
        // page is synced whatever the budget and the plan's rules.
        setTicked(new Set());
      })
      .catch((err: unknown) => live && setPages({ error: err instanceof Error ? err.message : String(err) }));
    return () => {
      live = false;
    };
  }, [tenantId, deploymentId, q.question, decided]);

  if (q.notCovered) {
    return (
      <p className="help" tabIndex={-1} ref={result}>
        <Badge tone="neutral">The site doesn't cover this</Badge> by {q.notCovered.name}, {utc(q.notCovered.at)}:{" "}
        {quotedReason(q.notCovered.reason)}
        It passes with the no-answer reply and the handoff, and Review shows it.
      </p>
    );
  }
  if (q.added && !q.added.askedAgain) {
    return (
      <p className="notice" role="status" tabIndex={-1} ref={result}>
        {q.added.urls.length === 1 ? "1 page" : `${q.added.urls.length} pages`} added by {q.added.name}, {utc(q.added.at)}. It's asked again
        by itself once {q.added.urls.length === 1 ? "it's" : "they're"} answerable: within a few minutes, longer while the first sync runs.
      </p>
    );
  }
  const list = pages && "pages" in pages ? pages.pages : [];
  return (
    <div className="notice" data-tone="neutral">
      {q.added?.askedAgain && (
        <p className="help">
          Asked again {utc(q.added.askedAgain)} with the {q.added.urls.length === 1 ? "page" : "pages"} {q.added.name} added: still no
          answer.
        </p>
      )}
      <p className="label">Pages on the site that may answer this</p>
      {pages && "note" in pages && pages.note && <p className="help">{pages.note}</p>}
      {list.length > 0 && <p className="help">Tick the ones that answer it: they're synced whatever the page budget.</p>}
      {!pages ? (
        <p className="help">Looking through the site's pages…</p>
      ) : "error" in pages ? (
        <p className="help">{pages.error}</p>
      ) : !list.length ? (
        <>
          <p className="help">No page's address or title matches its words. Try the client's own word for it:</p>
          <FindPage
            tenantId={tenantId}
            deploymentId={deploymentId}
            initial={questionWords(q.question).join(" ")}
            setupMode={Boolean(props.setupMode)}
          />
        </>
      ) : (
        <ul className="plain">
          {list.map((p) => (
            <li key={p.url} className="choice">
              <input
                type="checkbox"
                id={`page-${index}-${p.url}`}
                checked={ticked.has(p.url)}
                disabled={p.inSync || busy}
                onChange={(e) =>
                  setTicked((all) => {
                    const next = new Set(all);
                    if (e.target.checked) next.add(p.url);
                    else next.delete(p.url);
                    return next;
                  })
                }
                style={{ width: "auto" }}
              />
              <label htmlFor={`page-${index}-${p.url}`}>
                {/* With no title, the address shows once, as the link. */}
                {p.title && <>{p.title} </>}
                <a href={p.url} target="_blank" rel="noreferrer" className={p.title ? "muted" : undefined}>
                  {new URL(p.url).pathname}
                </a>
                <span className="help">
                  {" "}
                  {p.inSync ? "Already synced." : p.leftOutBecause ? `Left out: ${p.leftOutBecause}` : "Not taken within the page budget."}
                </span>
              </label>
            </li>
          ))}
        </ul>
      )}
      {/* Round 6: Find a page always, prefilled with the question's words, so a page in the client's
          own word ("pet" for "puppy") or one left out by age is a search away. */}
      {list.length > 0 && (
        <>
          <p className="help">None of these? Try the client's own word for it:</p>
          <FindPage
            tenantId={tenantId}
            deploymentId={deploymentId}
            initial={questionWords(q.question).join(" ")}
            setupMode={Boolean(props.setupMode)}
          />
        </>
      )}
      <div className="inline-field">
        {props.nameField}
        {list.length > 0 && (
          <button
            type="button"
            id={`add-pages-${index}`}
            className="button secondary"
            disabled={busy || !ticked.size || !!asking}
            onClick={() => props.onAdd([...ticked])}
          >
            {props.doing === `pages:${index}` && !asking
              ? "Adding…"
              : !ticked.size
                ? "Tick the pages that answer it"
                : ticked.size === 1
                  ? "Add this page"
                  : `Add these ${ticked.size} pages`}
          </button>
        )}
        {!covering && !q.starter && (
          <button
            type="button"
            id={`cover-open-${index}`}
            className="link-button"
            disabled={busy}
            onClick={() => {
              // The button gives way to the reason field, which takes focus.
              setCovering(true);
              focusSoon(`cover-${index}`);
            }}
          >
            The site doesn't cover this
          </button>
        )}
      </div>
      {isAdding && (
        <p className="help" role="status" tabIndex={-1} ref={adding}>
          Adding the pages to the sync…
        </p>
      )}
      {asking && (
        <fieldset className="field">
          <legend className="label">Keep it anyway?</legend>
          <ul className="plain">
            {asking.map((a) => (
              <li key={a.url}>
                {a.title ?? new URL(a.url).pathname}: {a.rule} Keep it anyway?
              </li>
            ))}
          </ul>
          <label htmlFor={`keep-${index}`}>Why keep {asking.length === 1 ? "it" : "them"}?</label>
          <p className="help" id={`keep-${index}-help`}>
            Review shows the page with your name and reason to the person who signs off. Pages you don't keep aren't added.
          </p>
          <div className="inline-field">
            <input
              id={`keep-${index}`}
              ref={keepField}
              aria-describedby={`keep-${index}-help`}
              value={keepReason}
              onChange={(e) => setKeepReason(e.target.value)}
              maxLength={300}
              placeholder="For example: the client confirmed this price still applies"
              style={{ width: "auto", flex: "1 1 18rem" }}
            />
            <button
              type="button"
              className="button secondary"
              disabled={busy || keepReason.trim().length < 3}
              onClick={() =>
                props.onAdd(
                  asking.map((a) => a.url),
                  keepReason.trim(),
                )
              }
            >
              {props.doing === `pages:${index}` ? "Keeping…" : "Keep it anyway"}
            </button>
            <button
              type="button"
              className="link-button"
              onClick={() => {
                props.onCancelKeep();
                // Back to Add, which the question had disabled.
                focusSoon(`add-pages-${index}`);
              }}
            >
              Don't keep {asking.length === 1 ? "it" : "them"}
            </button>
          </div>
        </fieldset>
      )}
      {list.length > 0 && (
        <p className="help">
          Added pages are kept whatever the page budget and synced first; the question is asked again by itself once they're in. A page that
          states an old price, or is old by its date, asks first.
        </p>
      )}
      {covering && (
        <div className="field">
          <label htmlFor={`cover-${index}`}>Why doesn't the site cover it?</label>
          <p className="help" id={`cover-${index}-help`}>
            It passes with the no-answer reply and the handoff. Review shows your reason to the person who signs off.
          </p>
          <div className="inline-field">
            <input
              id={`cover-${index}`}
              aria-describedby={`cover-${index}-help`}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={300}
              placeholder="For example: prices are quoted by sales only"
              style={{ width: "auto", flex: "1 1 18rem" }}
            />
            <button
              type="button"
              className="button secondary"
              disabled={busy || reason.trim().length < 3}
              onClick={() => props.onNotCovered(reason)}
            >
              {props.doing === `cover:${index}` ? "Saving…" : "Save"}
            </button>
            <button
              type="button"
              className="link-button"
              onClick={() => {
                setCovering(false);
                focusSoon(`cover-open-${index}`);
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// Every question removed after a problem, with who and why, as Review shows them.
function Removals({ validation }: { validation: ValidationRun }) {
  if (!validation.removed?.length) return null;
  return (
    <div>
      <p className="label">Removed after a problem</p>
      <ul className="plain">
        {validation.removed.map((r) => (
          <li key={`${r.question}:${r.at}`}>
            “{r.question}” ({r.was.toLowerCase()}), by {r.name}
            {!r.verified && " (setup mode, not verified)"}, {utc(r.at)}: {r.reason}
          </li>
        ))}
      </ul>
    </div>
  );
}

// The run in one line, and everything that stands between it and a pass, all at once.
function Results({
  validation,
  now,
  chosen,
  onRunNow,
  running,
  busy,
}: {
  validation: ValidationRun;
  now: ContentAtRun | null;
  chosen?: readonly string[];
  onRunNow?: () => void;
  running?: boolean;
  busy?: boolean;
}) {
  const c = runCounts(validation.questions);
  const halfway = thinRun(validation) ? halfwayNote(validation, now) : undefined;
  const noDecision = passedNote(validation);
  // Judged by today's rules too: a run saved before them (fallback questions counted, no own
  // questions) shows what it now lacks, whatever it recorded.
  const passed = validation.passed && validationPassed(validation.questions, chosen);
  const reasons = passReasons(validation);
  const partial = partialContentNote(validation);
  const synced = validation.content?.partial && now && !now.partial;
  const starters = validation.questions.filter((q) => q.starter);
  const checks = validation.questions.filter(needsCheck).length;
  return (
    <>
      <p>
        <Badge tone={passed ? "good" : "critical"}>{passed ? "Passed" : "Not yet"}</Badge> {c.answered - c.notCovered} of {c.counted}{" "}
        questions answered
        {c.notCovered > 0 && ` and ${c.notCovered} the site doesn't cover`} ({c.needed} needed), {c.own} of them yours
        {starters.length > 0 && `, ${starters.filter((q) => q.answered && !q.failure).length} of ${starters.length} starters`}
        {c.fallback > 0 && `, ${c.fallback} not counted`} ·{" "}
        {/* The result's own time: a re-ask's answers aren't the first run's (round 7). */}
        <span className="muted">
          {validation.rechecked && validation.rechecked > validation.at
            ? `asked again ${utc(validation.rechecked)}, first run ${utc(validation.at)}`
            : utc(validation.at)}
        </span>
        {validation.auto === "sync-finished" && <span className="muted"> · ran again by itself when the first sync finished</span>}
        {validation.auto === "half-answerable" && <span className="muted"> · ran again by itself once half the pages were answerable</span>}
        {validation.auto === "pages-added" && <span className="muted"> · asked again by itself with the pages added</span>}
      </p>
      {passed && noDecision && (
        <p className="notice" data-tone="warning">
          {noDecision}: {c.noDecision.map((q) => `“${q.question}”`).join(", ")}. Review lists {c.noDecision.length === 1 ? "it" : "them"}.
          Add the pages that answer {c.noDecision.length === 1 ? "it" : "them"}, or say the site doesn't cover{" "}
          {c.noDecision.length === 1 ? "it" : "them"}.
        </p>
      )}
      {halfway && (
        <div className="notice" data-tone="warning">
          <p>{halfway}</p>
          {onRunNow && (
            <button type="button" className="button secondary" onClick={onRunNow} disabled={busy}>
              {running ? "Running…" : "Run it now"}
            </button>
          )}
        </div>
      )}
      {!passed && reasons.length > 0 && (
        <p className="help">
          To pass: {reasons.join(", ")}.{c.failed.length > 0 && checks > 0 && " Fix the failures and check the flagged answers together."}
        </p>
      )}
      {partial && !halfway && (
        <p className="notice" data-tone="warning">
          {partial}
          {synced
            ? rerunsItself(validation)
              ? ` The sync has finished (${now.answerable} of ${now.total} pages answerable): it runs again within a few minutes.`
              : ` Now ${now.answerable} of ${now.total} pages are answerable.`
            : now?.partial
              ? ` Now ${now.answerable} of ${now.total}.`
              : ""}
        </p>
      )}
      {validation.generationNote && <p className="help">{validation.generationNote}</p>}
    </>
  );
}
