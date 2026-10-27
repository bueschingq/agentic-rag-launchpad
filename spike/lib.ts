// Shared helpers for the M0 spike: env loading, state, and a logging fetch wrapper
// that never prints secrets.

import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const OUT = join(ROOT, "spike", "out");
mkdirSync(OUT, { recursive: true });

export const ACCOUNTS_API = "https://accounts.progress.cloud/api/v1";
export const zoneApi = (zone: string) => `https://${zone}.dp.progress.cloud/api/v1`;

export type Env = {
  pat?: string; // user-level token: Account API + zone API
  nua?: { token: string; zone: string; subject: string }; // zone API only
  account?: string;
  zone?: string;
  siteUrl?: string;
  maxPages: number;
};

const jwtClaims = (token: string): Record<string, any> | undefined => {
  try {
    return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
  } catch {
    return undefined;
  }
};

// Accepts KEY=VALUE lines, or a file holding only the raw token. A NUA key pasted into
// PAR_PAT is detected from its claims and used as PAR_NUA_KEY instead.
export function loadEnv(): Env {
  const path = join(ROOT, ".env");
  if (!existsSync(path)) throw new Error("Missing .env. Copy .env.example to .env and set PAR_PAT.");
  const raw = readFileSync(path, "utf8").trim();
  const vars: Record<string, string> = {};
  const lines = raw.split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith("#"));
  if (lines.length === 1 && !lines[0].includes("=")) {
    vars.PAR_PAT = lines[0].trim();
  } else {
    for (const line of lines) {
      const i = line.indexOf("=");
      if (i < 0) continue;
      vars[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^["']|["']$/g, "");
    }
  }
  const placeholder = (v?: string) => !v || v.startsWith("paste-");
  let pat = placeholder(vars.PAR_PAT) ? undefined : vars.PAR_PAT;
  let nuaToken = placeholder(vars.PAR_NUA_KEY) ? undefined : vars.PAR_NUA_KEY;
  if (pat && "allow_kb_management" in (jwtClaims(pat) ?? {})) {
    nuaToken ??= pat;
    pat = undefined;
  }
  if (!pat && !nuaToken) throw new Error("No token in .env. Set PAR_PAT (Personal Access Token) and/or PAR_NUA_KEY.");

  let nua: Env["nua"];
  if (nuaToken) {
    const c = jwtClaims(nuaToken) ?? {};
    const zone = String(c.iss ?? "").match(/^https:\/\/([^.]+)\.dp\./)?.[1];
    if (!zone) throw new Error("PAR_NUA_KEY does not look like a NUA key (no zone in its issuer).");
    if (!c.allow_kb_management) console.warn("! This NUA key has allow_kb_management=false; KB creation will fail.");
    nua = { token: nuaToken, zone, subject: c.sub };
  }

  const site = vars.SPIKE_SITE_URL;
  return {
    pat,
    nua,
    account: vars.PAR_ACCOUNT || undefined,
    zone: vars.PAR_ZONE || nua?.zone,
    siteUrl: site ? (/^https?:\/\//i.test(site) ? site : `https://${site}`) : undefined,
    maxPages: Number(vars.SPIKE_MAX_PAGES || 100),
  };
}

// ---------- state (ids) and secrets (keys), both under spike/out/ ----------

export type State = {
  accountId?: string;
  accountSlug?: string;
  zone?: string;
  kbId?: string;
  kbSlug?: string;
  serviceAccounts?: Partial<Record<Role, string>>;
  resources?: string[];
  searchConfig?: string;
  sitemap?: { connectionId?: string; configId?: string; sitemapUrl?: string; auth?: string };
};
export type Role = "reader" | "writer" | "manager";
export type Secrets = Partial<Record<Role, string>>;

const statePath = join(OUT, "state.json");
const secretsPath = join(OUT, "secrets.json");

export const readState = (): State => (existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : {});
export function saveState(patch: Partial<State>): State {
  const next = { ...readState(), ...patch };
  writeFileSync(statePath, JSON.stringify(next, null, 2));
  return next;
}
export const readSecrets = (): Secrets => (existsSync(secretsPath) ? JSON.parse(readFileSync(secretsPath, "utf8")) : {});
export function saveSecret(role: Role, token: string) {
  writeFileSync(secretsPath, JSON.stringify({ ...readSecrets(), [role]: token }, null, 2));
  chmodSync(secretsPath, 0o600);
}

// ---------- HTTP ----------

export type Auth =
  | { user: string } // PAT or user key -> Authorization: Bearer
  | { sa: string } // KB API key or temporal key -> X-NUCLIA-SERVICEACCOUNT: Bearer
  | { nua: string } // NUA key -> X-NUCLIA-NUAKEY: Bearer
  | null;

function authHeaders(auth: Auth): Record<string, string> {
  if (!auth) return {};
  if ("user" in auth) return { Authorization: `Bearer ${auth.user}` };
  if ("sa" in auth) return { "X-NUCLIA-SERVICEACCOUNT": `Bearer ${auth.sa}` };
  return { "X-NUCLIA-NUAKEY": `Bearer ${auth.nua}` };
}

export type Res = {
  status: number;
  ok: boolean;
  ms: number;
  json: any;
  text: string;
  headers: Headers;
};

type CallOpts = {
  auth?: Auth;
  body?: unknown;
  headers?: Record<string, string>;
  quiet?: boolean;
  label?: string;
};

export async function call(method: string, url: string, opts: CallOpts = {}): Promise<Res> {
  const headers: Record<string, string> = { ...authHeaders(opts.auth ?? null), ...opts.headers };
  if (opts.body !== undefined) headers["Content-Type"] ??= "application/json";
  const started = performance.now();
  const r = await fetch(url, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await r.text();
  const ms = Math.round(performance.now() - started);
  let json: any = undefined;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {}
  const res: Res = { status: r.status, ok: r.ok, ms, json, text, headers: r.headers };
  record(method, url, opts, res);
  if (!opts.quiet) {
    console.log(`${r.ok ? "✓" : "✗"} ${method} ${redactUrl(url)} → ${r.status} (${ms} ms)${opts.label ? `  [${opts.label}]` : ""}`);
    const preview = json !== undefined ? JSON.stringify(redact(json), null, 2) : text;
    if (preview) console.log(indent(clip(preview, 1800)));
  }
  return res;
}

// Streams an NDJSON response, returning each parsed line with its arrival time.
export async function stream(url: string, opts: CallOpts = {}) {
  const headers: Record<string, string> = {
    ...authHeaders(opts.auth ?? null),
    "Content-Type": "application/json",
    ...opts.headers,
  };
  const started = performance.now();
  const r = await fetch(url, { method: "POST", headers, body: JSON.stringify(opts.body) });
  const lines: { at: number; item: any }[] = [];
  if (!r.ok || !r.body) {
    const text = await r.text();
    record("POST", url, opts, { status: r.status, ok: false, ms: 0, json: undefined, text, headers: r.headers });
    return { status: r.status, ok: false, lines, error: clip(text, 800), headers: r.headers };
  }
  const reader = r.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        lines.push({ at: Math.round(performance.now() - started), item: JSON.parse(line) });
      } catch {
        lines.push({ at: Math.round(performance.now() - started), item: { unparsed: line } });
      }
    }
  }
  if (buf.trim()) lines.push({ at: Math.round(performance.now() - started), item: safeParse(buf.trim()) });
  record("POST", url, opts, { status: r.status, ok: true, ms: lines.at(-1)?.at ?? 0, json: { lines: lines.length }, text: "", headers: r.headers });
  return { status: r.status, ok: true, lines, error: undefined, headers: r.headers };
}

