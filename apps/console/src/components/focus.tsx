"use client";

// Keyboard focus after an in-page action: on its result message, or on the control that took
// the button's place, so the next Tab carries on from there rather than from "Skip to content"
// (WCAG 2.4.3). Result messages take focus without joining the tab order (tabIndex -1).

import { type ReactNode, useEffect, useRef } from "react";

// Focuses the element each time key changes to something truthy, never on the first render.
export function useFocusOnChange<T extends HTMLElement>(key: unknown) {
  const ref = useRef<T>(null);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (key) ref.current?.focus();
  }, [key]);
  return ref;
}

// Focuses the element with this id once the next render has put it on the page.
export function focusSoon(id: string) {
  requestAnimationFrame(() => document.getElementById(id)?.focus());
}

// A result notice that arrives with the page after a redirect (?allowed, ?signedoff): it takes
// focus when it appears.
export function FocusNotice({
  children,
  tone,
  role = "status",
  className = "notice",
}: {
  children: ReactNode;
  tone?: string;
  role?: "status" | "alert";
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => ref.current?.focus(), []);
  return (
    <div ref={ref} tabIndex={-1} className={className} data-tone={tone} role={role}>
      {children}
    </div>
  );
}
