// Account-level lookups. The Account API (accounts.progress.cloud) only accepts user-level
// tokens: NUA keys get 403 "Nuakeys are not valid in the global API". A NUA key can still
// tell us its own account through the zone's authorizer.

import { nuaZone } from "./credentials.ts";
import { ACCOUNTS_API, apiDateTime, type FetchLike, requestJson, zoneOrigin } from "./http.ts";

export interface NuaKeyInfo {
  accountId: string;
  accountType: string;
  zone: string;
  allowKbManagement: boolean;
}

// Same lookup the Nuclia SDK does in NucliaAuth.nua(): GET {zone}/api/authorizer/info.
export async function resolveNuaKey(nuaKey: string, opts: { fetch?: FetchLike } = {}): Promise<NuaKeyInfo> {
  const zone = nuaZone(nuaKey);
  if (!zone) throw new Error("Not a NUA key: its issuer is not a *.dp.progress.cloud zone.");
  const info = await requestJson<{ user?: { account_id?: string; account_type?: string; allow_kb_management?: boolean } }>(
    `${zoneOrigin(zone)}/api/authorizer/info`,
    { credential: { kind: "nua", token: nuaKey }, fetch: opts.fetch },
  );
  const accountId = info?.user?.account_id;
  if (!accountId) throw new Error("The authorizer did not return an account for this NUA key.");
  return {
    accountId,
    accountType: info.user?.account_type ?? "unknown",
    zone,
    allowKbManagement: info.user?.allow_kb_management === true,
  };
}

export interface Account {
  id: string;
  slug: string;
  title: string;
  type: string;
  current_kbs: number;
  max_kbs: number;
  blocking_state?: string;
  limits?: { usage?: Record<string, number>; upload?: Record<string, number> };
  [key: string]: unknown;
}

export type Aggregation = "hour" | "day" | "week" | "month" | "quarter" | "year" | "millennium";

export interface UsageBucket {
  timestamp: string;
  metrics: { name: string; value: number; details?: unknown[] }[];
}

export class AccountClient {
  readonly #pat: string;
  readonly #fetch: FetchLike | undefined;

  constructor(opts: { pat: string; fetch?: FetchLike }) {
    this.#pat = opts.pat;
    this.#fetch = opts.fetch;
  }

  getAccount(slugOrId: string): Promise<Account> {
    return requestJson<Account>(`${ACCOUNTS_API}/account/${encodeURIComponent(slugOrId)}`, this.#opts());
  }

  // Not yet verified against a real PAT (M0 had only a NUA key). Metric names map to contract rates.
  usage(accountId: string, q: { from: Date; to?: Date; aggregation?: Aggregation; kbId?: string }): Promise<UsageBucket[]> {
    return requestJson<UsageBucket[]>(`${ACCOUNTS_API}/account/${accountId}/usage`, {
      ...this.#opts(),
      query: {
        from: apiDateTime(q.from),
        to: q.to && apiDateTime(q.to),
        aggregation: q.aggregation ?? "day",
        knowledgebox: q.kbId,
      },
    });
  }

  #opts() {
    return { credential: { kind: "user", token: this.#pat } as const, fetch: this.#fetch };
  }
}
