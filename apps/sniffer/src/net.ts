// The sniffer fetches URLs that console users type in. These checks keep it from being
// pointed at the partner's own network (SSRF): public http(s) on standard ports only, every
// resolved address must be public, and every redirect is re-checked.
//
// DNS can still change between our check and the browser's own lookup (rebinding), so the
// sniffer container also runs on a network with no route to Postgres or the console's
// internals (docker-compose.yml).

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { gunzipSync } from "node:zlib";

export class UnsafeUrlError extends Error {
  override name = "UnsafeUrlError";
}

const V4_BLOCKED: [string, number][] = [
  ["0.0.0.0", 8], // "this network"
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8],
  ["169.254.0.0", 16], // link-local, incl. cloud metadata 169.254.169.254
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, broadcast
];

const v4ToInt = (ip: string) => ip.split(".").reduce((acc, octet) => ((acc << 8) | Number(octet)) >>> 0, 0);

function inV4Range(ip: string, [base, bits]: [string, number]): boolean {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (v4ToInt(ip) & mask) === (v4ToInt(base) & mask);
}

// Eight 16-bit groups; handles "::" and a trailing dotted IPv4.
function v6Groups(ip: string): number[] | undefined {
  let s = ip.split("%")[0]!.toLowerCase();
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(s)?.[1];
  if (dotted) {
    const n = v4ToInt(dotted);
    s = s.slice(0, -dotted.length) + `${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const [head, tail] = s.split("::") as [string, string | undefined];
  const parts = (p: string) => (p ? p.split(":").map((h) => Number.parseInt(h, 16)) : []);
  const left = parts(head);
  const right = tail === undefined ? [] : parts(tail);
  const groups = tail === undefined ? left : [...left, ...new Array(8 - left.length - right.length).fill(0), ...right];
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : undefined;
}

const embeddedV4 = (g: number[]) => [g[6]! >>> 8, g[6]! & 0xff, g[7]! >>> 8, g[7]! & 0xff].join(".");

export function isPublicAddress(ip: string): boolean {
  if (isIP(ip) === 4) return !V4_BLOCKED.some((range) => inV4Range(ip, range));
  const g = v6Groups(ip);
  if (!g) return false;
  const [a, b] = [g[0]!, g[1]!];
  const zeroPrefix = (n: number) => g.slice(0, n).every((x) => x === 0);
  if (zeroPrefix(8)) return false; // ::
  if (zeroPrefix(7) && g[7] === 1) return false; // ::1
  if (zeroPrefix(5) && g[5] === 0xffff) return isPublicAddress(embeddedV4(g)); // ::ffff:a.b.c.d
  if (zeroPrefix(6)) return false; // deprecated IPv4-compatible
  if (a === 0x64 && b === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return isPublicAddress(embeddedV4(g)); // NAT64 64:ff9b::/96
  if ((a & 0xfe00) === 0xfc00) return false; // fc00::/7 unique local
  if ((a & 0xffc0) === 0xfe80 || (a & 0xffc0) === 0xfec0) return false; // link-local, site-local
  if ((a & 0xff00) === 0xff00) return false; // multicast
  if (a === 0x2001 && b === 0x0db8) return false; // documentation
  if (a === 0x2002) return false; // 6to4 can tunnel to anything
  if (a === 0x0100 && g.slice(1, 4).every((x) => x === 0)) return false; // discard 100::/64
  return true;
}

export type Resolver = (host: string) => Promise<string[]>;
const systemResolver: Resolver = async (host) => (await lookup(host, { all: true, verbatim: true })).map((r) => r.address);

const PRIVATE_SUFFIX = /(^|\.)(localhost|local|internal|intranet|lan|home\.arpa|corp)$/i;

// Development only: SNIFFER_ALLOW_LOOPBACK=1 lets the sniffer load test pages on this machine
// (localhost, any port). Never set it where the sniffer could reach anything else private.
const loopbackAllowed = () => process.env.SNIFFER_ALLOW_LOOPBACK === "1";
const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1"]);

export async function assertPublicUrl(raw: string, resolve: Resolver = systemResolver): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeUrlError("Not a valid URL.");
  }
  if (loopbackAllowed() && LOOPBACK.has(url.hostname.replace(/^\[|\]$/g, "")) && /^https?:$/.test(url.protocol)) return url;
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new UnsafeUrlError("Only http and https URLs can be scanned.");
  if (url.username || url.password) throw new UnsafeUrlError("URLs with credentials can't be scanned.");
  if (url.port && url.port !== "80" && url.port !== "443") throw new UnsafeUrlError("Only standard ports (80, 443) can be scanned.");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (PRIVATE_SUFFIX.test(host)) throw new UnsafeUrlError("Internal host names can't be scanned.");

  let addresses: string[];
  try {
    addresses = isIP(host) ? [host] : await resolve(host);
  } catch {
    throw new UnsafeUrlError("The host name does not resolve.");
  }
  if (addresses.length === 0) throw new UnsafeUrlError("The host name does not resolve.");
  if (!addresses.every(isPublicAddress)) throw new UnsafeUrlError("The host resolves to a private or reserved address.");
  return url;
}

export interface FetchedText {
  url: string;
  status: number;
  text: string;
  // The response's headers (lower-case names): what bot-protection detection reads.
  headers: Record<string, string>;
  // A 429 or 503's Retry-After, in milliseconds, when it gives one.
  retryAfterMs?: number;
}

// Retry-After as milliseconds: seconds ("120") or an HTTP date. Undefined when it says neither. Pure.
export function retryAfterMs(value: string | null | undefined, now = Date.now()): number | undefined {
  const raw = value?.trim();
  if (!raw) return undefined;
  if (/^\d+$/.test(raw)) return Number(raw) * 1000;
  const at = Date.parse(raw);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

// fetch() with every hop re-checked, a size cap and a timeout. A gzipped body (a .gz sitemap served
// as a file, without Content-Encoding) is decompressed; fetch already undoes Content-Encoding.
export async function safeFetchText(
  raw: string,
  opts: { maxBytes?: number; maxRedirects?: number; timeoutMs?: number; resolve?: Resolver; fetch?: typeof fetch } = {},
): Promise<FetchedText> {
  const { maxBytes = 5_000_000, maxRedirects = 3, timeoutMs = 10_000 } = opts;
  let current = raw;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const url = await assertPublicUrl(current, opts.resolve);
    const res = await (opts.fetch ?? fetch)(url.href, {
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/xml,text/plain;q=0.9,*/*;q=0.5" },
    });
    const location = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && location) {
      await res.body?.cancel();
      current = new URL(location, url).href;
      continue;
    }
    const headers: Record<string, string> = {};
    res.headers.forEach((value, name) => {
      headers[name.toLowerCase()] = value;
    });
    const wait = res.status === 429 || res.status === 503 ? retryAfterMs(res.headers.get("retry-after")) : undefined;
    return {
      url: url.href,
      status: res.status,
      text: decodeBody(await readCapped(res, maxBytes), maxBytes * 10),
      headers,
      ...(wait !== undefined && { retryAfterMs: wait }),
    };
  }
  throw new UnsafeUrlError("Too many redirects.");
}

// The body as text, gunzipped first when it's gzip (its first two bytes), up to maxOutput bytes.
export function decodeBody(body: Buffer, maxOutput = 60_000_000): string {
  if (body.length >= 2 && body[0] === 0x1f && body[1] === 0x8b) {
    try {
      return new TextDecoder().decode(gunzipSync(body, { maxOutputLength: maxOutput }));
    } catch (err) {
      throw new Error(`A gzipped body couldn't be read: ${err instanceof Error ? err.message : err}`);
    }
  }
  return new TextDecoder().decode(body);
}

async function readCapped(res: Response, maxBytes: number): Promise<Buffer> {
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new Error(`Response larger than ${maxBytes} bytes.`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

export const USER_AGENT = "LaunchpadSniffer/0.1 (+https://github.com/; theme and sitemap scan)";
