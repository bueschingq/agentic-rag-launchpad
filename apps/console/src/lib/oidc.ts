// OpenID Connect sign-in (authorization code with PKCE) for partner staff: Microsoft Entra ID,
// Google, or any provider with discovery. Implemented on node:crypto, with no dependency:
// tokens are verified here (signature against the provider's published keys, issuer,
// audience, expiry and nonce), so nothing in an ID token is trusted unchecked.

import { createHash, createPublicKey, type JsonWebKey, randomBytes, verify } from "node:crypto";

export interface OidcConfig {
  issuer: string;
  clientId: string;
  clientSecret?: string;
  redirectUri: string;
}

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

export interface IdentityClaims {
  subject: string;
  email: string;
  name?: string;
}

export class OidcError extends Error {}

// Reads OIDC_* from the environment; undefined means the console runs on its shared password.
export function oidcConfig(e: NodeJS.ProcessEnv = process.env, publicBaseUrl = "http://localhost:3000"): OidcConfig | undefined {
  const issuer = e.OIDC_ISSUER?.trim().replace(/\/$/, "");
  const clientId = e.OIDC_CLIENT_ID?.trim();
  if (!issuer || !clientId) return undefined;
  return { issuer, clientId, clientSecret: e.OIDC_CLIENT_SECRET?.trim() || undefined, redirectUri: `${publicBaseUrl}/auth/callback` };
}

const b64url = (buf: Buffer) => buf.toString("base64url");
export const randomToken = (bytes = 32) => b64url(randomBytes(bytes));
export const pkceChallenge = (verifier: string) => b64url(createHash("sha256").update(verifier).digest());

const discoveries = new Map<string, Promise<Discovery>>();
const keySets = new Map<string, { at: number; keys: JsonWebKey[] }>();

async function getJson<T>(url: string, fetchImpl: typeof fetch): Promise<T> {
  const res = await fetchImpl(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new OidcError(`${url} answered ${res.status}`);
  return (await res.json()) as T;
}

export function discover(issuer: string, fetchImpl: typeof fetch = fetch): Promise<Discovery> {
  let found = discoveries.get(issuer);
  if (!found) {
    found = getJson<Discovery>(`${issuer}/.well-known/openid-configuration`, fetchImpl).catch((err) => {
      discoveries.delete(issuer);
      throw err;
    });
    discoveries.set(issuer, found);
  }
  return found;
}

export async function authorizationUrl(config: OidcConfig, state: string, nonce: string, verifier: string, fetchImpl?: typeof fetch) {
  const d = await discover(config.issuer, fetchImpl);
  const url = new URL(d.authorization_endpoint);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    scope: "openid email profile",
    state,
    nonce,
    code_challenge: pkceChallenge(verifier),
    code_challenge_method: "S256",
  }).toString();
  return url.href;
}

// Exchanges the code and returns the verified identity.
export async function completeSignIn(
  config: OidcConfig,
  code: string,
  expected: { nonce: string; verifier: string },
  fetchImpl: typeof fetch = fetch,
  now = Date.now(),
): Promise<IdentityClaims> {
  const d = await discover(config.issuer, fetchImpl);
  const res = await fetchImpl(d.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: config.redirectUri,
      client_id: config.clientId,
      code_verifier: expected.verifier,
      ...(config.clientSecret && { client_secret: config.clientSecret }),
    }),
    signal: AbortSignal.timeout(10_000),
  });
  const body = (await res.json().catch(() => ({}))) as { id_token?: string; error?: string; error_description?: string };
  if (!res.ok || !body.id_token) throw new OidcError(`Sign-in was refused: ${body.error_description ?? body.error ?? res.status}`);
  const keys = await jwks(d.jwks_uri, fetchImpl, now);
  return verifyIdToken(body.id_token, { issuer: d.issuer, audience: config.clientId, nonce: expected.nonce, keys, now });
}

async function jwks(uri: string, fetchImpl: typeof fetch, now: number): Promise<JsonWebKey[]> {
  const cached = keySets.get(uri);
  if (cached && now - cached.at < 3_600_000) return cached.keys;
  const { keys } = await getJson<{ keys: JsonWebKey[] }>(uri, fetchImpl);
  keySets.set(uri, { at: now, keys });
  return keys;
}

const ALGORITHMS: Record<string, { hash: string; dsa?: "ieee-p1363" }> = {
  RS256: { hash: "sha256" },
  RS384: { hash: "sha384" },
  RS512: { hash: "sha512" },
  ES256: { hash: "sha256", dsa: "ieee-p1363" },
  ES384: { hash: "sha384", dsa: "ieee-p1363" },
};

// Checks the signature and the claims an ID token must carry for this client.
export function verifyIdToken(
  token: string,
  expected: { issuer: string; audience: string; nonce: string; keys: JsonWebKey[]; now?: number },
): IdentityClaims {
  const parts = token.split(".");
  if (parts.length !== 3) throw new OidcError("The ID token isn't a JWT.");
  const [h, p, s] = parts as [string, string, string];
  const header = JSON.parse(Buffer.from(h, "base64url").toString("utf8")) as { alg?: string; kid?: string };
  const alg = ALGORITHMS[header.alg ?? ""];
  if (!alg) throw new OidcError(`Unsupported ID token algorithm: ${header.alg}`);
  const jwk = expected.keys.find((k) => (header.kid ? (k as { kid?: string }).kid === header.kid : true));
  if (!jwk) throw new OidcError("The provider's keys don't include the one that signed this token.");
  const key = createPublicKey({ key: jwk, format: "jwk" });
  const ok = verify(alg.hash, Buffer.from(`${h}.${p}`), alg.dsa ? { key, dsaEncoding: alg.dsa } : key, Buffer.from(s, "base64url"));
  if (!ok) throw new OidcError("The ID token's signature doesn't match.");

  const claims = JSON.parse(Buffer.from(p, "base64url").toString("utf8")) as Record<string, unknown>;
  const now = Math.floor((expected.now ?? Date.now()) / 1000);
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (claims.iss !== expected.issuer) throw new OidcError("The ID token comes from another issuer.");
  if (!audiences.includes(expected.audience)) throw new OidcError("The ID token is for another application.");
  if (typeof claims.exp !== "number" || claims.exp + 60 < now) throw new OidcError("The ID token has expired.");
  if (claims.nonce !== expected.nonce) throw new OidcError("The ID token's nonce doesn't match this sign-in.");
  // Google marks unverified addresses; Entra's preferred_username is the account's sign-in name.
  if (claims.email_verified === false) throw new OidcError("The account's email address isn't verified.");
  const email = String(claims.email ?? claims.preferred_username ?? "")
    .trim()
    .toLowerCase();
  if (!email.includes("@")) throw new OidcError("The provider didn't share an email address.");
  return { subject: String(claims.sub ?? ""), email, ...(typeof claims.name === "string" && { name: claims.name }) };
}
