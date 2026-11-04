"use client";

// The review's two kinds of form: "Looks right" (sign-off) and "Go without it" (a skip). In setup
// mode (one shared password) the console can't tell who's signing, so each asks for a name.

import type { PublicWidgetConfig } from "@launchpad/theme";
import { startTransition, useActionState } from "react";
import { useTypedName } from "@/components/typed-name.ts";
import type { SignOffOffer } from "@/lib/review.ts";
import { PreviewFrame } from "../widget/preview-frame.tsx";
import type { ReviewActionState } from "./actions.ts";

type Action = (previous: ReviewActionState, form: FormData) => Promise<ReviewActionState>;

function NameField({ id }: { id: string }) {
  const [name, setName] = useTypedName();
  return (
    <div className="field inline-field">
      <label htmlFor={id}>Your name</label>
      <input id={id} name="name" autoComplete="name" required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
    </div>
  );
}

const OFFER_LABEL: Record<SignOffOffer, string> = {
  first: "Looks right: sign off",
  changes: "Looks right: sign off the changes",
  checks: "Looks right: sign off under today's checks",
};

export function SignOffForm({
  action,
  enabled,
  setupMode,
  offer,
  unavailable,
}: {
  action: Action;
  enabled: boolean;
  setupMode: boolean;
  offer: SignOffOffer;
  // Why it can't be signed off whatever the lines say: the account's block.
  unavailable?: string;
}) {
  const [state, run, pending] = useActionState(action, {});
  return (
    <form
      className="sign-off"
      onSubmit={(e) => {
        e.preventDefault();
        const form = new FormData(e.currentTarget);
        startTransition(() => run(form));
      }}
    >
      {state.error && (
        <p className="notice" data-tone="critical" role="alert">
          {state.error}
        </p>
      )}
      {setupMode && <NameField id="sign-off-name" />}
      <button type="submit" className="button" disabled={!enabled || pending}>
        {pending ? "Signing off…" : OFFER_LABEL[offer]}
      </button>
      <p className="help">
        {enabled
          ? "Records your name and the time. The chat shows on the site's pages within a minute, with nothing to change there."
          : (unavailable ?? "Available once every line above is green or skipped on purpose.")}
      </p>
    </form>
  );
}

export function SkipForm({ action, consequence, setupMode, id }: { action: Action; consequence: string; setupMode: boolean; id: string }) {
  const [state, run, pending] = useActionState(action, {});
  return (
    <details className="skip">
      <summary>Go without it</summary>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const form = new FormData(e.currentTarget);
          startTransition(() => run(form));
        }}
      >
        <p className="help">{consequence} Your name is recorded with the choice.</p>
        {state.error && (
          <p className="notice" data-tone="critical" role="alert">
            {state.error}
          </p>
        )}
        {setupMode && <NameField id={`${id}-name`} />}
        <button type="submit" className="button secondary" disabled={pending}>
          Go without it
        </button>
      </form>
    </details>
  );
}

// The saved widget over the site's screenshot, in the widget page's own preview.
export function ReviewPreview({
  src,
  config,
  canAsk,
  siteUrl,
}: {
  src: string;
  config: PublicWidgetConfig;
  canAsk: boolean;
  siteUrl: string;
}) {
  return <PreviewFrame src={src} config={config} canAsk={canAsk} siteUrl={siteUrl} languages={[]} onEvent={() => {}} onFonts={() => {}} />;
}

// "Switch to the newer rules": a named person applies the answering rules the re-check held.
export function SwitchRulesForm({ action, setupMode, version }: { action: Action; setupMode: boolean; version: number }) {
  const [state, run, pending] = useActionState(action, {});
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const form = new FormData(e.currentTarget);
        startTransition(() => run(form));
      }}
    >
      {state.error && (
        <p className="notice" data-tone="critical" role="alert">
          {state.error}
        </p>
      )}
      {setupMode && <NameField id="switch-rules-name" />}
      <button type="submit" className="button secondary" disabled={pending}>
        {pending ? "Switching…" : `Switch to answering rules v${version}`}
      </button>
      <p className="help">Visitors get the new answers within a minute. Your name and the time go in History.</p>
    </form>
  );
}
