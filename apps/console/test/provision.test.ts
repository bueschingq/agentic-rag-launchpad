import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ProvisioningStep } from "@launchpad/db";
import { KbClient, type KeyRole, ZoneClient } from "@launchpad/par-client";
import { json, mockFetch, NUA_KEY, type RecordedCall } from "../../../packages/par-client/test/helpers.ts";
import { latestSteps, type ProvisionStore, type ProvisionTarget, runProvisioning } from "../src/lib/provision.ts";

const ZONE = "aws-us-east-2-1";
const ACCOUNT = "00000000-0000-4000-8000-00000000acc1";
const KB = "00000000-0000-4000-8000-0000000000b1";
const NOW = new Date("2026-10-29T12:00:00Z");

// The zone and KB APIs, enough of them to provision; `fail` answers a call with an error instead.
function fakeApi(fail: (call: RecordedCall) => Response | undefined = () => undefined) {
  return mockFetch((call) => {
    const failed = fail(call);
    if (failed) return failed;
    const path = new URL(call.url).pathname.replace(`/api/v1/account/${ACCOUNT}`, "").replace("/api/v1", "");
    const body = call.body as Record<string, string>;
    if (call.method === "GET" && path === "/kbs") return json([]);
    if (call.method === "POST" && path === "/kbs") return json({ id: KB }, 201);
    if (call.method === "GET" && path === `/kb/${KB}/service_accounts`) return json([]);
    if (call.method === "POST" && path === `/kb/${KB}/service_accounts`) return json({ id: `sa-${body.title}` }, 201);
    const key = /^\/kb\/[^/]+\/service_account\/([^/]+)\/keys$/.exec(path);
    if (call.method === "POST" && key) return json({ id: `key-${key[1]}`, token: `token-${key[1]}` }, 201);
    if (call.method === "POST" && /^\/kb\/[^/]+\/search_configurations\/launchpad-default(?:-[a-z]+)?$/.test(path))
      return new Response(null, { status: 201 });
    if (call.method === "POST" && path === `/kb/${KB}/invite`) return new Response(null, { status: 200 });
    return json({ detail: `unexpected ${call.method} ${path}` }, 404);
  });
}

// An in-memory deployment row.
function memoryStore(start: { kbId?: string; keys?: Partial<Record<KeyRole, string>> } = {}) {
  const state = {
    kbId: start.kbId ?? null,
    keys: { ...start.keys } as Partial<Record<KeyRole, string>>,
    log: [] as ProvisioningStep[],
    statuses: [] as string[],
  };
  const store: ProvisionStore = {
    saveKbId: async (kbId) => {
      state.kbId = kbId;
    },
    keyFor: async (role) => state.keys[role],
    storeKey: async (role, key) => {
      state.keys[role] = key.token;
    },
    log: async (step) => {
      state.log.push(step);
    },
    setStatus: async (status) => {
      state.statuses.push(status);
    },
  };
  return { state, store };
}

function deps(fetch: ReturnType<typeof mockFetch>["fetch"], store: ProvisionStore) {
  return {
    zone: new ZoneClient({ zone: ZONE, accountId: ACCOUNT, credential: { kind: "nua", token: NUA_KEY }, fetch }),
    kb: (kbId: string, token: string) => new KbClient({ zone: ZONE, kbId, credential: { kind: "key", token }, fetch }),
    store,
    now: () => NOW,
  };
}

const target = (over: Partial<ProvisionTarget> = {}): ProvisionTarget => ({
  name: "Harbor View Dental",
  kbId: null,
  kbSlug: "harbor-view-harborview-example",
  domains: ["https://www.harborview.example"],
  language: "es",
  systemPrompt: "Be brief.",
  contacts: [{ email: "ana@harborview.example", kbRole: "contributor" }],
  log: [],
  ...over,
});

