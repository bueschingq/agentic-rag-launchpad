"use client";

// The starter-question picker: the buttons a visitor sees when the chat opens, chosen by a
// person. It offers questions that passed validation first, then questions generated from the
// site for this purpose (the same ones each time it opens, until someone asks for new ones),
// never "What can you tell me about …" ones, each with a checkbox and editable text, a
// 60-character guide and a preview at desktop and phone width. Each is asked as visitors will ask
// it when the picker opens (a few at a time, about 3 s), and edited wording when it's ticked: its
// answer and sources show before it can be ticked, and one with no answer can't be. In setup
// mode the person's name sits, labelled, beside Use these, with any error right under it.
// Nothing reaches the widget until "Use these", which also asks the new starters into the latest
// validation run, so a flagged answer holds sign-off until someone checks it.
//
// Round 4: a suggestion with any kind of No answer (a reply that says the site lacks it included)
// can't be ticked, and shows the site's pages that may answer it, ready to add (with the Keep it
// anyway step for a page a date or stale-price rule leaves out). A Check this suggestion (very
// short, or sources not about the question) needs I checked it before it can be ticked, and that
// check carries into validation.
//
// Round 6 (item 4): every row is judged by validation's own rules (starterNeed in
// validation-rules.ts), never a copy. A price row the confirmed price table agrees with needs no
// click; a row flagged for a price outside the table or a date shows the figure lines and I checked
// it, which carries into validation; a held reply a named person keeps counts as answered. When Use
// these refuses, the error names the row and focus moves to its decision control; ticks survive a
// failed save and a reload.
//
// Build 8: 19 rows of answers made it 18,331 px tall. Chosen and suggested rows come first; questions
// that only passed validation fold under one button, and each row's answer under its own, opened only
// when the row needs a decision.

