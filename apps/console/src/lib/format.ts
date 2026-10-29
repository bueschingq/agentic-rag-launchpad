// Display formatting for the dashboard pages. Pure, like metrics.ts.

const LOCALE = "en-US";

function currencyFormat(currency: string, digits: number): Intl.NumberFormat {
  return new Intl.NumberFormat(LOCALE, { style: "currency", currency, minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function formatMoney(cents: number, currency: string): string {
  return currencyFormat(currency, Math.abs(cents) >= 100_000 ? 0 : 2).format(cents / 100);
}

// Axis ticks: "$2", "$2.50", "$1,000".
export function formatMoneyTick(cents: number, currency: string): string {
  return currencyFormat(currency, cents % 100 === 0 ? 0 : 2).format(cents / 100);
}

export function formatCount(n: number): string {
  return new Intl.NumberFormat(LOCALE, { notation: n >= 10_000 ? "compact" : "standard", maximumFractionDigits: 1 }).format(n);
}

// Nuclia tokens: fractional, so one decimal.
export function formatTokens(n: number): string {
  return new Intl.NumberFormat(LOCALE, { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(n);
}

// REMi averages, 1–5.
export function formatScore(v: number | undefined): string {
  return v === undefined ? "—" : v.toFixed(1);
}

// "+0.3", "−0.6": a change in a score.
export function formatSigned(n: number): string {
  return `${n >= 0 ? "+" : "−"}${Math.abs(n).toFixed(1)}`;
}

export function formatPercent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}

export function formatDay(day: string): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString(LOCALE, { month: "short", day: "numeric", timeZone: "UTC" });
}

export function formatMonth(month: string): string {
  return new Date(`${month}-01T00:00:00Z`).toLocaleDateString(LOCALE, { month: "long", year: "numeric", timeZone: "UTC" });
}

export function formatAgo(then: Date, now: Date): string {
  const days = Math.floor((now.getTime() - then.getTime()) / 86_400_000);
  if (days <= 0) return "today";
  return days === 1 ? "yesterday" : `${days} days ago`;
}

// "+12%" against the previous period; undefined when there is nothing to compare with.
export function formatChange(current: number, previous: number): string | undefined {
  if (previous <= 0) return undefined;
  const change = Math.round(((current - previous) / previous) * 100);
  return `${change > 0 ? "+" : change < 0 ? "−" : "±"}${Math.abs(change)}%`;
}