describe("runProvisioning", () => {
  it("creates the KB, three keys, the prompt and the invites, then goes live", async () => {
    const { fetch, calls } = fakeApi();
    const { state, store } = memoryStore();
    const result = await runProvisioning(target(), deps(fetch, store));

    assert.equal(result.status, "live");
    assert.deepEqual(
      result.steps.map((s) => [s.step, s.status]),
      [
        ["kb", "ok"],
        ["keys", "ok"],
        ["prompt", "ok"],
        ["invite ana@harborview.example", "ok"],
        ["live", "ok"],
      ],
    );
    assert.equal(state.kbId, KB);
    assert.deepEqual(state.keys, {
      reader: "token-sa-launchpad-reader",
      writer: "token-sa-launchpad-writer",
      manager: "token-sa-launchpad-manager",
    });
    assert.deepEqual(state.statuses, ["provisioning", "live"]);

    const created = calls.find((c) => c.method === "POST" && c.url.endsWith("/kbs"))!;
    assert.deepEqual((created.body as { allowed_origins: string[] }).allowed_origins, ["https://www.harborview.example"]);
    const roles = calls
      .filter((c) => c.url.endsWith("/service_accounts") && c.method === "POST")
      .map((c) => (c.body as { role: string }).role);
    assert.deepEqual(roles, ["SMEMBER", "SCONTRIBUTOR", "SOWNER"]);
    const keyBody = calls.find((c) => c.url.endsWith("/keys"))!.body as { expires: string };
    assert.equal(keyBody.expires, "2027-10-29T12:00:00.000Z");

    const prompt = calls.find((c) => c.url.includes("/search_configurations/"))!;
    assert.equal(prompt.headers["X-NUCLIA-SERVICEACCOUNT"], "Bearer token-sa-launchpad-manager");
    assert.match(JSON.stringify(prompt.body), /Always answer in Spanish/);
    // The intent configurations beside it, so a new chat routes from the start.
    const saved = calls.filter((c) => c.url.includes("/search_configurations/")).map((c) => c.url.split("/").at(-1));
    assert.deepEqual(saved, [
      "launchpad-default",
      ...["price", "buy", "trial", "events", "support", "contact"].map((i) => `launchpad-default-${i}`),
    ]);
    const invite = calls.find((c) => c.url.endsWith("/invite"))!;
    assert.deepEqual(invite.body, { email: "ana@harborview.example", role: "SCONTRIBUTOR" });
    // Nothing secret goes into the log.
    assert.doesNotMatch(JSON.stringify(state.log), /token-/);
  });

  it("stops at a failed step and resumes from it without redoing earlier ones", async () => {
    const failing = fakeApi((call) =>
      call.url.endsWith("/service_account/sa-launchpad-writer/keys") ? json({ detail: "Quota exceeded" }, 429) : undefined,
    );
    const { state, store } = memoryStore();
    const first = await runProvisioning(target(), deps(failing.fetch, store));
    assert.equal(first.status, "failed");
    assert.deepEqual(first.steps.at(-1)?.step, "keys");
    assert.match(first.steps.at(-1)?.detail ?? "", /429: Quota exceeded/);
    assert.deepEqual(Object.keys(state.keys), ["reader"]);
    assert.deepEqual(state.statuses, ["provisioning", "failed"]);

    // The retry reuses the KB and the service account the failed run created.
    const retry = mockFetch((call) => {
      if (call.method === "GET" && call.url.endsWith("/service_accounts"))
        return json([{ id: "sa-launchpad-writer", title: "launchpad-writer", role: "SCONTRIBUTOR", keys: [] }]);
      return fakeApi().fetch(call.url, { method: call.method, body: JSON.stringify(call.body) });
    });
    const second = await runProvisioning(target({ kbId: state.kbId, log: state.log }), deps(retry.fetch, store));
    assert.equal(second.status, "live");
    assert.deepEqual(second.steps[0], { step: "kb", status: "skipped", at: NOW.toISOString(), detail: "already created" });
    assert.equal(second.steps[1]?.detail, "writer, manager");
    assert.equal(retry.calls.filter((c) => c.method === "POST" && c.url.endsWith("/kbs")).length, 0);
    assert.deepEqual(
      retry.calls.filter((c) => c.method === "POST" && c.url.endsWith("/service_accounts")).map((c) => (c.body as { title: string }).title),
      ["launchpad-manager"],
    );
    assert.deepEqual(state.statuses.at(-1), "live");
  });

  it("goes live even when an invite fails, and retries only that invite", async () => {
    const contacts = [
      { email: "ana@harborview.example", kbRole: "contributor" as const },
      { email: "sam@harborview.example", kbRole: "owner" as const },
    ];
    const api = fakeApi((call) =>
      call.url.endsWith("/invite") && (call.body as { email: string }).email.startsWith("sam")
        ? json({ detail: "User not found" }, 404)
        : undefined,
    );
    const { state, store } = memoryStore();
    const result = await runProvisioning(target({ contacts }), deps(api.fetch, store));
    assert.equal(result.status, "live");
    assert.deepEqual(
      latestSteps(state.log)
        .filter((s) => s.step.startsWith("invite"))
        .map((s) => [s.step, s.status]),
      [
        ["invite ana@harborview.example", "ok"],
        ["invite sam@harborview.example", "failed"],
      ],
    );

    const again = fakeApi();
    await runProvisioning(target({ contacts, kbId: state.kbId, log: state.log }), deps(again.fetch, store));
    assert.deepEqual(
      again.calls.filter((c) => c.url.endsWith("/invite")).map((c) => (c.body as { email: string }).email),
      ["sam@harborview.example"],
    );
    assert.equal(latestSteps(state.log).find((s) => s.step === "invite sam@harborview.example")?.status, "ok");
  });

  it("adopts a KB a crashed run created under the same slug", async () => {
    const api = fakeApi((call) =>
      call.method === "GET" && call.url.endsWith("/kbs") ? json([{ id: KB, slug: "harbor-view-harborview-example" }]) : undefined,
    );
    const { state, store } = memoryStore();
    const result = await runProvisioning(target(), deps(api.fetch, store));
    assert.equal(result.steps[0]?.detail, "adopted harbor-view-harborview-example");
    assert.equal(state.kbId, KB);
    assert.equal(api.calls.filter((c) => c.method === "POST" && c.url.endsWith("/kbs")).length, 0);
  });
});
