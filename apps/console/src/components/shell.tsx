"use client";

// The console's frame: the dark sidebar with the logo and sections, the top bar with search, the
// bell and the account menu, and the menus they open. On a phone the sidebar is a drawer behind
// the Menu button. Every menu opens from a button, closes with Escape (focus goes back to its
// button) or a click elsewhere, and moves between its links with the arrow keys.

import Link from "next/link";
import { usePathname } from "next/navigation";
import { type KeyboardEvent, type ReactNode, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { SearchEntry } from "@/lib/dashboard.ts";
import { Icon, type IconName } from "./icon.tsx";

// Arrow keys move between the links and buttons of an open panel.
function moveFocus(e: KeyboardEvent<HTMLElement>, panel: HTMLElement | null) {
  if (!panel || !["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
  const items = [...panel.querySelectorAll<HTMLElement>("a[href], button:not([disabled])")];
  if (!items.length) return;
  e.preventDefault();
  const at = items.indexOf(document.activeElement as HTMLElement);
  const next =
    e.key === "Home"
      ? 0
      : e.key === "End"
        ? items.length - 1
        : e.key === "ArrowDown"
          ? (at + 1) % items.length
          : (at - 1 + items.length) % items.length;
  items[next]?.focus();
}

interface MenuProps {
  // The button's accessible name, for a button that shows no words of its own; and what it shows.
  label?: string;
  button: ReactNode;
  buttonClass?: string;
  panelClass?: string;
  children: ReactNode;
}

// A disclosure menu: a button that shows a panel of links below it.
export function Menu({ label, button, buttonClass = "icon-button", panelClass = "", children }: MenuProps) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const path = usePathname();

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new page closes the menu.
  useEffect(() => setOpen(false), [path]);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [open]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape" && open) {
      e.stopPropagation();
      setOpen(false);
      trigger.current?.focus();
      return;
    }
    if (open) moveFocus(e, panel.current);
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: Escape and the arrow keys reach the menu from its button or its links.
    <div
      className="menu"
      ref={root}
      onKeyDown={onKeyDown}
      // A link in the panel closes the menu, even one to a place on the same page.
      onClick={(e) => {
        if (panel.current?.contains((e.target as HTMLElement).closest("a"))) setOpen(false);
      }}
      onBlur={(e) => {
        if (open && !root.current?.contains(e.relatedTarget as Node)) setOpen(false);
      }}
    >
      <button
        ref={trigger}
        type="button"
        className={buttonClass}
        aria-expanded={open}
        aria-controls={id}
        aria-label={label}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" && !open) {
            e.preventDefault();
            setOpen(true);
            requestAnimationFrame(() => panel.current?.querySelector<HTMLElement>("a[href], button")?.focus());
          }
        }}
      >
        {button}
      </button>
      <div id={id} ref={panel} className={`menu-panel ${panelClass}`} hidden={!open}>
        {children}
      </div>
    </div>
  );
}

const SIDEBAR_WIDE = "(min-width: 1024px)";