import type { LinkContext, PublicWidgetConfig } from "@launchpad/theme";
import { Fragment, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { focusSoon, useFocusOnChange } from "@/components/focus.tsx";
import { ModelText } from "@/components/model-text.tsx";
import { Badge } from "@/components/ui.tsx";
import type { KeepAsk, PageCandidate } from "@/lib/validation.ts";
import {
  CHECK_TEXT,
  MAX_STARTER_LENGTH,
  MAX_STARTERS,
  openHold,
  plainQuote,
  type RunQuestion,
  STARTER_GUIDE,
  type StarterPick,
  starterNeed,
} from "@/lib/validation-rules.ts";
import {
  addPagesForStarter,
  answeringPages,
  askStarterQuestions,
  chooseStarters,
  type StarterChoice,
  starterChoices,
} from "./validation-actions.ts";
import { WidgetStill } from "./widget/still.tsx";

interface Props {
  tenantId: string;
  deploymentId: string;
  setupMode: boolean;
  current: string[];
  status: "confirmed" | "check" | "none";
  // The name typed in setup mode, shared with the panel's other confirmations.
  typedName: string;
  onTypedName: (name: string) => void;
  // The saved widget: the preview is the widget's own drawing of these starters.
  widget?: PublicWidgetConfig;
  // Before any page is answerable: why the picker can't suggest or ask yet, and when it can.
  waitingFor?: string;
  // The links an answer may keep, as the chat's: answers render as the chat renders them.
  links?: LinkContext;
}

interface Row {
  text: string;
  checked: boolean;
  from: StarterChoice["from"] | "own";
  // Its answer, and the wording that was asked: editing the text asks again.
  answer?: RunQuestion;
  asked?: string;
  asking?: boolean;
  askError?: string;
  // "I checked it" on a Check this answer, for this wording.
  checkedIt?: boolean;
  // A held answer kept by a person: why it's right (round 5).
  keptReason?: string;
  // Where the person found a figure no synced page states (round 6).
  foundAt?: string;
}

const FROM: Record<Row["from"], string> = {
  current: "On the widget now",
  suggested: "Suggested from the site",
  validation: "Passed validation",
  own: "Your question",
};

const FLAG_TEXT: Record<string, string> = {
  price: "states a price",
  date: "states a date",
  "overview-sources": "rests on overview pages",
  "stale-source": "cites an out-of-date page",
};

// The widget's desktop panel leaves about 350px for the chips; a 360px phone about 320px.
const WIDTHS = [
  { label: "Desktop", px: 350 },
  { label: "Phone", px: 320 },
];

const day = (at: string) => new Date(at).toISOString().slice(0, 10);
// A held answer (round 5): the judge, the key pages' facts, the price table, or a reply that may not
// answer.
const held = (a: RunQuestion | undefined) => Boolean(a && openHold({ ...a, acknowledged: undefined }));
// The row's decisions, as validation's rules read them.
const pickOf = (r: Row): StarterPick => ({
  checked: Boolean(r.checkedIt),
  ...(r.keptReason && { reason: r.keptReason }),
  ...(r.foundAt && { foundAt: r.foundAt }),
});
// What the row still needs (validation's starterNeed), with its decisions so far.
const needOf = (r: Row) => (r.answer ? starterNeed(r.answer, pickOf(r)) : undefined);
// Usable as a starter: asked with this wording, and nothing left that validation would ask of it.
const usable = (r: Row) => Boolean(r.answer && r.asked === r.text.trim() && needOf(r)?.need === "ok");
// A reply visitors would read: answered, or held and keepable by a named person.
const readable = (a: RunQuestion) => !a.failure && starterNeed(a).need !== "no-answer";
// The question as the server keys it.
const asSent = (text: string) => text.trim().replace(/\s+/g, " ");
// The picker's rows, kept between openings (round 5: it asked every suggestion again on each
// opening and lost ticks): in this tab, per deployment.
const stashKey = (deploymentId: string) => `launchpad:starter-picker:${deploymentId}`;
const readStash = (deploymentId: string): Row[] | undefined => {
  try {
    const raw = sessionStorage.getItem(stashKey(deploymentId));
    return raw ? (JSON.parse(raw) as Row[]).map((r) => ({ ...r, asking: false })) : undefined;
  } catch {
    return undefined;
  }
};
const writeStash = (deploymentId: string, rows: Row[] | null) => {
  try {
    if (rows) sessionStorage.setItem(stashKey(deploymentId), JSON.stringify(rows));
    else sessionStorage.removeItem(stashKey(deploymentId));
  } catch {
    // Storage blocked: the rows are asked again next time.
  }
};
const askedNow = (r: Row) => Boolean(r.answer && r.asked === r.text.trim());
// On the widget now: such a row stays in view (a decision a save asks for lands on it).
const needsChosen = (r: Row) => r.from === "current";

export function StarterPicker({
  tenantId,
  deploymentId,
  setupMode,
  current,
  status,
  typedName,
  onTypedName,
  widget,
  waitingFor,
  links,
}: Props) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [primary, setPrimary] = useState<string>();
  const [suggestedAt, setSuggestedAt] = useState<string>();
  const [leftOut, setLeftOut] = useState<string[]>([]);
  const [loadError, setLoadError] = useState<string>();
  const [saveError, setSaveError] = useState<string>();
  const [saved, setSaved] = useState<{ starters: string[]; asked: number } | null>(null);
  const [pending, start] = useTransition();
  const [suggesting, setSuggesting] = useState<"open" | "fresh">();
  const [nameMissing, setNameMissing] = useState(false);
  const [showMore, setShowMore] = useState(false);
  // Choose starter questions puts focus on the picker; Use these, on what was saved.
  const pickerStart = useFocusOnChange<HTMLParagraphElement>(rows !== null);
  const savedNotice = useFocusOnChange<HTMLParagraphElement>(saved);
  const nameInput = useRef<HTMLInputElement>(null);
  // While the first suggestions load (3–10 s), focus sits on the status saying so, not on <body>.
  const loading = useRef<HTMLParagraphElement>(null);
  const saveErrorNotice = useRef<HTMLParagraphElement>(null);
  // Use these was disabled while it saved: an error takes focus (the name field, when it's that).
  // Round 6: a refusal that names rows moves focus to the first one's control instead (use()); the
  // notice is announced as an alert either way.
  useEffect(() => {
    if (saveError && !nameMissing && !document.activeElement?.id.startsWith("starter-")) saveErrorNotice.current?.focus();
  }, [saveError, nameMissing]);

  const setRow = (text: string, change: (r: Row) => Row) => setRows((all) => (all ?? []).map((r) => (r.text === text ? change(r) : r)));

  // Asks each wording as a visitor would, several at once on the server (round 6: one server action
  // per row ran one after another, 40–80 s for 19 rows); `tick` ticks it once it's answered. In
  // batches of 6, so answers fill in as each batch is judged.
  const ask = async (texts: string[], tick = false) => {
    const queue = [...new Set(texts.map((t) => t.trim()).filter(Boolean))];
    for (const t of queue) setRow(t, (r) => ({ ...r, asking: true, askError: undefined }));
    for (let at = 0; at < queue.length; at += 6) {
      const batch = queue.slice(at, at + 6);
      const result = await askStarterQuestions(tenantId, deploymentId, batch).catch((err: unknown) => ({
        error: err instanceof Error ? err.message : String(err),
      }));
      for (const text of batch) {
        const got = "error" in result ? undefined : result.answers.find((a) => a.question === text.replace(/\s+/g, " "))?.answer;
        setRow(text, (r) =>
          !got
            ? { ...r, asking: false, askError: "error" in result ? result.error : "No answer came back." }
            : {
                ...r,
                asking: false,
                answer: got,
                asked: text,
                checkedIt: false,
                keptReason: undefined,
                foundAt: undefined,
                // Ticked only when validation's rules ask nothing more of it (a price the confirmed table
                // agrees with included); one that needs a decision waits for it.
                checked: starterNeed(got).need === "ok" ? r.checked || tick : false,
              },
        );
      }
    }
  };

  // Opening reuses the last suggestions; "New suggestions" asks the site for others and keeps
  // what's ticked or typed. Every suggestion not yet asked with its wording is asked.
  const load = (fresh: boolean) => {
    // Reopening: the rows as they were, ticks and answers kept; only rows edited since are asked.
    const stash = fresh ? undefined : (rows ?? readStash(deploymentId));
    if (stash?.length) {
      setRows(stash);
      setSaved(null);
      void ask(stash.filter((r) => r.text.trim() && !askedNow(r)).map((r) => r.text));
      return;
    }
    setSuggesting(fresh ? "fresh" : "open");
    requestAnimationFrame(() => loading.current?.focus());
    setLoadError(undefined);
    setSaveError(undefined);
    setSaved(null);
    start(async () => {
      const result = await starterChoices(tenantId, deploymentId, fresh);
      setPrimary(result.primary);
      setSuggestedAt(result.suggestedAt);
      setLeftOut(result.leftOut);
      if (result.error) setLoadError(`No suggestions from the site: ${result.error}`);
      const fromNow: Row[] = result.choices.map((c) => ({
        text: c.text,
        from: c.from,
        // The widget's own stay ticked, unless the latest run found no answer to them.
        checked: c.from === "current" && (!c.answer || (c.answer.answered && !c.answer.failure)),
        ...(c.answer && { answer: c.answer, asked: c.text }),
      }));
      const kept = rows?.filter((r) => r.checked || r.from === "own") ?? [];
      const seen = new Set(kept.map((r) => r.text.trim().toLowerCase()));
      const next = rows ? [...kept, ...fromNow.filter((r) => r.from !== "current" && !seen.has(r.text.trim().toLowerCase()))] : fromNow;
      setRows(next);
      setSuggesting(undefined);
      await ask(next.filter((r) => !askedNow(r)).map((r) => r.text));
    });
  };

  const toggle = (r: Row, i: number, checked: boolean) => {
    if (!checked || usable(r)) return setRow(r.text, (x) => ({ ...x, checked }));
    // Not asked with this wording yet: ask, and tick it if it's answered. The checkbox waits while
    // it's asked, so focus goes to its answer, which says what happened.
    if (!askedNow(r)) {
      void ask([r.text], true);
      focusSoon(`starter-answer-${i}`);
    }
  };

  // "Add your own": a new empty row, with focus in it, so typing goes into the question (a space
  // typed on the button would add another row).
  const addOwn = () => {
    const at = rows?.length ?? 0;
    setRows((all) => [...(all ?? []), { text: "", checked: false, from: "own" }]);
    focusSoon(`starter-text-${at}`);
  };

  // Cancel: the picker closes, and focus goes back to the button that opens it.
  const cancel = () => {
    setRows(null);
    focusSoon("starter-choose");
  };

  const use = () => {
    if (!rows) return;
    setSaveError(undefined);
    start(async () => {
      const picked = rows.filter((r) => r.checked && usable(r));
      const result = await chooseStarters(
        tenantId,
        deploymentId,
        picked.map((r) => r.text),
        typedName,
        picked.filter((r) => r.checkedIt).map((r) => r.text),
        picked.filter((r) => r.keptReason && held(r.answer)).map((r) => ({ question: r.text, reason: r.keptReason ?? "" })),
        picked.filter((r) => r.foundAt).map((r) => ({ question: r.text, url: r.foundAt ?? "" })),
      );
      setNameMissing(Boolean(result.needsName));
      if (result.needsName) nameInput.current?.focus();
      if (result.error) {
        // Ticks stay. A row the save asked again shows its answer as it came back this time, and focus
        // goes to the first refused row's decision control.
        const blocked = result.blocked ?? [];
        if (blocked.length) {
          const again = new Map(blocked.map((b) => [b.question, b]));
          setRows((all) =>
            (all ?? []).map((r) => {
              const b = again.get(asSent(r.text));
              return b ? { ...r, answer: b.answer, asked: r.text.trim() } : r;
            }),
          );
          const first = rows.findIndex((r) => again.has(asSent(r.text)));
          const need = again.get(asSent(rows[first]?.text ?? ""))?.need;
          if (first >= 0)
            focusSoon(
              need === "check"
                ? `starter-decide-${first}`
                : need === "reason"
                  ? `starter-keep-${first}`
                  : need === "address"
                    ? `starter-found-${first}`
                    : `starter-pick-${first}`,
            );
        }
        setSaveError(result.error);
      } else {
        setSaved({ starters: result.starters ?? [], asked: result.asked ?? 0 });
        setRows(null);
        writeStash(deploymentId, null);
      }
    });
  };

  // Kept between openings, in this tab.
  useEffect(() => {
    if (rows) writeStash(deploymentId, rows);
  }, [rows, deploymentId]);
  // After a reload (round 6): the picker opens again as it was, its ticks and decisions kept, when
  // something in it was ticked; only rows edited since are asked.
  // biome-ignore lint/correctness/useExhaustiveDependencies: once, on mount
  useEffect(() => {
    const stash = readStash(deploymentId);
    if (!stash?.some((r) => r.checked)) return;
    setRows(stash);
    void ask(stash.filter((r) => r.text.trim() && !askedNow(r)).map((r) => r.text));
  }, []);

  const chosen = rows?.filter((r) => r.checked && r.text.trim()) ?? [];
  const chosenKey = chosen.map((r) => r.text.trim()).join("\n");
  const stillConfig = useMemo(
    () => widget && { ...widget, settings: { ...widget.settings, starters: chosenKey ? chosenKey.split("\n") : [] } },
    [widget, chosenKey],
  );
  const tooLong = chosen.some((r) => r.text.trim().length > MAX_STARTER_LENGTH);
  const unanswered = chosen.filter((r) => !usable(r));
  const asking = rows?.some((r) => r.asking) ?? false;
  const shown = saved?.starters ?? current;
  // Rows keep their index (their identity); those that only passed validation come last, and stay in
  // place when ticked, so a tick never moves the checkbox under the pointer.
  const inOrder = (rows ?? [])
    .map((r, i) => ({ r, i }))
    .sort((a, b) => Number(a.r.from === "validation") - Number(b.r.from === "validation"));
  const folded = inOrder.filter(({ r }) => r.from === "validation");
  const firstFolded = folded[0]?.i;

  return (
    <section className="starter-picker" aria-labelledby="starters-title">
      <h3 className="h4" id="starters-title">
        Starter questions
      </h3>
      {loadError && (
        <p className="notice" data-tone="warning" role="status">
          {loadError}
        </p>
      )}
      {saved && (
        <p className="notice" role="status" tabIndex={-1} ref={savedNotice}>
          {saved.starters.length
            ? "Saved: the chat opens with these starter questions."
            : "Saved: the chat opens without starter questions."}
          {saved.asked > 0 &&
            ` ${saved.asked === 1 ? "The new one was" : `The ${saved.asked} new ones were`} asked into the latest validation run: check any flagged answer there before sign-off.`}
        </p>
      )}

      {!rows && (
        <>
          {saved || status === "confirmed" ? (
            <p>
              <Badge tone="good">Chosen</Badge>{" "}
              {shown.length ? shown.map((q) => `“${q}”`).join(", ") : "No starter questions: the chat opens with the welcome only."}
            </p>
          ) : status === "check" ? (
            <p>
              <Badge tone="warning">Check this</Badge> The widget shows {shown.map((q) => `“${q}”`).join(", ")}, set without anyone choosing
              them. Choose them in the picker.
            </p>
          ) : (
            <p className="muted">None yet. Pick up to {MAX_STARTERS} buttons for the chat's opening screen, or choose none.</p>
          )}
          {waitingFor && (
            <p className="help" role="status">
              {waitingFor}
            </p>
          )}
          <button
            type="button"
            id="starter-choose"
            className="button secondary"
            onClick={() => load(false)}
            disabled={pending || Boolean(waitingFor)}
          >
            {suggesting === "open" ? "Suggesting questions from the site…" : "Choose starter questions"}
          </button>
          <p className="help" role="status" tabIndex={-1} ref={loading}>
            {suggesting === "open" ? "Suggesting questions from the site, and asking each as a visitor would: a few seconds." : ""}
          </p>
        </>
      )}

      {rows && (
        <div className="picker">
          <p className="help" tabIndex={-1} ref={pickerStart}>
            Each question is asked as a visitor will ask it, so you see its answer before you tick it; one with no answer can't be a
            starter. Tick up to {MAX_STARTERS} and edit their wording (an edited question is asked again when you tick it). Keep each under{" "}
            {STARTER_GUIDE} characters so it fits on one line on a phone. Nothing changes on the live chat until you click{" "}
            <strong>Use these</strong>. These asks are partner tests: they don't count toward usage.
          </p>
          <ul className="plain">
            {inOrder.map(({ r, i }) => {
              const length = r.text.trim().length;
              const a = askedNow(r) ? r.answer : undefined;
              const needsDecision = a !== undefined && (held(a) || needOf(r)?.need !== "ok" || !readable(a));
              return (
                // Rows are edited in place: the index is their identity.
                <Fragment key={i}>
                  {i === firstFolded && (
                    <li>
                      <button type="button" className="link-button" aria-expanded={showMore} onClick={() => setShowMore((open) => !open)}>
                        {showMore ? "Hide" : "Show"} {folded.length} more {folded.length === 1 ? "question" : "questions"} that passed
                        validation
                      </button>
                    </li>
                  )}
                  <li
                    className="choice"
                    style={{ alignItems: "flex-start" }}
                    hidden={r.from === "validation" && !showMore && !r.checked && !needsChosen(r)}
                  >
                    <input
                      type="checkbox"
                      id={`starter-pick-${i}`}
                      checked={r.checked}
                      disabled={r.asking || (a !== undefined && !usable(r))}
                      onChange={(e) => toggle(r, i, e.target.checked)}
                      aria-label={`Use “${r.text}”`}
                      aria-describedby={`starter-answer-${i}`}
                    />
                    <div style={{ flex: "1 1 auto", maxWidth: "40rem" }}>
                      <input
                        id={`starter-text-${i}`}
                        aria-label={`Starter question ${i + 1}`}
                        aria-describedby={`starter-count-${i}`}
                        value={r.text}
                        maxLength={200}
                        onChange={(e) =>
                          // A new wording is a new question: unticked until it's asked.
                          setRows((all) => (all ?? []).map((x, n) => (n === i ? { ...x, text: e.target.value, checked: false } : x)))
                        }
                        style={{ font: "inherit", padding: "6px 10px", minWidth: 0, width: "100%" }}
                      />
                      <span id={`starter-count-${i}`} className="help">
                        {/* "Suggested from the site · 33 characters of the 48 that fit on one line on a phone" */}
                        {FROM[r.from]} · {length} {length === 1 ? "character" : "characters"}
                        {length > MAX_STARTER_LENGTH
                          ? `: too long, the widget takes up to ${MAX_STARTER_LENGTH}`
                          : length > STARTER_GUIDE
                            ? `: over the ${STARTER_GUIDE} that fit on one line on a phone, so it may wrap to two`
                            : ` of the ${STARTER_GUIDE} that fit on one line on a phone`}
                      </span>
                      <div id={`starter-answer-${i}`} className="help" style={{ display: "block" }} aria-live="polite" tabIndex={-1}>
                        {r.asking ? (
                          "Asking it as a visitor would…"
                        ) : r.askError ? (
                          `Couldn't ask it: ${r.askError}`
                        ) : !a ? (
                          r.text.trim() ? (
                            "Not asked with this wording yet: ticking it asks it."
                          ) : (
                            ""
                          )
                        ) : !readable(a) ? (
                          <>
                            <Badge tone="critical">No answer</Badge> Visitors who click it would get the no-answer reply, so it can't be a
                            starter.
                            {a.failure && !a.failure.startsWith("No answer") && ` ${a.failure}.`}
                          </>
                        ) : (
                          <>
                            {a.answered && !held(a) ? <Badge tone="good">Answered</Badge> : <Badge tone="warning">Held</Badge>}
                            <details className="picker-answer" open={needsDecision}>
                              <summary>Its answer and sources</summary>
                              <ModelText text={a.answer} {...(links && { links })} note />
                              {a.visitorGets && (
                                <>
                                  {" "}
                                  <strong>Visitors don't read that. They get:</strong>{" "}
                                  <ModelText text={a.visitorGets.answer} {...(links && { links })} note />
                                </>
                              )}
                              {a.sources.length > 0 && (
                                <>
                                  {" "}
                                  Sources:{" "}
                                  {a.sources.map((s, n) => (
                                    <span key={s.url}>
                                      {n > 0 && ", "}
                                      <a href={s.url} target="_blank" rel="noreferrer">
                                        {s.title}
                                      </a>
                                    </span>
                                  ))}
                                  .
                                </>
                              )}
                            </details>
                            {a.tableMatched && !a.holds?.length && (
                              <>
                                {" "}
                                <Badge tone="good">Matches the price table</Badge>
                              </>
                            )}
                            {held(a) && (
                              <>
                                {" "}
                                {a.holds?.map((h) => plainQuote(h.text)).join(" ")}{" "}
                                <label>
                                  Keep it as a starter, because{" "}
                                  <input
                                    id={`starter-keep-${i}`}
                                    value={r.keptReason ?? ""}
                                    maxLength={300}
                                    onChange={(e) => setRow(r.text, (x) => ({ ...x, keptReason: e.target.value }))}
                                    aria-label={`Why “${r.text}” is right`}
                                  />
                                </label>
                              </>
                            )}
                            {!held(a) && (a.flags?.length || a.languageCheck || a.checks?.length) ? (
                              <>
                                {" "}
                                <Badge tone="warning">Check this</Badge> It{" "}
                                {[
                                  ...(a.flags ?? []).map((f) => FLAG_TEXT[f] ?? f),
                                  ...(a.languageCheck ? ["may be in another language"] : []),
                                  ...(a.checks ?? []).map((c) => CHECK_TEXT[c]),
                                ].join(", and ")}
                                .
                                {a.figures?.length ? (
                                  <span style={{ display: "block" }}>
                                    {a.figures.map((f) => (
                                      <span key={`${f.kind}-${f.figure}`} style={{ display: "block" }}>
                                        {f.figure}:{" "}
                                        {f.page ? (
                                          <>
                                            “{f.excerpt ?? ""}” on{" "}
                                            <a href={f.page.url} target="_blank" rel="noreferrer">
                                              {f.page.title}
                                            </a>
                                          </>
                                        ) : (
                                          "no synced page states it."
                                        )}
                                      </span>
                                    ))}
                                  </span>
                                ) : null}
                                {a.figures?.some((f) => !f.page) && (
                                  <label style={{ display: "block" }}>
                                    Where you found it{" "}
                                    <input
                                      id={`starter-found-${i}`}
                                      type="url"
                                      value={r.foundAt ?? ""}
                                      maxLength={500}
                                      onChange={(e) => setRow(r.text, (x) => ({ ...x, foundAt: e.target.value }))}
                                      placeholder="https://"
                                    />
                                  </label>
                                )}{" "}
                                {r.checkedIt ? (
                                  <Badge tone="good">Checked</Badge>
                                ) : (
                                  <button
                                    type="button"
                                    id={`starter-decide-${i}`}
                                    className="link-button"
                                    onClick={() => {
                                      setRow(r.text, (x) => ({ ...x, checkedIt: true }));
                                      // The button gives way to "Checked", and the question can be ticked now.
                                      focusSoon(`starter-pick-${i}`);
                                    }}
                                    aria-label={`I checked it: it matches the site (“${r.text}”)`}
                                  >
                                    I checked it: it matches the site
                                  </button>
                                )}
                              </>
                            ) : null}
                          </>
                        )}
                      </div>
                      {a && !readable(a) && !r.asking && (
                        <PickerFix
                          tenantId={tenantId}
                          deploymentId={deploymentId}
                          question={r.text.trim()}
                          typedName={typedName}
                          onAskAgain={() => void ask([r.text])}
                        />
                      )}
                    </div>
                  </li>
                </Fragment>
              );
            })}
          </ul>
          {leftOut.length > 0 && (
            <p className="help">
              Not offered: {leftOut.map((q) => `“${q}”`).join(", ")}. Visitors don't ask “What can you tell me about …”.
            </p>
          )}
          <div className="actions">
            <button type="button" className="link-button" onClick={addOwn}>
              Add your own
            </button>
            <button
              type="button"
              className="link-button"
              onClick={() => void ask(rows.filter((r) => r.text.trim()).map((r) => r.text))}
              disabled={pending || asking}
            >
              Ask again
            </button>
            <button type="button" className="link-button" onClick={() => load(true)} disabled={pending || asking}>
              {suggesting === "fresh" ? "Asking the site for new suggestions…" : "New suggestions"}
            </button>
            {suggestedAt && <span className="help">Suggestions from {day(suggestedAt)}; what's ticked stays.</span>}
          </div>

          <p className="label">Preview of the starter buttons</p>
          {stillConfig ? (
            <div className="actions">
              <WidgetStill config={stillConfig} part="starters" device="desktop" label="Desktop" />
              <WidgetStill config={stillConfig} part="starters" device="phone" label="Phone" />
            </div>
          ) : (
            <div className="actions">
              {WIDTHS.map((w) => (
                <figure key={w.label} style={{ margin: 0 }}>
                  <figcaption className="help">{w.label}</figcaption>
                  <div
                    style={{
                      width: w.px,
                      maxWidth: "100%",
                      display: "flex",
                      flexWrap: "wrap",
                      gap: 8,
                      padding: 12,
                      border: "1px solid var(--arag-border)",
                      borderRadius: "var(--arag-radius)",
                      background: "#fff",
                    }}
                  >
                    {chosen.length ? (
                      chosen.map((r) => (
                        <span
                          key={r.text}
                          style={{
                            border: `1px solid ${primary ?? "var(--arag-border)"}`,
                            borderRadius: 8,
                            padding: "6px 10px",
                            fontSize: "0.92em",
                            lineHeight: 1.3,
                          }}
                        >
                          {r.text.trim()}
                        </span>
                      ))
                    ) : (
                      <span className="muted">No starter buttons</span>
                    )}
                  </div>
                </figure>
              ))}
            </div>
          )}

          {setupMode && (
            <div className="field">
              <label htmlFor="starter-name">Your name</label>
              <p className="help" id="starter-name-help">
                Setup mode: the console can't tell who you are, so type the name to record with this choice.
              </p>
              <input
                id="starter-name"
                ref={nameInput}
                aria-describedby={nameMissing ? "starter-name-help starter-save-error" : "starter-name-help"}
                aria-invalid={nameMissing || undefined}
                value={typedName}
                onChange={(e) => {
                  onTypedName(e.target.value);
                  setNameMissing(false);
                }}
                style={{ maxWidth: "24rem" }}
                maxLength={80}
                autoComplete="name"
              />
            </div>
          )}
          <div className="inline-field">
            <button
              type="button"
              className="button"
              onClick={use}
              disabled={pending || asking || chosen.length > MAX_STARTERS || tooLong || unanswered.length > 0}
              aria-describedby={saveError ? "starter-save-error" : undefined}
            >
              {pending && !suggesting ? "Saving…" : asking ? "Asking…" : chosen.length ? "Use these" : "Use none"}
            </button>
            <button type="button" className="link-button" onClick={cancel} disabled={pending}>
              Cancel
            </button>
          </div>
          {saveError && (
            <p className="notice" data-tone="critical" role="alert" id="starter-save-error" tabIndex={-1} ref={saveErrorNotice}>
              {saveError}
            </p>
          )}
          {chosen.length > MAX_STARTERS && <p className="help">Choose at most {MAX_STARTERS}.</p>}
        </div>
      )}
    </section>
  );
}

// Under a suggestion with no answer: the site's pages that may answer it, ready to add to the sync
// (with Keep it anyway for a page a date or stale-price rule leaves out), then Ask again.
function PickerFix(props: { tenantId: string; deploymentId: string; question: string; typedName: string; onAskAgain: () => void }) {
  const { tenantId, deploymentId, question } = props;
  const [pages, setPages] = useState<{ pages: PageCandidate[]; note?: string } | { error: string }>();
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [asks, setAsks] = useState<KeepAsk[]>();
  const [reason, setReason] = useState("");
  const [added, setAdded] = useState<string[]>();
  const [error, setError] = useState<string>();
  const [pending, start] = useTransition();
  const keepField = useRef<HTMLInputElement>(null);
  const result = useRef<HTMLParagraphElement>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const errorNotice = useRef<HTMLSpanElement>(null);
  // "Don't keep": back to Add, which the question had disabled.
  const [declined, setDeclined] = useState(0);
  useEffect(() => {
    if (declined) addButton.current?.focus();
  }, [declined]);
  // Add was disabled while it worked: an error takes focus.
  useEffect(() => {
    if (error) errorNotice.current?.focus();
  }, [error]);

  useEffect(() => {
    let live = true;
    answeringPages(tenantId, deploymentId, question)
      .then((r) => live && setPages(r))
      .catch((err: unknown) => live && setPages({ error: err instanceof Error ? err.message : String(err) }));
    return () => {
      live = false;
    };
  }, [tenantId, deploymentId, question]);
  useEffect(() => {
    if (asks?.length) keepField.current?.focus();
  }, [asks]);
  useEffect(() => {
    if (added) result.current?.focus();
  }, [added]);

  const add = (urls: string[], keep?: string) =>
    start(async () => {
      setError(undefined);
      const r = await addPagesForStarter(tenantId, deploymentId, urls, props.typedName, keep);
      if (r.error) setError(r.error);
      setAsks(r.needsReason?.length ? r.needsReason : undefined);
      if (r.added?.length) setAdded((all) => [...(all ?? []), ...(r.added ?? [])]);
    });

  if (!pages) return <span className="help">Looking through the site's pages that may answer it…</span>;
  if ("error" in pages) return <span className="help">{pages.error}</span>;
  const list = pages.pages.filter((p) => !p.inSync);
  return (
    <span className="notice" data-tone="neutral" style={{ display: "block" }}>
      {added ? (
        <span ref={result} tabIndex={-1} role="status" style={{ display: "block" }}>
          {added.length === 1 ? "1 page" : `${added.length} pages`} added to the sync. Once {added.length === 1 ? "it's" : "they're"}{" "}
          answerable (within a few minutes, longer while the first sync runs), ask it again.{" "}
          <button type="button" className="link-button" onClick={props.onAskAgain}>
            Ask it again
          </button>
        </span>
      ) : !list.length ? (
        <span className="help">{pages.note ?? "No page on the site that isn't synced already matches it."}</span>
      ) : (
        <>
          <span className="label" style={{ display: "block" }}>
            Pages on the site that may answer this
          </span>
          {pages.note && (
            <span className="help" style={{ display: "block" }}>
              {pages.note}
            </span>
          )}
          <ul className="plain">
            {list.map((p) => (
              <li key={p.url} className="choice">
                <input
                  type="checkbox"
                  id={`starter-page-${question}-${p.url}`}
                  checked={ticked.has(p.url)}
                  disabled={pending}
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
                <label htmlFor={`starter-page-${question}-${p.url}`}>
                  {p.title && <>{p.title} </>}
                  <a href={p.url} target="_blank" rel="noreferrer" className={p.title ? "muted" : undefined}>
                    {new URL(p.url).pathname}
                  </a>
                  {p.leftOutBecause && <span className="help"> Left out: {p.leftOutBecause}</span>}
                </label>
              </li>
            ))}
          </ul>
          <button
            type="button"
            ref={addButton}
            className="button secondary"
            disabled={pending || !ticked.size || !!asks}
            onClick={() => add([...ticked])}
          >
            {pending && !asks
              ? "Adding…"
              : !ticked.size
                ? "Tick the pages that answer it"
                : ticked.size === 1
                  ? "Add this page"
                  : `Add these ${ticked.size} pages`}
          </button>
        </>
      )}
      {asks && (
        <span className="field" style={{ display: "block" }}>
          {asks.map((a) => (
            <span key={a.url} style={{ display: "block" }}>
              {a.title ?? new URL(a.url).pathname}: {a.rule} Keep it anyway?
            </span>
          ))}
          <label htmlFor={`starter-keep-${question}`}>
            Why keep {asks.length === 1 ? "it" : "them"}? Review shows your name and reason.
          </label>
          <span className="inline-field">
            <input
              id={`starter-keep-${question}`}
              ref={keepField}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={300}
              style={{ width: "auto", flex: "1 1 18rem" }}
            />
            <button
              type="button"
              className="button secondary"
              disabled={pending || reason.trim().length < 3}
              onClick={() =>
                add(
                  asks.map((a) => a.url),
                  reason.trim(),
                )
              }
            >
              {pending ? "Keeping…" : "Keep it anyway"}
            </button>
            <button
              type="button"
              className="link-button"
              onClick={() => {
                setAsks(undefined);
                setDeclined((n) => n + 1);
              }}
            >
              Don't keep {asks.length === 1 ? "it" : "them"}
            </button>
          </span>
        </span>
      )}
      {error && (
        <span className="notice" data-tone="critical" role="alert" style={{ display: "block" }} tabIndex={-1} ref={errorNotice}>
          {error}
        </span>
      )}
    </span>
  );
}
