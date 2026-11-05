// Provisions one deployment's Knowledge Box, step by step (DESIGN.md §5):
//
//   kb       create the KB, locked to the deployment's domains
//   keys     reader, writer and manager service accounts, a sealed 1-year key each
//   prompt   the "launchpad-default" search config: the partner's prompt + the language rule, and
//            one per intent beside it (launchpad-default-price…), so new chats route from the start
//   invite   each customer contact with KB access, by email
//   live     the deployment starts serving the widget
//
// Every step can run again: one that already happened is skipped, so a retry picks up where a
// failed run stopped. A failed invite is recorded but doesn't hold the deployment back.
// Storage is behind ProvisionStore, so this runs under node:test with a mocked fetch.

import type { ProvisioningStep as Step } from "@launchpad/db";
import { KB_ROLE, type KbClient, type KbRoleCode, type KeyRole, type ZoneClient } from "@launchpad/par-client";
import { intentConfigName, type LanguageSetting, ROUTE_INTENTS } from "@launchpad/theme";
import { labelFilter } from "./content-plan.ts";
import type { KbAccess } from "./customer-form.ts";
import { intentSearchConfig, SEARCH_CONFIG, searchConfigFor } from "./prompt.ts";

export const KEY_DAYS = 365;
const KEY_ROLES: KeyRole[] = ["reader", "writer", "manager"];

export const CONTACT_ROLE: Record<KbAccess, KbRoleCode> = { member: "SMEMBER", contributor: "SCONTRIBUTOR", owner: "SOWNER" };

export interface ProvisionTarget {
  name: string;
  kbId: string | null;
  kbSlug: string;
  domains: string[];
  language: LanguageSetting;
  systemPrompt: string;
  contacts: { email: string; kbRole: KbAccess }[];
  // Earlier runs' steps, so invites that went out aren't sent twice.
  log: Step[];
  // The deployment already has the data augmentation agents on (a resumed run): the configurations
  // keep their generated text out. A new deployment gets them after this run, which re-saves them.
  excludeGenerated?: boolean;
}

export interface ProvisionStore {
  saveKbId(kbId: string): Promise<void>;
  // The newest stored key for the role, decrypted.
  keyFor(role: KeyRole): Promise<string | undefined>;
  storeKey(role: KeyRole, key: { serviceAccountId: string; keyId: string; token: string; expiresAt: Date }): Promise<void>;
  log(step: Step): Promise<void>;
  setStatus(status: "provisioning" | "live" | "failed"): Promise<void>;
}

export interface ProvisionDeps {
  zone: ZoneClient;
  kb: (kbId: string, managerKey: string) => KbClient;
  store: ProvisionStore;
  now?: () => Date;
}

export const inviteStep = (email: string) => `invite ${email}`;

export async function runProvisioning(target: ProvisionTarget, deps: ProvisionDeps): Promise<{ status: "live" | "failed"; steps: Step[] }> {
  const { zone, store } = deps;
  const now = deps.now ?? (() => new Date());
  const steps: Step[] = [];
  const record = async (step: string, status: Step["status"], detail?: string) => {
    const entry: Step = { step, status, at: now().toISOString(), ...(detail ? { detail } : {}) };
    steps.push(entry);
    await store.log(entry);
  };
  const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

  await store.setStatus("provisioning");
  let kbId = target.kbId;
  let current = "kb";
  try {
    if (kbId) await record("kb", "skipped", "already created");
    else {
      // A run that created the KB but died before saving its id left it under our slug.
      const existing = (await zone.listKbs()).find((kb) => kb.slug === target.kbSlug);
      kbId = existing?.id ?? (await zone.createKb({ slug: target.kbSlug, title: target.name, allowedOrigins: target.domains })).id;
      await store.saveKbId(kbId);
      await record("kb", "ok", existing ? `adopted ${target.kbSlug}` : target.kbSlug);
    }

    current = "keys";
    const missing: KeyRole[] = [];
    for (const role of KEY_ROLES) if (!(await store.keyFor(role))) missing.push(role);
    // Service accounts a failed run left behind are reused rather than duplicated.
    const accounts = missing.length ? await zone.listServiceAccounts(kbId) : [];
    for (const role of missing) {
      const title = `launchpad-${role}`;
      const saId =
        accounts.find((sa) => sa.title === title && sa.role === KB_ROLE[role])?.id ??
        (await zone.createServiceAccount(kbId, { title, role: KB_ROLE[role] })).id;
      const expiresAt = new Date(now().getTime() + KEY_DAYS * 86_400_000);
      const key = await zone.createServiceAccountKey(kbId, saId, expiresAt);
      await store.storeKey(role, { serviceAccountId: saId, keyId: key.id, token: key.token, expiresAt });
    }
    await record("keys", missing.length ? "ok" : "skipped", missing.length ? missing.join(", ") : "already stored");

    current = "prompt";
    const managerKey = await store.keyFor("manager");
    if (!managerKey) throw new Error("The manager key is missing.");
    const kb = deps.kb(kbId, managerKey);
    const exclude = target.excludeGenerated ?? false;
    await kb.saveSearchConfig(SEARCH_CONFIG, searchConfigFor(target.systemPrompt, target.language, new Date(), undefined, exclude));
    // The intent configurations too (answers.ts intentSearchConfigs, with no pages synced yet: the
    // page-type labels alone), so a new chat routes price, contact and the other intent questions
    // from its first answer instead of waiting for the rules rollout.
    for (const intent of ROUTE_INTENTS) {
      await kb.saveSearchConfig(
        intentConfigName(SEARCH_CONFIG, intent),
        intentSearchConfig(target.systemPrompt, target.language, intent, labelFilter(intent), new Date(), exclude),
      );
    }
    await record("prompt", "ok", SEARCH_CONFIG);
  } catch (err) {
    await record(current, "failed", message(err));
    await store.setStatus("failed");
    return { status: "failed", steps };
  }

  const invited = new Set(target.log.filter((s) => s.status === "ok").map((s) => s.step));
  for (const contact of target.contacts) {
    const step = inviteStep(contact.email);
    if (invited.has(step)) continue;
    try {
      await zone.inviteToKb(kbId, { email: contact.email, role: CONTACT_ROLE[contact.kbRole] });
      await record(step, "ok", contact.kbRole);
    } catch (err) {
      await record(step, "failed", message(err));
    }
  }

  await store.setStatus("live");
  await record("live", "ok");
  return { status: "live", steps };
}

// The latest outcome of each step, in the order steps first ran: what the deployment page shows.
export function latestSteps(log: Step[]): Step[] {
  const latest = new Map<string, Step>();
  for (const entry of log) latest.set(entry.step, entry);
  return [...latest.values()];
}
