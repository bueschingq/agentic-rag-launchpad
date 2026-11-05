"use client";

// Always include, on the Content page: adds a page by hand. When the page trips a date or
// stale-price rule, it asks first, in place: "This page states a price and was published 11 Oct
// 2016. Keep it anyway?", with a reason and (in setup mode) a name, which Review shows. Focus
// follows each step: to the reason when it asks, to the field an error is about, to the result
// once the page is added, and back to Always include on Cancel. It stays on the page after the
// page is added (included), so the result keeps focus when the list refreshes, and its buttons
// stay focusable while they work (aria-disabled), so focus never drops to the page.

import { useActionState, useEffect, useId, useRef, useState } from "react";
import { useTypedName } from "@/components/typed-name.ts";
import { alwaysInclude, type IncludeState } from "./actions.ts";

interface Props {
  tenantId: string;
  deploymentId: string;
  url: string;
  // The page's title or address, for screen readers.
  label: string;
  setupMode: boolean;
  // Added by hand already: nothing to offer, unless it was just added here.
  included?: boolean;
}

export function AlwaysInclude({ tenantId, deploymentId, url, label, setupMode, included }: Props) {
  const [state, run, pending] = useActionState(alwaysInclude.bind(null, tenantId, deploymentId, url), {} as IncludeState);
  const [name, setName] = useTypedName();
  // The reason is kept in state: the form resets its own fields after each answer from the server,
  // and an error (a missing name) shouldn't lose what was typed.
  const [why, setWhy] = useState("");
  // The question last cancelled: a new answer from the server asks again.
  const [dismissed, setDismissed] = useState<IncludeState | undefined>();
  const id = useId();
  const reason = useRef<HTMLTextAreaElement>(null);
  const nameField = useRef<HTMLInputElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const added = useRef<HTMLSpanElement>(null);
  const asking = Boolean(state.keep) && dismissed !== state;

  // Each answer from the server moves focus to what it's about.
  useEffect(() => {
    if (state.added) added.current?.focus();
    else if (state.keep && state.needsName) nameField.current?.focus();
    else if (state.keep) reason.current?.focus();
    else if (state.error) button.current?.focus();
  }, [state]);
  useEffect(() => {
    if (dismissed) button.current?.focus();
  }, [dismissed]);

  if (state.added) {
    return (
      <span className="sub" role="status" tabIndex={-1} ref={added}>
        Added. It loads within a minute, ahead of every waiting page.
      </span>
    );
  }
  if (included) return null;
  // While it works: focusable, not disabled, and a second press does nothing.
  const busy = { "aria-disabled": pending || undefined, onClick: (e: { preventDefault: () => void }) => pending && e.preventDefault() };
  if (asking && state.keep) {
    return (
      <form action={run} className="keep-anyway" aria-labelledby={`${id}-ask`}>
        <p id={`${id}-ask`}>
          <strong>{state.keep.rule} Keep it anyway?</strong>
        </p>
        <input type="hidden" name="keep" value="1" />
        <input type="hidden" name="rule" value={state.keep.rule} />
        {state.keep.title && <input type="hidden" name="title" value={state.keep.title} />}
        <div className="field">
          <label htmlFor={`${id}-reason`}>Why keep it</label>
          <textarea
            id={`${id}-reason`}
            ref={reason}
            name="reason"
            rows={2}
            maxLength={300}
            required
            value={why}
            onChange={(e) => setWhy(e.target.value)}
            aria-describedby={`${id}-help`}
            aria-invalid={state.error && !state.needsName ? true : undefined}
          />
          <span id={`${id}-help`} className="help">
            Review lists it as "Check this", with your name and this reason.
          </span>
        </div>
        {setupMode && (
          <div className="field inline-field">
            <label htmlFor={`${id}-name`}>Your name</label>
            <input
              id={`${id}-name`}
              ref={nameField}
              name="name"
              autoComplete="name"
              required
              maxLength={80}
              value={name}
              onChange={(e) => setName(e.target.value)}
              aria-invalid={state.needsName ? true : undefined}
            />
          </div>
        )}
        {state.error && (
          <p className="field-error" role="alert">
            {state.error}
          </p>
        )}
        <div className="actions">
          <button type="submit" className="button secondary" {...busy}>
            {pending ? "Keeping…" : "Keep it anyway"}
            <span className="sr-only"> {label}</span>
          </button>
          <button type="button" className="link-button" onClick={() => setDismissed(state)}>
            Cancel<span className="sr-only">: don't add {label}</span>
          </button>
        </div>
      </form>
    );
  }
  return (
    <form action={run}>
      <button ref={button} type="submit" className="link-button" {...busy}>
        {pending ? "Checking the page…" : "Always include"}
        <span className="sr-only"> {label}</span>
      </button>
      {state.error && !asking && (
        <span className="field-error" role="alert">
          {state.error}
        </span>
      )}
    </form>
  );
}
