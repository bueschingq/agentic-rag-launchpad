"use client";

// Masthead navigation, marking the current section.

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/", label: "Fleet" },
  { href: "/costs", label: "Costs" },
  { href: "/settings", label: "Settings" },
];

export function Nav() {
  const path = usePathname();
  // Customer pages belong to the fleet.
  const current = (href: string) => (href === "/" ? path === "/" || path.startsWith("/customers/") : path.startsWith(href));
  return (
    <nav aria-label="Console">
      <ul>
        {LINKS.map((link) => (
          <li key={link.href}>
            <Link href={link.href} aria-current={current(link.href) ? "page" : undefined}>
              {link.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
