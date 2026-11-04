"use client";

// Find a page, for the pages panel under a question with no answer (validation and the starter
// picker): the search box starts with the question's telling words (lib/content.ts searchWords:
// "slime carpet"), so trying the client's own word is one edit ("goo carpet"). It searches every
// page in the sitemap by address and title and every synced page by its text, each word on its
// own, and lists near misses with the words they hold and lack. Each page not in the sync offers
// Always include. Focus moves to the result line after each search.

import { useActionState, useEffect, useId, useRef } from "react";
import { Badge } from "@/components/ui.tsx";
import { type FindState, findPages } from "./actions.ts";
import { AlwaysInclude } from "./always-include.tsx";

interface Props {
  tenantId: string;
  deploymentId: string;
  // The question's telling words (searchWords), editable.
  initial: string;
  setupMode: boolean;
}

const WRAP = { whiteSpace: "normal", overflowWrap: "anywhere" } as const;

// A near miss or a page found by its text, in words (lib/content.ts matchNote, here so the
// client bundle needn't load the database code).
function matchWords(c: NonNullable<FindState["pages"]>[number]): string | undefined {
  if (c.match === "near")
    return `Near miss: has ${(c.matched ?? []).join(", ")}${c.missing?.length ? `, not ${c.missing.join(", ")}` : ""}.`;
  if (c.match === "text") return "Found in the page's text.";
  return undefined;
}

export function FindPage({ tenantId, deploymentId, initial, setupMode }: Props) {
  const [state, run, pending] = useActionState(findPages.bind(null, tenantId, deploymentId), {} as FindState);
  const id = useId();
  const result = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (state.pages || state.error) result.current?.focus();
  }, [state]);
  const pages = state.pages ?? [];
  const matches = pages.filter((p) => p.match !== "near");
  return (
    <div className="find-page">
      <form action={run} className="actions" aria-label="Find a page on the site">
        <label htmlFor={`${id}-q`}>Find a page</label>
        <input id={`${id}-q`} name="q" type="search" defaultValue={initial} maxLength={200} aria-describedby={`${id}-help`} />
        <button type="submit" className="button secondary" aria-disabled={pending || undefined}>
          {pending ? "Searching…" : "Search"}
        </button>
      </form>
      <p id={`${id}-help`} className="help">
        Searches every page's address and title, and the text of every synced page, each word on its own. Try the client's own word for it:
        the site may name the thing differently from the visitor's question.
      </p>
      {(state.pages || state.error) && (
        <p className="help" role="status" tabIndex={-1} ref={result}>
          {state.error
            ? state.error
            : !pages.length
              ? `No page holds any of "${state.q}". Try another word for it.`
              : matches.length
                ? `${matches.length} ${matches.length === 1 ? "page matches" : "pages match"} "${state.q}"${pages.length > matches.length ? ", then near misses" : ""}.`
                : `No page holds all of "${state.q}". Near misses, the rarest word first:`}
        </p>
      )}
      {pages.length > 0 && (
        <ul className="plain">
          {pages.map((c) => (
            <li key={c.url} style={WRAP}>
              <a href={c.url} target="_blank" rel="noreferrer">
                {c.title ?? new URL(c.url).pathname}
              </a>{" "}
              {c.inSync ? <Badge tone="good">In the sync</Badge> : <Badge tone="neutral">Not in the sync</Badge>}
              {c.match === "near" && <Badge tone="neutral">Near miss</Badge>}
              <span className="sub">{new URL(c.url).pathname}</span>
              {matchWords(c) && <span className="step-detail">{matchWords(c)}</span>}
              {c.found && <span className="step-detail">“{c.found}”</span>}
              {c.leftOutBecause && <span className="step-detail">{c.leftOutBecause}</span>}
              {!c.inSync && (
                <AlwaysInclude tenantId={tenantId} deploymentId={deploymentId} url={c.url} label={c.title ?? c.url} setupMode={setupMode} />
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
