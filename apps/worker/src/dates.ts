// UTC day arithmetic for rollups. Agentic RAG logs use naive UTC timestamps.

export const startOfUtcDay = (d: Date): Date => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

export const addDays = (d: Date, n: number): Date => new Date(d.getTime() + n * 86_400_000);

export const isoDate = (d: Date): string => d.toISOString().slice(0, 10);

export const yearMonth = (d: Date): string => d.toISOString().slice(0, 7);

// "2026-10-27 01:35:34.166467" → Date (UTC).
export function parseLogDate(value: string): Date {
  const iso = value.trim().replace(" ", "T");
  return new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? iso : `${iso}Z`);
}

// Contract rate × consumption, in whole cents. Undefined when the partner has not set a rate.
export function costCents(queryTokens: number, ratePerToken: number | undefined): number | undefined {
  return ratePerToken === undefined ? undefined : Math.round(queryTokens * ratePerToken * 100);
}
