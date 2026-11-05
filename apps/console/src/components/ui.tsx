// Small presentational pieces shared by the dashboard pages. Status always travels as an icon
// plus words, never as color alone.

import Link from "next/link";
import type { ReactNode } from "react";
import { formatPercent, formatScore } from "@/lib/format.ts";
import type { Alert, QualitySummary } from "@/lib/metrics.ts";
import { Icon, type IconName } from "./icon.tsx";

export type Tone = "good" | "neutral" | "warning" | "critical";

const ICONS: Record<Exclude<Tone, "neutral">, ReactNode> = {
  good: <path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />,
  warning: (
    <>
      <path d="M8 1.5l7 12.5H1z" fill="currentColor" />
      <path d="M8 6v3.5M8 11.5v.5" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" />
    </>
  ),
  critical: (
    <>
      <circle cx="8" cy="8" r="7" fill="currentColor" />
      <path d="M5.5 5.5l5 5M10.5 5.5l-5 5" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" />
    </>
  ),
};

export function Badge({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span className="badge" data-tone={tone}>
      {tone !== "neutral" && (
        <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
          {ICONS[tone]}
        </svg>
      )}
      {children}
    </span>
  );
}

const STATUS: Record<string, [Tone, string]> = {
  live: ["good", "Live"],
  paused: ["neutral", "Paused"],
  draft: ["neutral", "Draft"],
  provisioning: ["neutral", "Provisioning"],
  failed: ["critical", "Failed"],
  active: ["good", "Active"],
  archived: ["neutral", "Archived"],
};

// A table that scrolls sideways on a phone: keyboard users can focus it to scroll it.
export function TableScroll({ label, children }: { label: string; children: ReactNode }) {
  return (
    // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling region must take focus to scroll by keyboard (WCAG 2.1.1).
    <section className="table-scroll" tabIndex={0} aria-label={label}>
      {children}
    </section>
  );
}

export function StatusBadge({ status }: { status: string }) {
  const [tone, label] = STATUS[status] ?? ["neutral", status];
  return <Badge tone={tone}>{label}</Badge>;
}

export function Alerts({ alerts }: { alerts: Alert[] }) {
  if (alerts.length === 0) return <span className="muted">None</span>;
  return (
    <ul className="alerts">
      {alerts.map((a) => (
        <li key={a.text}>
          {a.href ? (
            <Link className="alert-link" href={a.href}>
              <Badge tone={a.tone}>{a.text}</Badge>
            </Link>
          ) : (
            <Badge tone={a.tone}>{a.text}</Badge>
          )}
        </li>
      ))}
    </ul>
  );
}

interface StatTileProps {
  label: string;
  value: ReactNode;
  detail?: ReactNode;
  children?: ReactNode;
}

export function StatTile({ label, value, detail, children }: StatTileProps) {
  return (
    <div className="tile">
      <p className="tile-label">{label}</p>
      <p className="tile-value">{value}</p>
      {children}
      {detail && <p className="tile-detail">{detail}</p>}
    </div>
  );
}

interface KpiCardProps {
  icon: IconName;
  label: string;
  value: ReactNode;
  detail?: ReactNode;
  // A change against an earlier period, with what it compares ("+12% on the 30 days before").
  trend?: { change: string; against: string };
  // A sparkline or similar picture of the figure; hidden from assistive tech, the words carry it.
  chart?: ReactNode;
  link?: { href: string; label: string };
}

// The dashboard's headline figures: an icon, the number and what it is, a small chart, and the
// change against an earlier period where the data has one.
export function KpiCard({ icon, label, value, detail, trend, chart, link }: KpiCardProps) {
  const up = trend?.change.startsWith("+");
  const down = trend?.change.startsWith("−");
  return (
    <div className="kpi">
      <div className="kpi-top">
        <span className="kpi-icon">
          <Icon name={icon} size={22} />
        </span>
        {chart}
      </div>
      <p className="kpi-value">{value}</p>
      <p className="kpi-label">{label}</p>
      {trend && (
        <p className="kpi-trend">
          <span aria-hidden="true">{up ? "▲" : down ? "▼" : "●"}</span> {trend.change} <span className="muted">{trend.against}</span>
        </p>
      )}
      {detail && <p className="kpi-detail">{detail}</p>}
      {link && (
        <p className="kpi-detail">
          <Link href={link.href}>{link.label}</Link>
        </p>
      )}
    </div>
  );
}

// Spend against a monthly budget, drawn full at 100%. The text beside it carries the number,
// and the "Over budget" badge anything past it, so the bar itself is hidden from screen readers.
export function Meter({ ratio }: { ratio: number }) {
  return (
    <span className="meter" aria-hidden="true">
      <span style={{ width: `${Math.min(ratio, 1) * 100}%` }} />
    </span>
  );
}

interface BudgetCellProps {
  spentCents: number;
  budgetCents: number | null;
  money: (cents: number) => string;
}

export function BudgetCell({ spentCents, budgetCents, money }: BudgetCellProps) {
  if (!budgetCents) return <span className="muted">No budget</span>;
  const ratio = spentCents / budgetCents;
  return (
    <span className="budget">
      <Meter ratio={ratio} />
      <span>
        {formatPercent(ratio)} of {money(budgetCents)}
      </span>
    </span>
  );
}

// Answer relevance with its week-on-week change when it moved noticeably.
export function QualityValue({ quality }: { quality: QualitySummary }) {
  const { trend } = quality;
  const change = trend !== undefined && Math.abs(trend) >= 0.2 ? `${trend > 0 ? "▲" : "▼"} ${Math.abs(trend).toFixed(1)}` : undefined;
  return (
    <span>
      {formatScore(quality.answerRelevance)}
      {change && <span className="trend">{change}</span>}
    </span>
  );
}
