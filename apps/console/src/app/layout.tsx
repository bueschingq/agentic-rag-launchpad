import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Nav } from "@/components/nav.tsx";
import "./globals.css";

export const metadata: Metadata = {
  title: "Launchpad",
  description: "Run Progress Agentic RAG chat agents for every customer site from one console.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="masthead">
          <div className="shell">
            <strong>Launchpad</strong>
            <span>for Progress® Agentic RAG</span>
            <Nav />
          </div>
        </header>
        {children}
      </body>
    </html>
  );
}
