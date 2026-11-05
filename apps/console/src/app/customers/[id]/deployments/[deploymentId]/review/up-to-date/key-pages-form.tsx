"use client";

// Bring up to date's Add for the key pages. In setup mode it asks for a name, starting from the
// last one typed in this browser (components/typed-name.ts); an error takes focus on the field
// it's about.

import { startTransition, useActionState, useEffect, useRef } from "react";
import { useTypedName } from "@/components/typed-name.ts";
import type { KeyPagesState } from "./actions.ts";

export function KeyPagesForm({
  action,
  setupMode,
  label,
}: {
  action: (previous: KeyPagesState, form: FormData) => Promise<KeyPagesState>;
  setupMode: boolean;
  label: string;
}) {
  const [state, run, pending] = useActionState(action, {});
  const [name, setName] = useTypedName();
  const nameField = useRef<HTMLInputElement>(null);
  const error = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (!state.error) return;
    if (state.needsName) nameField.current?.focus();
    else error.current?.focus();
  }, [state]);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const form = new FormData(e.currentTarget);
        startTransition(() => run(form));
      }}
    >
      {setupMode && (
        <div className="field inline-field">
          <label htmlFor="key-pages-name">Your name</label>
          <input
            id="key-pages-name"
            ref={nameField}
            name="name"
            autoComplete="name"
            required
            maxLength={80}
            value={name}
            onChange={(e) => setName(e.target.value)}
            aria-invalid={state.needsName ? true : undefined}
            aria-describedby={state.error ? "key-pages-error" : undefined}
          />
        </div>
      )}
      {state.error && (
        <p className="notice" data-tone="critical" role="alert" id="key-pages-error" tabIndex={-1} ref={error}>
          {state.error}
        </p>
      )}
      <div className="actions">
        <button className="button" type="submit" disabled={pending}>
          {pending ? "Adding…" : label}
        </button>
      </div>
    </form>
  );
}
