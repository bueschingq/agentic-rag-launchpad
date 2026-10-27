// The four ways Agentic RAG authenticates a request, and how each one is sent.
// Sending two of them on one request is rejected by the API.
//
//   nua        X-NUCLIA-NUAKEY: Bearer …          account-scoped zone API: KBs, service accounts, keys
//   user       Authorization: Bearer …            Personal Access Token or user key: Account API + zone API
//   key        X-NUCLIA-SERVICEACCOUNT: Bearer …  a KB service-account key (reader / writer / manager)
//   ephemeral  ?eph-token=…                       short-lived browser token; the header form returns 400

export type Credential =
  | { kind: "nua"; token: string }
  | { kind: "user"; token: string }
  | { kind: "key"; token: string }
  | { kind: "ephemeral"; token: string };

export function authHeaders(credential: Credential | undefined): Record<string, string> {
  switch (credential?.kind) {
    case "nua":
      return { "X-NUCLIA-NUAKEY": `Bearer ${credential.token}` };
    case "user":
      return { Authorization: `Bearer ${credential.token}` };
    case "key":
      return { "X-NUCLIA-SERVICEACCOUNT": `Bearer ${credential.token}` };
    default:
      return {};
  }
}

export function decodeClaims(token: string): Record<string, unknown> | undefined {
  const payload = token.split(".")[1];
  if (!payload) return undefined;
  try {
    const json = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
    const claims: unknown = JSON.parse(json);
    return claims && typeof claims === "object" ? (claims as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

const NUA_ISSUER = /^https:\/\/([a-z0-9-]+)\.dp\.progress\.cloud\/?$/;

// NUA keys are JWTs issued by a zone's data plane and carry `allow_kb_management`.
// Anything else non-empty is treated as a user-level token (PAT or user key).
export function classifyToken(token: string): "nua" | "user" | "empty" {
  if (!token.trim()) return "empty";
  const claims = decodeClaims(token);
  if (claims && typeof claims.iss === "string" && NUA_ISSUER.test(claims.iss) && "allow_kb_management" in claims) return "nua";
  return "user";
}

export function nuaZone(token: string): string | undefined {
  const iss = decodeClaims(token)?.iss;
  return typeof iss === "string" ? NUA_ISSUER.exec(iss)?.[1] : undefined;
}

export function nuaAllowsKbManagement(token: string): boolean {
  return decodeClaims(token)?.allow_kb_management === true;
}
