"use client";

// Reveals the writer key for Sitefinity's connector, on request. Only admins can, and each
// reveal goes in the audit log; the key is never part of the shared install guide.

import { useState, useTransition } from "react";
import { CopyButton } from "@/components/copy-button.tsx";

export function WriterKey({ reveal }: { reveal: () => Promise<{ key?: string; error?: string }> }) {
  const [result, setResult] = useState<{ key?: string; error?: string }>();
  const [pending, start] = useTransition();
  if (result?.key) {
    return (
      <span className="secret">
        <code>{result.key}</code> <CopyButton text={result.key} label="Copy key" />
      </span>
    );
  }
  return (
    <span>
      <button type="button" className="button secondary" disabled={pending} onClick={() => start(async () => setResult(await reveal()))}>
        {pending ? "Revealing…" : "Reveal writer key"}
      </button>{" "}
      {result?.error ? (
        <span className="field-error" role="alert">
          {result.error}
        </span>
      ) : (
        <span className="help">Admins only; each reveal is logged. Send it to the client separately, never in the shared guide.</span>
      )}
    </span>
  );
}
