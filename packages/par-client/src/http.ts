import { authHeaders, type Credential } from "./credentials.ts";
import { ParError } from "./errors.ts";

export const ACCOUNTS_API = "https://accounts.progress.cloud/api/v1";

export function zoneOrigin(zone: string): string {
  if (!/^[a-z0-9-]+$/.test(zone)) throw new Error(`Invalid zone slug: ${zone}`);
  return `https://${zone}.dp.progress.cloud`;
}

export const zoneApi = (zone: string): string => `${zoneOrigin(zone)}/api/v1`;

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

// Arrays become repeated parameters (?show=basic&show=origin), as the API expects.
export type Query = Record<string, string | number | boolean | string[] | undefined>;

export interface RequestOptions {
  method?: string;
  credential?: Credential | undefined;
  body?: unknown;
  headers?: Record<string, string>;
  query?: Query;
  signal?: AbortSignal | undefined;
  fetch?: FetchLike | undefined;
}

export function buildUrl(url: string, query?: Query, credential?: Credential): string {
  const u = new URL(url);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (Array.isArray(value)) for (const v of value) u.searchParams.append(key, v);
    else if (value !== undefined) u.searchParams.set(key, String(value));
  }
  if (credential?.kind === "ephemeral") u.searchParams.set("eph-token", credential.token);
  return u.toString();
}

// Throws ParError on any non-2xx response.
export async function send(url: string, opts: RequestOptions = {}): Promise<Response> {
  const method = opts.method ?? (opts.body === undefined ? "GET" : "POST");
  const headers: Record<string, string> = { ...authHeaders(opts.credential), ...opts.headers };
  if (opts.body !== undefined) headers["Content-Type"] ??= "application/json";

  const res = await (opts.fetch ?? fetch)(buildUrl(url, opts.query, opts.credential), {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    signal: opts.signal,
  });
  if (!res.ok) throw new ParError(method, url, res.status, await readBody(res));
  return res;
}

export async function requestJson<T>(url: string, opts: RequestOptions = {}): Promise<T> {
  const res = await send(url, opts);
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text().catch(() => "");
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// The API takes naive UTC timestamps to the second, e.g. 2026-10-27T01:35:13.
export const apiDateTime = (d: Date): string => d.toISOString().slice(0, 19);