const safeParse = (s: string) => {
  try {
    return JSON.parse(s);
  } catch {
    return { unparsed: s };
  }
};

// ---------- logging that never leaks secrets ----------

const SECRET_KEY = /token|key|secret|password|credential/i;

export function redact(v: any): any {
  if (Array.isArray(v)) return v.map(redact);
  if (v && typeof v === "object") {
    const out: Record<string, any> = {};
    for (const [k, val] of Object.entries(v)) {
      out[k] = SECRET_KEY.test(k) && typeof val === "string" && val.length > 12 ? `${val.slice(0, 4)}…(${val.length} chars)` : redact(val);
    }
    return out;
  }
  if (typeof v === "string" && /^eyJ[\w-]+\.[\w-]+\.[\w-]+$/.test(v)) return `${v.slice(0, 4)}…(jwt, ${v.length} chars)`;
  return v;
}

export const redactUrl = (url: string) => url.replace(/([?&](?:eph-token|token|api_key)=)[^&]+/gi, "$1<redacted>");

function record(method: string, url: string, opts: CallOpts, res: Res) {
  const entry = {
    at: new Date().toISOString(),
    method,
    url: redactUrl(url),
    auth: opts.auth ? Object.keys(opts.auth)[0] : "none",
    reqHeaders: Object.keys(opts.headers ?? {}),
    body: redact(opts.body),
    status: res.status,
    ms: res.ms,
    response: res.json !== undefined ? redact(res.json) : clip(res.text, 2000),
  };
  appendFileSync(join(OUT, "calls.jsonl"), JSON.stringify(entry) + "\n");
}

export function note(finding: string) {
  console.log(`\n▶ ${finding}\n`);
  appendFileSync(join(OUT, "findings.md"), `- ${new Date().toISOString().slice(0, 16)}  ${finding}\n`);
}

export const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}… (+${s.length - n} chars)` : s);
const indent = (s: string) => s.replace(/^/gm, "    ");
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const isoDaysAgo = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString().slice(0, 19);
