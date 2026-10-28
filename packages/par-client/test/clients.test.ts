// Request shapes for the calls verified against a real account in the M0 spike.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AccountClient, resolveNuaKey } from "../src/account.ts";
import { KbClient } from "../src/kb.ts";
import { KB_ROLE, ZoneClient } from "../src/zone.ts";
import { json, mockFetch, NUA_KEY } from "./helpers.ts";

const ZONE = "aws-us-east-2-1";
const ACCOUNT = "00000000-0000-4000-8000-00000000acc1";
const KB = "00000000-0000-4000-8000-0000000000b1";

describe("resolveNuaKey", () => {
  it("asks the key's own zone authorizer for its account", async () => {
    const { fetch, calls } = mockFetch(() =>
      json({ auth: "nua_key", user: { account_id: ACCOUNT, account_type: "v3enterprise", allow_kb_management: true } }),
    );
    const info = await resolveNuaKey(NUA_KEY, { fetch });
    assert.deepEqual(info, { accountId: ACCOUNT, accountType: "v3enterprise", zone: ZONE, allowKbManagement: true });
    assert.equal(calls[0]!.url, `https://${ZONE}.dp.progress.cloud/api/authorizer/info`);
    assert.equal(calls[0]!.headers["X-NUCLIA-NUAKEY"], `Bearer ${NUA_KEY}`);
  });
});

describe("ZoneClient", () => {
  const client = (fetch: ReturnType<typeof mockFetch>["fetch"]) =>
    new ZoneClient({ zone: ZONE, accountId: ACCOUNT, credential: { kind: "nua", token: NUA_KEY }, fetch });

  it("creates a KB locked to the customer's origins", async () => {
    const { fetch, calls } = mockFetch(() => json({ id: KB }, 201));
    const res = await client(fetch).createKb({ slug: "acme-www", title: "Acme website", allowedOrigins: ["https://www.acme.com"] });
    assert.deepEqual(res, { id: KB });
    assert.equal(calls[0]!.url, `https://${ZONE}.dp.progress.cloud/api/v1/account/${ACCOUNT}/kbs`);
    assert.deepEqual(calls[0]!.body, { slug: "acme-www", title: "Acme website", mode: "kb", allowed_origins: ["https://www.acme.com"] });
  });

  it("refuses inputs the API would reject", async () => {
    const { fetch, calls } = mockFetch(() => json({}));
    await assert.rejects(client(fetch).createKb({ slug: "Acme WWW", title: "x", allowedOrigins: ["https://a.test"] }), /slug/);
    await assert.rejects(client(fetch).createKb({ slug: "acme", title: "x", allowedOrigins: [] }), /at least one origin/);
    await assert.rejects(client(fetch).updateKb(KB, { allowedOrigins: [] }), /at least one origin/);
    assert.equal(calls.length, 0);
  });

  it("issues a role-scoped key in two calls", async () => {
    const { fetch, calls } = mockFetch((call) =>
      call.url.endsWith("/service_accounts") ? json({ id: "sa-1" }, 201) : json({ id: "key-1", token: "t" }, 201),
    );
    const zone = client(fetch);
    const sa = await zone.createServiceAccount(KB, { title: "launchpad-reader", role: KB_ROLE.reader });
    const expires = new Date("2026-11-26T01:35:18.000Z");
    const key = await zone.createServiceAccountKey(KB, sa.id, expires);
    assert.deepEqual(calls[0]!.body, { title: "launchpad-reader", role: "SMEMBER" });
    assert.match(calls[1]!.url, /\/kb\/00000000-[^/]+\/service_account\/sa-1\/keys$/);
    assert.deepEqual(calls[1]!.body, { expires: "2026-11-26T01:35:18.000Z" });
    assert.equal(key.token, "t");
  });

  it("only accepts account-level credentials", () => {
    assert.throws(
      () => new ZoneClient({ zone: ZONE, accountId: ACCOUNT, credential: { kind: "key", token: "k" } }),
      /NUA key or a user-level/,
    );
  });
});