// The sidebar and the top bar around the page. Server-rendered parts arrive as props.
export function ConsoleShell({ sidebar, topbar, children }: { sidebar: ReactNode; topbar: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const toggle = useRef<HTMLButtonElement>(null);
  const drawer = useRef<HTMLDivElement>(null);
  const path = usePathname();

  // The page behind the drawer is inert while it's open, so the Menu button takes focus back once
  // the drawer has closed.
  const refocus = useRef(false);
  const close = useCallback((back: boolean) => {
    refocus.current = back;
    setOpen(false);
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new page closes the drawer.
  useEffect(() => setOpen(false), [path]);
  useEffect(() => {
    const wide = window.matchMedia(SIDEBAR_WIDE);
    const onChange = () => wide.matches && setOpen(false);
    wide.addEventListener("change", onChange);
    return () => wide.removeEventListener("change", onChange);
  }, []);
  useEffect(() => {
    if (open) drawer.current?.querySelector<HTMLElement>("a[href], button")?.focus();
    else if (refocus.current) {
      refocus.current = false;
      toggle.current?.focus();
    }
  }, [open]);

  return (
    <div className="app" data-nav-open={open || undefined}>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: Escape closes the drawer from any link in it. */}
      <div
        id="sidebar"
        className="sidebar"
        ref={drawer}
        onKeyDown={(e) => {
          if (e.key === "Escape" && open) close(true);
        }}
        onClick={(e) => {
          if ((e.target as HTMLElement).closest("a")) setOpen(false);
        }}
      >
        <button type="button" className="icon-button sidebar-close" onClick={() => close(true)} aria-label="Close menu">
          <Icon name="close" />
        </button>
        {sidebar}
      </div>
      {open && <div className="sidebar-backdrop" aria-hidden="true" onClick={() => close(true)} />}
      <div className="app-body" inert={open || undefined}>
        <header className="topbar">
          <button
            ref={toggle}
            type="button"
            className="icon-button menu-toggle"
            aria-expanded={open}
            aria-controls="sidebar"
            aria-label="Menu"
            onClick={() => setOpen(true)}
          >
            <Icon name="menu" />
          </button>
          {topbar}
        </header>
        {children}
      </div>
    </div>
  );
}

// The sections, marking the current one. Customer and deployment pages belong to Customers and
// Deployments; Users is part of Settings but has its own entry.
const SECTIONS: { href: string; label: string; icon: IconName; current: (path: string) => boolean }[] = [
  { href: "/", label: "Dashboard", icon: "home", current: (p) => p === "/" },
  {
    href: "/#customers",
    label: "Customers",
    icon: "customers",
    current: (p) => p.startsWith("/customers/") && !p.includes("/deployments/"),
  },
  {
    href: "/#deployments",
    label: "Deployments",
    icon: "deployments",
    current: (p) => p.startsWith("/deployments/") || (p.startsWith("/customers/") && p.includes("/deployments/")),
  },
  { href: "/costs", label: "Costs", icon: "costs", current: (p) => p.startsWith("/costs") },
  { href: "/settings", label: "Settings", icon: "settings", current: (p) => p === "/settings" },
  { href: "/settings/users", label: "Users", icon: "users", current: (p) => p.startsWith("/settings/users") },
];

export function SidebarNav({ presenting }: { presenting: boolean }) {
  const path = usePathname();
  if (presenting) {
    // Screen-sharing with one client: nothing here leads to other customers or costs.
    return (
      <div className="presenting">
        <p>Presenting</p>
        <a href="/present/stop" className="presenting-stop">
          Stop presenting
        </a>
      </div>
    );
  }
  return (
    <ul className="sidebar-links">
      {SECTIONS.map((s) => (
        <li key={s.href}>
          <Link href={s.href} aria-current={s.current(path) ? "page" : undefined}>
            <Icon name={s.icon} />
            {s.label}
          </Link>
        </li>
      ))}
    </ul>
  );
}

const MAX_RESULTS = 8;

// Search by customer or deployment name (or site), from the names the console already has. Enter
// shows the matches on the dashboard's tables; the list below jumps straight to one. Ctrl+K (⌘K on
// a Mac) focuses it from anywhere.
export function SiteSearch({ entries }: { entries: SearchEntry[] }) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [shortcut, setShortcut] = useState("Ctrl K");
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const root = useRef<HTMLFormElement>(null);
  const path = usePathname();

  useEffect(() => {
    if (/Mac|iPhone|iPad/.test(navigator.platform)) setShortcut("⌘K");
    const onKey = (e: globalThis.KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        input.current?.focus();
        input.current?.select();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new page clears the search.
  useEffect(() => {
    setOpen(false);
    setQuery("");
  }, [path]);

  const needle = query.trim().toLowerCase();
  const matches = useMemo(
    () =>
      needle
        ? entries.filter((e) => e.name.toLowerCase().includes(needle) || e.detail.toLowerCase().includes(needle)).slice(0, MAX_RESULTS)
        : [],
    [entries, needle],
  );
  const showing = open && needle.length > 0;

  return (
    // biome-ignore lint/a11y/useSemanticElements: a search landmark that is also the form Enter submits.
    <form
      role="search"
      action="/#fleet"
      className="site-search"
      ref={root}
      onKeyDown={(e) => {
        if (e.key === "Escape" && showing) {
          e.preventDefault();
          // Focus first: focusing the field opens the list, and this closes it again.
          input.current?.focus();
          setOpen(false);
        } else if (showing && e.target === input.current && e.key === "ArrowDown") {
          e.preventDefault();
          list.current?.querySelector<HTMLElement>("a")?.focus();
        } else if (showing && e.target !== input.current) {
          moveFocus(e, list.current);
        }
      }}
      onBlur={(e) => {
        if (!root.current?.contains(e.relatedTarget as Node)) setOpen(false);
      }}
    >
      <label className="sr-only" htmlFor="site-search">
        Search customers and deployments
      </label>
      <Icon name="search" size={18} />
      <input
        ref={input}
        id="site-search"
        name="q"
        type="search"
        autoComplete="off"
        placeholder="Search customers and deployments"
        aria-describedby="site-search-hint"
        aria-controls="site-search-results"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
      />
      <span className="shortcut" aria-hidden="true">
        {shortcut}
      </span>
      <span id="site-search-hint" className="sr-only">
        Press Enter to filter the dashboard's tables, or Down to pick a match.
      </span>
      <div className="search-results" hidden={!showing}>
        <ul id="site-search-results" ref={list} aria-label="Matches">
          {matches.map((m) => (
            <li key={m.href}>
              <Link href={m.href}>
                <span className="search-name">{m.name}</span>
                <span className="search-detail">{m.detail}</span>
              </Link>
            </li>
          ))}
        </ul>
        {matches.length === 0 && <p className="search-empty">No customer or deployment matches.</p>}
      </div>
      <p className="sr-only" aria-live="polite">
        {showing ? `${matches.length} ${matches.length === 1 ? "match" : "matches"}` : ""}
      </p>
    </form>
  );
}
