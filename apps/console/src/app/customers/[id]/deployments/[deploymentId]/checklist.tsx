// The onboarding checklist pinned to the top of a deployment until it's live (then folded to
// one line while steps are open): each step's state, when it was done, and the one thing to do
// next. Plus the onboarding timer, to the first sign-off and to the first answer.

import Link from "next/link";
import { type ChecklistStep, formatMinutes, minutesBetween } from "@/lib/onboarding.ts";

const STATE_TEXT: Record<ChecklistStep["state"], string> = {
  done: "Done",
  current: "Next",
  todo: "To do",
  attention: "Needs attention",
};

export function Checklist({
  steps,
  started,
  signedOffAt,
  heldAt,
  liveAt,
}: {
  steps: ChecklistStep[];
  started: Date;
  // The first sign-off: the onboarding clock's finish line.
  signedOffAt: Date | null;
  // When the sign-off held after the first sync: the clock's second figure.
  heldAt: Date | null;
  liveAt: Date | null;
}) {
  const now = new Date();
  const done = steps.filter((s) => s.state === "done").length;
  return (
    <section className="panel checklist" aria-labelledby="onboarding">
      <div className="panel-head">
        <h2 id="onboarding">Onboarding</h2>
        <p className="muted timer">
          {signedOffAt ? (
            <>
              Signed off <strong>{formatMinutes(minutesBetween(started, signedOffAt))}</strong> after starting, held after the first sync{" "}
              {heldAt ? (
                <>
                  after <strong>{formatMinutes(minutesBetween(started, heldAt))}</strong>
                </>
              ) : (
                <>not yet</>
              )}
              {liveAt && (
                <>
                  , first answer on the site after <strong>{formatMinutes(minutesBetween(started, liveAt))}</strong>
                </>
              )}
            </>
          ) : (
            <>
              <strong>{formatMinutes(minutesBetween(started, now))}</strong> since starting · {done} of {steps.length} done
            </>
          )}
        </p>
      </div>
      <ol className="checklist-steps">
        {steps.map((s) => (
          <li key={s.key} data-state={s.state} aria-current={s.state === "current" ? "step" : undefined}>
            <span className="check-mark" aria-hidden="true" />
            <span className="check-body">
              <span className="check-label">
                {s.label} <span className="sr-only">({STATE_TEXT[s.state]})</span>
              </span>
              <span className="check-detail">{s.detail}</span>
            </span>
            <span className="check-action">
              {s.state !== "done" && s.action ? (
                <Link className={s.state === "todo" ? "link" : "button secondary"} href={s.action.href}>
                  {s.action.label}
                </Link>
              ) : s.at ? (
                <time className="muted" dateTime={s.at.toISOString()}>
                  {s.at.toISOString().slice(0, 10) === now.toISOString().slice(0, 10)
                    ? `${s.at.toISOString().slice(11, 16)} UTC`
                    : s.at.toISOString().slice(0, 10)}
                </time>
              ) : s.action ? (
                <Link href={s.action.href}>{s.action.label}</Link>
              ) : null}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}