describe("KbClient", () => {
  it("asks synchronously with the X-Synchronous header", async () => {
    const { fetch, calls } = mockFetch(() => json({ answer: "Friday 8:00–14:00." }));
    const kb = new KbClient({ zone: ZONE, kbId: KB, credential: { kind: "key", token: "reader" }, fetch });
    const res = await kb.ask({ query: "Friday hours?", search_configuration: "launchpad-default" });
    assert.equal(res.answer, "Friday 8:00–14:00.");
    assert.equal(calls[0]!.headers["X-Synchronous"], "true");
    assert.equal(calls[0]!.headers["X-NUCLIA-SERVICEACCOUNT"], "Bearer reader");
  });

  it("mints an ephemeral token from the reader key", async () => {
    const { fetch, calls } = mockFetch(() => json({ token: "eph" }, 201));
    const kb = new KbClient({ zone: ZONE, kbId: KB, credential: { kind: "key", token: "reader" }, fetch });
    const before = Date.now();
    const { token, expiresAt } = await kb.mintEphemeralToken(900);
    assert.equal(token, "eph");
    assert.equal(calls[0]!.url, `https://${ZONE}.dp.progress.cloud/api/v1/ephemeral_token`);
    assert.deepEqual(calls[0]!.body, { ttl: 900 });
    assert.ok(expiresAt.getTime() >= before + 900_000);
  });

  it("refuses to mint tokens from anything but a KB key", async () => {
    const kb = new KbClient({ zone: ZONE, kbId: KB, credential: { kind: "ephemeral", token: "e" } });
    await assert.rejects(kb.mintEphemeralToken(60), /service-account key/);
  });

  it("saves search configurations as kind ask", async () => {
    const { fetch, calls } = mockFetch(() => new Response(null, { status: 201 }));
    const kb = new KbClient({ zone: ZONE, kbId: KB, credential: { kind: "key", token: "manager" }, fetch });
    await kb.saveSearchConfig("launchpad-default", { citations: true, top_k: 10, prompt: { system: "Answer from context." } });
    assert.match(calls[0]!.url, /\/search_configurations\/launchpad-default$/);
    assert.deepEqual(calls[0]!.body, {
      kind: "ask",
      config: { query: "", citations: true, top_k: 10, prompt: { system: "Answer from context." } },
    });
  });

  it("reads the NDJSON ask log", async () => {
    const ndjson = '{"id":1,"question":"a","nuclia_tokens":0.1881}\n{"id":2,"question":"b","nuclia_tokens":0.141162}\n';
    const { fetch, calls } = mockFetch(() => new Response(ndjson));
    const kb = new KbClient({ zone: ZONE, kbId: KB, credential: { kind: "key", token: "manager" }, fetch });
    const rows = await kb.askLog({ yearMonth: "2026-10" });
    assert.equal(rows.length, 2);
    assert.equal(rows.reduce((sum, r) => sum + (r.nuclia_tokens ?? 0), 0).toFixed(6), "0.329262");
    assert.equal((calls[0]!.body as { year_month: string }).year_month, "2026-10");
  });
});

describe("AccountClient", () => {
  it("filters usage to one KB with a PAT", async () => {
    const { fetch, calls } = mockFetch(() => json([]));
    await new AccountClient({ pat: "pat", fetch }).usage(ACCOUNT, { from: new Date("2026-10-20T00:00:00Z"), kbId: KB });
    const url = new URL(calls[0]!.url);
    assert.equal(url.pathname, `/api/v1/account/${ACCOUNT}/usage`);
    assert.equal(url.searchParams.get("knowledgebox"), KB);
    assert.equal(url.searchParams.get("from"), "2026-10-20T00:00:00");
    assert.equal(url.searchParams.get("aggregation"), "day");
    assert.equal(calls[0]!.headers.Authorization, "Bearer pat");
  });
});
