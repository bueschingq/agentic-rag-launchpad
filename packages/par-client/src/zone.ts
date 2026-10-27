// Account-scoped calls on a zone: KBs, service accounts, keys, invites.
// Works with the partner's NUA key (allow_kb_management) or a PAT; verified with a NUA key in M0.

import type { Credential } from "./credentials.ts";
import { type FetchLike, requestJson, send, zoneApi } from "./http.ts";

export type KbRoleCode = "SOWNER" | "SCONTRIBUTOR" | "SMEMBER";

// Launchpad issues one key per role per KB.
export const KB_ROLE = {
  manager: "SOWNER", // search configs, analytics
  writer: "SCONTRIBUTOR", // Sitefinity connector, ingestion
  reader: "SMEMBER", // mints browser tokens; cannot write (403)
} as const satisfies Record<string, KbRoleCode>;
export type KeyRole = keyof typeof KB_ROLE;

export interface KnowledgeBox {
  id: string;
  slug: string;
  zone: string;
  title: string;
  description?: string | null;
  state: string;
  allowed_origins: string[] | null;
  allowed_ip_addresses?: string[] | null;
  search_configs?: Record<string, unknown>;
  enforce_security?: boolean;
  created?: string;
}

export interface CreateKbInput {
  slug: string;
  title: string;
  description?: string;
  // Drives CORS: only these origins pass preflight. Must be non-empty (an empty list is a 422).
  // Changes take 15–60 s to apply.
  allowedOrigins: string[];
  mode?: "kb" | "agent" | "agent_no_memory";
  learningConfiguration?: Record<string, unknown>;
  enforceSecurity?: boolean;
}

export interface UpdateKbInput {
  title?: string;
  description?: string;
  allowedOrigins?: string[];
  state?: string;
}

export interface ServiceAccount {
  id: string;
  title: string;
  role: KbRoleCode;
  keys: { id: string; created: string; expires: string }[];
}

const SLUG = /^[a-z0-9_-]+$/;

export class ZoneClient {
  readonly zone: string;
  readonly accountId: string;
  readonly #credential: Credential;
  readonly #fetch: FetchLike | undefined;

  constructor(opts: { zone: string; accountId: string; credential: Credential; fetch?: FetchLike }) {
    if (opts.credential.kind !== "nua" && opts.credential.kind !== "user") {
      throw new Error("ZoneClient needs a NUA key or a user-level token (PAT).");
    }
    this.zone = opts.zone;
    this.accountId = opts.accountId;
    this.#credential = opts.credential;
    this.#fetch = opts.fetch;
  }

  listKbs(): Promise<KnowledgeBox[]> {
    return requestJson<KnowledgeBox[]>(this.#url("/kbs"), this.#opts());
  }

  async createKb(input: CreateKbInput): Promise<{ id: string }> {
    if (!SLUG.test(input.slug)) throw new Error(`KB slug must match ${SLUG}: ${input.slug}`);
    if (input.allowedOrigins.length === 0) throw new Error("allowedOrigins must list at least one origin.");
    return requestJson<{ id: string }>(this.#url("/kbs"), {
      ...this.#opts(),
      body: {
        slug: input.slug,
        title: input.title,
        description: input.description,
        mode: input.mode ?? "kb",
        allowed_origins: input.allowedOrigins,
        learning_configuration: input.learningConfiguration,
        enforce_security: input.enforceSecurity,
      },
    });
  }

  getKb(kbId: string): Promise<KnowledgeBox> {
    return requestJson<KnowledgeBox>(this.#url(`/kb/${kbId}`), this.#opts());
  }

  async updateKb(kbId: string, patch: UpdateKbInput): Promise<void> {
    if (patch.allowedOrigins?.length === 0) throw new Error("allowedOrigins must list at least one origin.");
    await send(this.#url(`/kb/${kbId}`), {
      ...this.#opts(),
      method: "PATCH",
      body: {
        title: patch.title,
        description: patch.description,
        allowed_origins: patch.allowedOrigins,
        state: patch.state,
      },
    });
  }

  // Permanent. Not exercised in M0.
  async deleteKb(kbId: string): Promise<void> {
    await send(this.#url(`/kb/${kbId}`), { ...this.#opts(), method: "DELETE" });
  }

  createServiceAccount(kbId: string, input: { title: string; role: KbRoleCode }): Promise<{ id: string }> {
    return requestJson<{ id: string }>(this.#url(`/kb/${kbId}/service_accounts`), { ...this.#opts(), body: input });
  }

  createServiceAccountKey(kbId: string, serviceAccountId: string, expires: Date): Promise<{ id: string; token: string }> {
    return requestJson<{ id: string; token: string }>(this.#url(`/kb/${kbId}/service_account/${serviceAccountId}/keys`), {
      ...this.#opts(),
      body: { expires: expires.toISOString() },
    });
  }

  listServiceAccounts(kbId: string): Promise<ServiceAccount[]> {
    return requestJson<ServiceAccount[]>(this.#url(`/kb/${kbId}/service_accounts`), this.#opts());
  }

  async deleteServiceAccountKey(kbId: string, serviceAccountId: string, keyId: string): Promise<void> {
    await send(this.#url(`/kb/${kbId}/service_account/${serviceAccountId}/key/${keyId}`), { ...this.#opts(), method: "DELETE" });
  }

  async deleteServiceAccount(kbId: string, serviceAccountId: string): Promise<void> {
    await send(this.#url(`/kb/${kbId}/service_account/${serviceAccountId}`), { ...this.#opts(), method: "DELETE" });
  }

  // Not exercised in M0.
  async inviteToKb(kbId: string, input: { email: string; role: KbRoleCode }): Promise<void> {
    await send(this.#url(`/kb/${kbId}/invite`), { ...this.#opts(), body: input });
  }

  #url(path: string): string {
    return `${zoneApi(this.zone)}/account/${this.accountId}${path}`;
  }

  #opts() {
    return { credential: this.#credential, fetch: this.#fetch };
  }
}
