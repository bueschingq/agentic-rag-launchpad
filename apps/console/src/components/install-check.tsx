"use client";

// The "Check installation" form: a page address in, a list of checks out.

import { useState, useTransition } from "react";
import { useFocusOnChange } from "@/components/focus.tsx";
import { Badge } from "@/components/ui.tsx";
import type { InstallCheck } from "@/lib/install-check.ts";

const TONE = { pass: "good", fail: "critical", warn: "warning" } as const;
const WORD = { pass: "OK", fail: "Problem", warn: "Check" } as const;

export function InstallCheckForm({
  siteUrl,
  run,
}: {
  siteUrl: string;
  run: (url: string) => Promise<{ checks?: InstallCheck[]; error?: string }>;
}) {
  const [url, setUrl] = useState(siteUrl);
  const [result, setResult] = useState<{ checks?: InstallCheck[]; error?: string; url?: string }>();
  const [pending, start] = useTransition();
  // The result takes focus when it arrives.
  const resultRef = useFocusOnChange<HTMLDivElement>(result);
  return (
    <div className="install-check">
      <form
        className="inline-field"
        onSubmit={(e) => {
          e.preventDefault();
          start(async () => setResult({ ...(await run(url)), url }));
        }}
      >
        <label className="sr-only" htmlFor="check-url">
          Page to check
        </label>
        <input id="check-url" type="url" value={url} onChange={(e) => setUrl(e.target.value)} required />
        <button className="button" type="submit" disabled={pending}>
          {pending ? "Checking… (up to 30 s)" : "Check installation"}
        </button>
      </form>
      <div aria-live="polite" tabIndex={-1} ref={resultRef}>
        {result?.error && (
          <p className="notice" data-tone="critical" role="alert">
            {result.error}
          </p>
        )}
        {result?.checks && (
          <>
            <p>
              {result.checks.every((c) => c.result === "pass") ? (
                <Badge tone="good">All good</Badge>
              ) : result.checks.some((c) => c.result === "fail") ? (
                <Badge tone="critical">{result.checks.filter((c) => c.result === "fail").length} to fix</Badge>
              ) : (
                <Badge tone="warning">{result.checks.filter((c) => c.result === "warn").length} to look at</Badge>
              )}{" "}
              <span className="muted">{result.url}</span>
            </p>
            <ul className="plain checks">
              {result.checks.map((c) => (
                <li key={c.label}>
                  <Badge tone={TONE[c.result]}>{WORD[c.result]}</Badge> <strong>{c.label}</strong>: {c.detail}
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}
