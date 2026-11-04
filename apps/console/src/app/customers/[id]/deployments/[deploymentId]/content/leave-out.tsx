"use client";

// Leave out, on a Content row: the page leaves the chat now and its path joins the content
// settings' Leave out. Focus goes to the result, which stays when the list refreshes (the row
// keeps this control), and the button stays focusable while it works.

import { useState, useTransition } from "react";
import { useFocusOnChange } from "@/components/focus.tsx";
import { leaveOut } from "./actions.ts";

export function LeaveOut({
  tenantId,
  deploymentId,
  url,
  label,
  removed,
}: {
  tenantId: string;
  deploymentId: string;
  url: string;
  // The page's title or address, for screen readers.
  label: string;
  // Out of the sync already: nothing to offer, unless it was just left out here.
  removed: boolean;
}) {
  const [result, setResult] = useState<{ done?: boolean; error?: string }>({});
  const [pending, start] = useTransition();
  const message = useFocusOnChange<HTMLSpanElement>(result.done || result.error ? result : undefined);
  if (result.done) {
    return (
      <span className="sub" role="status" tabIndex={-1} ref={message}>
        Left out. It leaves the chat within a minute; its address is now in Leave out.
      </span>
    );
  }
  if (removed) return null;
  return (
    <span>
      <button
        type="button"
        className="link-button"
        aria-disabled={pending || undefined}
        onClick={() => {
          if (pending) return;
          start(async () => setResult(await leaveOut(tenantId, deploymentId, url)));
        }}
      >
        {pending ? "Leaving out…" : "Leave out"}
        <span className="sr-only"> {label}</span>
      </button>
      {result.error && (
        <span className="field-error" role="alert" tabIndex={-1} ref={message}>
          {result.error}
        </span>
      )}
    </span>
  );
}
