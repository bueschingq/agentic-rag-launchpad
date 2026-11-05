"use client";

// A failed submit's summary: it takes focus, so keyboard and screen-reader users land on it, and
// each error links to its field (fields use their name as their id).

import { useEffect, useRef } from "react";

export function ErrorSummary({ errors }: { errors: Record<string, string> }) {
  const summary = useRef<HTMLDivElement>(null);
  const entries = Object.entries(errors).filter(([field]) => field !== "_form");
  const general = errors._form;
  const count = Object.keys(errors).length;
  // A new set of errors (a new failed submit) moves focus here.
  const key = JSON.stringify(errors);
  useEffect(() => {
    if (key !== "{}") summary.current?.focus();
  }, [key]);
  if (count === 0) return null;
  return (
    <div ref={summary} className="notice error-summary" data-tone="critical" role="alert" tabIndex={-1}>
      <p>{general ?? (entries.length === 1 ? "Fix this, then try again:" : `Fix these ${entries.length}, then try again:`)}</p>
      {entries.length > 0 && (
        <ul>
          {entries.map(([field, message]) => (
            <li key={field}>
              <a
                href={`#${field}`}
                onClick={(e) => {
                  // Folded sections (billing, content settings) open to show the field.
                  const target = document.getElementById(field);
                  if (!target) return;
                  e.preventDefault();
                  for (let d = target.closest("details"); d; d = d.parentElement?.closest("details") ?? null) d.open = true;
                  target.focus();
                }}
              >
                {message}
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
