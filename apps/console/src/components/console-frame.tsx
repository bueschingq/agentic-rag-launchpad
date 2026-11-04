// The signed-in console's frame (components/shell.tsx draws it): the logo and sections in the
// sidebar; search, the bell and the account menu in the top bar. Presenting to one client leaves
// out everything that leads to other customers or costs.

import Link from "next/link";
import { type ReactNode, Suspense } from "react";
import type { ConsoleUser } from "@/lib/auth.ts";
import { attentionNow, searchIndex } from "@/lib/dashboard.ts";
import { initials } from "@/lib/overview.ts";
import { Icon } from "./icon.tsx";
import { ConsoleShell, Menu, SidebarNav, SiteSearch } from "./shell.tsx";

const BELL_LIST = 6;

// The bell: how many things need attention, and the first few, each linking to its page.
async function Bell() {
  const items = await attentionNow();
  const n = items.length;
  return (
    <Menu
      label={n ? `Needs attention: ${n}` : "Needs attention: nothing"}
      button={
        <>
          <Icon name="bell" />
          {n > 0 && (
            <span className="bell-count" aria-hidden="true">
              {n > 99 ? "99+" : n}
            </span>
          )}
        </>
      }
      panelClass="bell-panel"
    >
      <p className="menu-title">{n ? `${n} ${n === 1 ? "thing needs" : "things need"} attention` : "Nothing needs attention"}</p>
      {n > 0 && (
        <ul>
          {items.slice(0, BELL_LIST).map((item) => (
            <li key={item.key}>
              <Link href={item.href} data-tone={item.tone}>
                <span className="menu-item-title">
                  {item.deployment ? `${item.customer?.name} › ${item.deployment.name}` : (item.customer?.name ?? "Agentic RAG account")}
                </span>
                <span className="menu-item-detail">{item.issues.map((i) => i.text).join(" · ")}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      <Link className="menu-footer" href="/#attention">
        View all on the dashboard
      </Link>
    </Menu>
  );
}

function BellFallback() {
  return (
    <Link className="icon-button" href="/#attention" aria-label="Needs attention">
      <Icon name="bell" />
    </Link>
  );
}

function AccountMenu({ user }: { user: ConsoleUser }) {
  const role = user.role === "partner_admin" ? "Admin" : "Member";
  return (
    <Menu
      buttonClass="account-button"
      button={
        <>
          <span className="avatar" aria-hidden="true">
            {initials(user.name)}
          </span>
          <span className="sr-only">Account: {user.name}</span>
          <Icon name="chevron" size={16} />
        </>
      }
      panelClass="account-panel"
    >
      <div className="menu-title">
        <strong>{user.name}</strong>
        <span className="role">{role}</span>
        {user.setupMode && <span className="menu-item-detail">Setup mode: shared password</span>}
      </div>
      <ul>
        <li>
          <Link href="/settings">Settings</Link>
        </li>
        <li>
          <Link href="/settings/users">Users</Link>
        </li>
      </ul>
      {!user.setupMode && (
        <form action="/auth/logout" method="post">
          <button type="submit" className="menu-button">
            Sign out
          </button>
        </form>
      )}
    </Menu>
  );
}

export async function ConsoleFrame({ user, presenting, children }: { user: ConsoleUser; presenting: boolean; children: ReactNode }) {
  const entries = presenting ? [] : await searchIndex().catch(() => []);
  const sidebar = (
    <nav aria-label="Console" className="sidebar-nav">
      {presenting ? (
        <span className="sidebar-logo">
          {/* biome-ignore lint/performance/noImgElement: the brand's SVG lockup, served as is. */}
          <img src="/brand/primary-stacked-alternate.svg" alt="Progress Agentic RAG" width={197} height={75} />
        </span>
      ) : (
        <Link href="/" className="sidebar-logo">
          {/* biome-ignore lint/performance/noImgElement: the brand's SVG lockup, served as is. */}
          <img src="/brand/primary-stacked-alternate.svg" alt="Progress Agentic RAG, Launchpad home" width={197} height={75} />
        </Link>
      )}
      <p className="sidebar-product">Launchpad</p>
      <SidebarNav presenting={presenting} />
      <div className="sidebar-loop" aria-hidden="true">
        {/* biome-ignore lint/performance/noImgElement: the brand's Hex Loop, cropped by CSS. */}
        <img src="/brand/hex-loop-rgb.svg" alt="" />
      </div>
    </nav>
  );
  const topbar = presenting ? (
    <p className="topbar-presenting">Presenting to one client</p>
  ) : (
    <>
      <SiteSearch entries={entries} />
      <div className="topbar-end">
        <Suspense fallback={<BellFallback />}>
          <Bell />
        </Suspense>
        <AccountMenu user={user} />
      </div>
    </>
  );
  return (
    <ConsoleShell sidebar={sidebar} topbar={topbar}>
      {children}
    </ConsoleShell>
  );
}
