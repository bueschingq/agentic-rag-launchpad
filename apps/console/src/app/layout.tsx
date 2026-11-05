import type { Metadata } from "next";
import { cookies, headers } from "next/headers";
import type { ReactNode } from "react";
import { ConsoleFrame } from "@/components/console-frame.tsx";
import { userFromHeaders } from "@/lib/auth.ts";
import "./globals.css";

export const metadata: Metadata = {
  // Each page names itself first ("Widget · Main site · Harbor View Dental · Launchpad").
  title: { default: "Launchpad", template: "%s · Launchpad" },
  description: "Run Progress Agentic RAG chat agents for every customer site from one console.",
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  // Share links and sign-in pages have no user: they get the masthead without the console.
  const user = userFromHeaders(await headers());
  const presenting = Boolean((await cookies()).get("lp_presenting")?.value);
  return (
    <html lang="en">
      <body>
        <a className="skip-link" href="#main">
          Skip to content
        </a>
        {user ? (
          <ConsoleFrame user={user} presenting={presenting}>
            {user.setupMode && (
              <aside className="setup-banner" aria-label="Setup mode">
                <p className="shell">
                  Setup mode: everyone signs in with the same password, so the audit log can't say who did what. Connect your Microsoft or
                  Google work accounts to give each person their own sign-in (see the README, "Sign-in").
                </p>
              </aside>
            )}
            {children}
          </ConsoleFrame>
        ) : (
          <>
            <header className="masthead">
              <div className="shell">
                <strong>Launchpad</strong>
                <span>for Progress® Agentic RAG</span>
              </div>
            </header>
            {children}
          </>
        )}
      </body>
    </html>
  );
}
