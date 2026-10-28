// M0 spike: verify the Agentic RAG API assumptions in docs/DESIGN.md §4 against a real account.
//
//   node spike/m0.ts <step> [--force]
//
// Steps run in order with `all`. Each step saves ids to spike/out/state.json and keys to
// spike/out/secrets.json (mode 600), logs every call to spike/out/calls.jsonl with secrets
// redacted, and appends what it learned to spike/out/findings.md.

import {
  ACCOUNTS_API,
  type Auth,
  call,
  clip,
  type Env,
  isoDaysAgo,
  loadEnv,
  note,
  type Role,
  readSecrets,
  readState,
  type State,
  saveSecret,
  saveState,
  sleep,
  stream,
  zoneApi,
} from "./lib.ts";

export const BROWSER_ORIGIN = "http://localhost:4173";
const SEARCH_CONFIG = "launchpad-default";
const ROLE_CODE: Record<Role, string> = { reader: "SMEMBER", writer: "SCONTRIBUTOR", manager: "SOWNER" };

let env: Env;
let pat: Auth | null; // Account API needs a user-level token
let admin: Auth; // zone API: the PAT if we have one, else the NUA key
let adminName: string;

// ---------- steps ----------

async function whoami() {
  if (!pat) return whoamiNua();
  await call("GET", `${ACCOUNTS_API}/user`, { auth: pat, label: "PAT identifies a user" });
  const accounts = await call("GET", `${ACCOUNTS_API}/accounts`, { auth: pat });
  if (!accounts.ok) throw new Error("The Account API rejected the PAT.");
  const list: any[] = Array.isArray(accounts.json) ? accounts.json : (accounts.json?.accounts ?? []);
  const acct = env.account ? list.find((a) => a.id === env.account || a.slug === env.account) : list.length === 1 ? list[0] : undefined;
  if (!acct) {
    console.log(list.map((a) => `  ${a.slug}  ${a.id}  ${a.type ?? ""}`).join("\n"));
    throw new Error(
      env.account ? `Account ${env.account} is not visible to this PAT.` : "Several accounts are visible; set PAR_ACCOUNT in .env.",
    );
  }

  const detail = await call("GET", `${ACCOUNTS_API}/account/${acct.slug ?? acct.id}`, { auth: pat });
  const d = detail.json ?? {};
  note(
    `Account ${d.slug} (${d.id}) type=${d.type} KBs ${d.current_kbs}/${d.max_kbs}, agents ${d.current_agents}/${d.max_agents}, ` +
      `users ${d.current_users}/${d.max_users}, blocking=${d.blocking_state}`,
  );
  if (d.limits) note(`Account limits: ${JSON.stringify(d.limits)}`);

  const accountId = d.id ?? acct.id;
  const zones = await call("GET", `${ACCOUNTS_API}/account/${accountId}/zones`, { auth: pat });
  const zoneList: string[] = (Array.isArray(zones.json) ? zones.json : (zones.json?.zones ?? [])).map((z: any) =>
    typeof z === "string" ? z : (z.slug ?? z.id ?? z.name),
  );
  const zone = env.zone ?? zoneList[0];
  if (!zone) throw new Error("No zone found; set PAR_ZONE in .env.");
  saveState({ accountId, accountSlug: d.slug ?? acct.slug, zone });
  note(`Zones for the account: ${zoneList.join(", ") || "(none listed)"}; using ${zone}.`);
}

// Without a PAT there is no Account API: take the zone from the NUA key and find the account id
// by asking the zone API which KBs the key can see.
async function whoamiNua() {
  const nua = env.nua!;
  const z = zoneApi(env.zone!);
  note(`Credential is a NUA key (zone ${nua.zone}, allow_kb_management=true). Account API checks need a Personal Access Token.`);
  const pat403 = await call("GET", `${ACCOUNTS_API}/accounts`, { auth: { user: nua.token }, quiet: true });
  note(`NUA key sent as a bearer token to the Account API → ${pat403.status}: ${clip(pat403.text, 120)}`);

  // Same lookup the Nuclia SDK does in NucliaAuth.nua(): the issuer's authorizer tells us the account.
  const info = await call("GET", `https://${nua.zone}.dp.progress.cloud/api/authorizer/info`, { auth: admin, label: "NUA key → account" });
  const u = info.json?.user ?? {};
  if (info.ok) note(`NUA key belongs to account ${u.account_id} (account_type=${u.account_type}).`);
  const candidates = [...new Set([env.account, u.account_id, nua.subject].filter(Boolean) as string[])];
  for (const id of candidates) {
    const r = await call("GET", `${z}/account/${id}/kbs`, { auth: admin, label: `account-scoped KB list, account=${id}` });
    if (r.ok) {
      saveState({ accountId: id, zone: env.zone });
      const kbs = Array.isArray(r.json) ? r.json : (r.json?.kbs ?? []);
      return note(`NUA key works on the zone API for account ${id}; ${kbs.length} existing KB(s).`);
    }
  }
  throw new Error(`Could not find an account id the NUA key accepts (tried ${candidates.join(", ")}). Set PAR_ACCOUNT in .env.`);
}

async function kb() {
  const s = need("accountId", "zone");
  const z = zoneApi(s.zone!);
  if (s.kbId) {
    console.log(`Spike KB already exists: ${s.kbSlug} (${s.kbId}).`);
    await call("GET", `${z}/account/${s.accountId}/kb/${s.kbId}`, { auth: admin, label: "read back KB" });
    return;
  }
  const slug = `launchpad-spike-${new Date().toISOString().slice(0, 16).replace(/\D/g, "")}`;
  const res = await call("POST", `${z}/account/${s.accountId}/kbs`, {
    auth: admin,
    label: `create KB with ${adminName}`,
    body: {
      slug,
      title: "Launchpad M0 spike",
      description: "Created by spike/m0.ts to verify provisioning APIs. Safe to delete.",
      mode: "kb",
      allowed_origins: [BROWSER_ORIGIN],
    },
  });
  if (!res.ok) {
    note(`KB creation with the ${adminName} failed: ${res.status} ${clip(res.text, 300)}`);
    return;
  }
  const kbId = res.json?.id ?? res.json?.uuid;
  saveState({ kbId, kbSlug: slug });
  note(`${adminName} created KB ${slug} (${kbId}) on the zone API, with allowed_origins set at creation.`);
  const back = await call("GET", `${z}/account/${s.accountId}/kb/${kbId}`, { auth: admin, label: "read back KB" });
  if (back.ok) note(`KB read-back: state=${back.json?.state}, allowed_origins=${JSON.stringify(back.json?.allowed_origins)}`);
}

async function keys() {
  const s = need("accountId", "zone", "kbId");
  const base = `${zoneApi(s.zone!)}/account/${s.accountId}/kb/${s.kbId}`;
  const sas = { ...s.serviceAccounts };
  for (const role of ["reader", "writer", "manager"] as Role[]) {
    if (readSecrets()[role]) {
      console.log(`${role} key already saved, skipping.`);
      continue;
    }
    if (!sas[role]) {
      const r = await call("POST", `${base}/service_accounts`, {
        auth: admin,
        body: { title: `launchpad-${role}`, role: ROLE_CODE[role] },
      });
      if (!r.ok) {
        note(`Creating the ${role} service account with the ${adminName} failed: ${r.status} ${clip(r.text, 300)}`);
        return;
      }
      sas[role] = r.json.id;
      saveState({ serviceAccounts: sas });
    }
    const expires = new Date(Date.now() + 30 * 86_400_000).toISOString();
    const k = await call("POST", `${base}/service_account/${sas[role]}/keys`, { auth: admin, body: { expires } });
    if (!k.ok || !k.json?.token) {
      note(`Creating the ${role} key failed: ${k.status} ${clip(k.text, 300)}`);
      return;
    }
    saveSecret(role, k.json.token);
  }
  await call("GET", `${base}/service_accounts`, { auth: admin, label: "list service accounts" });
  note(`${adminName} created reader (SMEMBER), writer (SCONTRIBUTOR) and manager (SOWNER) service accounts, each with a 30-day key.`);
}

const DOCS = [
  {
    slug: "hours",
    title: "Opening hours",
    url: "https://example.com/hours",
    body: "Harbor View Dental is open Monday to Thursday 8:00 to 18:00 and Friday 8:00 to 14:00. We are closed on weekends. Emergency appointments are available on Saturdays from 9:00 to 12:00, booked by phone only.",
  },
  {
    slug: "insurance",
    title: "Insurance and payment",
    url: "https://example.com/insurance",
    body: "Harbor View Dental accepts Delta Dental, Cigna, Aetna and MetLife PPO plans. We do not accept HMO plans. For treatments over $500, payment plans are available through CareCredit.",
  },
  {
    slug: "new-patients",
    title: "New patients",
    url: "https://example.com/new-patients",
    body: "New patients should arrive 15 minutes early and bring a photo ID, their insurance card and a list of current medications. The first visit includes a cleaning, full X-rays and an exam, and takes about 90 minutes.",
  },
];

async function content() {
  const s = need("zone", "kbId");
  const writer: Auth = { sa: secret("writer") };
  const kbBase = `${zoneApi(s.zone!)}/kb/${s.kbId}`;
  const rids = [...(s.resources ?? [])];
  if (!rids.length) {
    for (const d of DOCS) {
      const r = await call("POST", `${kbBase}/resources`, {
        auth: writer,
        body: { slug: d.slug, title: d.title, origin: { url: d.url }, texts: { body: { body: d.body, format: "PLAIN" } } },
      });
      if (r.ok) rids.push(r.json?.uuid ?? r.json?.id);
    }
    saveState({ resources: rids });
  }
  const started = Date.now();
  for (;;) {
    const statuses = await Promise.all(
      rids.map((rid) => call("GET", `${kbBase}/resource/${rid}?show=basic`, { auth: writer, quiet: true })),
    );
    const st = statuses.map((x) => x.json?.metadata?.status ?? `http ${x.status}`);
    const secs = Math.round((Date.now() - started) / 1000);
    console.log(`  +${secs}s  ${st.join(", ")}`);
    if (st.every((x) => x === "PROCESSED")) {
      note(`Writer key added ${rids.length} text resources; all PROCESSED about ${secs}s after the check started.`);
      return;
    }
    if (st.some((x) => x === "ERROR")) return note(`Resource processing reported ERROR: ${st.join(", ")}`);
    if (secs > 300) return note(`Resources still not processed after 5 minutes: ${st.join(", ")}`);
    await sleep(5000);
  }
}

async function searchconfig() {
  const s = need("zone", "kbId");
  const url = `${zoneApi(s.zone!)}/kb/${s.kbId}/search_configurations/${SEARCH_CONFIG}`;
  const body = {
    kind: "ask",
    config: {
      query: "",
      citations: true,
      top_k: 10,
      rag_strategies: [{ name: "neighbouring_paragraphs", before: 1, after: 1 }],
      prompt: {
        system:
          "You are the website assistant for this organization. Answer only from the provided context. " +
          "If the context does not contain the answer, say so and suggest contacting the organization. " +
          "Keep answers under 120 words.",
      },
    },
  };
  const r = await tryAuths("POST", url, body, [
    ["manager key", { sa: secret("manager") }],
    [adminName, admin],
  ]);
  if (r) saveState({ searchConfig: SEARCH_CONFIG });
  await call("GET", `${zoneApi(s.zone!)}/kb/${s.kbId}/search_configurations`, { auth: { sa: secret("manager") } });
}

async function ask() {
  const s = need("zone", "kbId");
  const reader: Auth = { sa: secret("reader") };
  const url = `${zoneApi(s.zone!)}/kb/${s.kbId}/ask`;
  const body = { query: "Do you take Aetna, and when are you open on Friday?", search_configuration: s.searchConfig };

  const sync = await call("POST", url, { auth: reader, body, headers: { "X-Synchronous": "true" }, label: "reader key, synchronous" });
  if (sync.ok) note(`Reader key /ask (sync, ${sync.ms} ms): ${clip(String(sync.json?.answer ?? ""), 300)}`);

  summarizeStream(await stream(url, { auth: reader, body }), "reader key, streaming");

  const write = await call("POST", `${zoneApi(s.zone!)}/kb/${s.kbId}/resources`, {
    auth: reader,
    body: { title: "should be rejected" },
    label: "reader key must not write",
  });
  note(`Reader key attempting a write → ${write.status} (expect 403).`);

  const rag = await call("POST", `https://${s.zone}.rag.progress.cloud/api/v1/kb/${s.kbId}/ask`, {
    auth: reader,
    body,
    headers: { "X-Synchronous": "true" },
    quiet: true,
  });
  note(`Same /ask on ${s.zone}.rag.progress.cloud instead of .dp. → ${rag.status}.`);
}

async function tokens() {
  const s = need("accountId", "zone", "kbId");
  const z = zoneApi(s.zone!);
  const reader: Auth = { sa: secret("reader") };
  const askUrl = `${z}/kb/${s.kbId}/ask`;
  const body = { query: "What should new patients bring?", search_configuration: s.searchConfig };
  const mint = (ttl = 10) => call("POST", `${z}/service_account_temporal_key`, { auth: reader, body: { ttl }, quiet: true });

  // 1. Fresh temporal key.
  const t1 = await mint();
  if (!t1.ok) return note(`Minting a temporal key with the reader key failed: ${t1.status} ${clip(t1.text, 300)}`);
  note(`Temporal key minted from the reader key in ${t1.ms} ms.`);
  const minted = Date.now();
  summarizeStream(await stream(askUrl, { auth: { sa: t1.json.token }, body }), "fresh temporal key");
  note(`That stream ended ${Date.now() - minted} ms after the key was minted (ttl 10 s).`);

  // 2. Start a long answer 8 s after minting: does expiry cut a stream off mid-answer?
  const t2 = await mint();
  await sleep(8000);
  const late = await stream(askUrl, {
    auth: { sa: t2.json.token },
    body: { ...body, query: "Explain every insurance and payment option in detail, plan by plan." },
  });
  summarizeStream(late, "temporal key, request started at +8 s");

  // 3. Expired key.
  const t3 = await mint();
  await sleep(11_500);
  const expired = await call("POST", askUrl, { auth: { sa: t3.json.token }, body, headers: { "X-Synchronous": "true" }, quiet: true });
  note(`Temporal key used 11.5 s after minting → ${expired.status}.`);

  // 4. Ephemeral tokens: the account-scoped endpoint (PAT) and the service-account one.
  const e1 = await call("POST", `${z}/account/${s.accountId}/kb/${s.kbId}/ephemeral_tokens`, {
    auth: admin,
    body: {},
    label: `ephemeral token via ${adminName}`,
  });
  if (e1.ok && e1.json?.token) {
    const viaHeader = await call("POST", askUrl, { auth: { sa: e1.json.token }, body, headers: { "X-Synchronous": "true" }, quiet: true });
    const viaQuery = await call("POST", `${askUrl}?eph-token=${encodeURIComponent(e1.json.token)}`, {
      body,
      headers: { "X-Synchronous": "true" },
      quiet: true,
    });
    note(`Account ephemeral token on /ask: as X-NUCLIA-SERVICEACCOUNT → ${viaHeader.status}; as ?eph-token= → ${viaQuery.status}.`);
  } else {
    note(`Account ephemeral_tokens endpoint with the PAT → ${e1.status}.`);
  }
  const e2 = await call("POST", `${z}/ephemeral_token`, {
    auth: reader,
    body: { ttl: 300 },
    label: "ephemeral token from reader key, ttl 300",
  });
  if (e2.ok && e2.json?.token) {
    const use = await call("POST", askUrl, { auth: { sa: e2.json.token }, body, headers: { "X-Synchronous": "true" }, quiet: true });
    const viaQuery = await call("POST", `${askUrl}?eph-token=${encodeURIComponent(e2.json.token)}`, {
      body,
      headers: { "X-Synchronous": "true" },
      quiet: true,
    });
    note(`SA ephemeral token (ttl 300) on /ask: header → ${use.status}; ?eph-token= → ${viaQuery.status}.`);
  } else {
    note(`/ephemeral_token from the reader key → ${e2.status} ${clip(e2.text, 200)}`);
  }

  // 5. CORS and allowed_origins.
  for (const origin of [BROWSER_ORIGIN, "https://not-allowed.example"]) {
    const pre = await fetch(askUrl, {
      method: "OPTIONS",
      headers: {
        Origin: origin,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type,x-nuclia-serviceaccount",
      },
    });
    const real = await call("POST", askUrl, { auth: reader, body, headers: { Origin: origin, "X-Synchronous": "true" }, quiet: true });
    note(
      `Origin ${origin}: preflight ${pre.status}, allow-origin=${pre.headers.get("access-control-allow-origin") ?? "none"}; ` +
        `POST → ${real.status}, allow-origin=${real.headers.get("access-control-allow-origin") ?? "none"}.`,
    );
  }
}

// Follow-ups from `tokens`: how far an ephemeral token reaches, how long it can live,
// whether expiry cuts a stream, and whether allowed_origins is what drives CORS.
async function ephemeral() {
  const s = need("accountId", "zone", "kbId");
  const z = zoneApi(s.zone!);
  const reader: Auth = { sa: secret("reader") };
  const askUrl = `${z}/kb/${s.kbId}/ask`;
  const body = { query: "What should new patients bring?", search_configuration: s.searchConfig };
  const withEph = (url: string, t: string) => `${url}${url.includes("?") ? "&" : "?"}eph-token=${encodeURIComponent(t)}`;
  const mintEph = (ttl: number, auth: Auth = reader) => call("POST", `${z}/ephemeral_token`, { auth, body: { ttl }, quiet: true });

  // Longest TTL accepted.
  const ttls: string[] = [];
  for (const ttl of [900, 3600, 86_400]) {
    const r = await mintEph(ttl);
    ttls.push(`${ttl}s → ${r.status}`);
  }
  note(`Ephemeral token TTLs from the reader key: ${ttls.join(", ")}.`);

  // Scope: a token minted from the reader key must not write; one from the writer key?
  const eRead = await mintEph(300);
  const writeTry = await call("POST", withEph(`${z}/kb/${s.kbId}/resources`, eRead.json.token), {
    body: { title: "should be rejected" },
    quiet: true,
  });
  const findTry = await call("POST", withEph(`${z}/kb/${s.kbId}/find`, eRead.json.token), { body: { query: "insurance" }, quiet: true });
  const cfgTry = await call("GET", withEph(`${z}/kb/${s.kbId}/search_configurations`, eRead.json.token), { quiet: true });
  note(`Reader-minted ephemeral token: write → ${writeTry.status}, /find → ${findTry.status}, list search configs → ${cfgTry.status}.`);

  // Expiry.
  const short = await mintEph(5);
  await sleep(6500);
  const late = await call("POST", withEph(askUrl, short.json.token), { body, headers: { "X-Synchronous": "true" }, quiet: true });
  note(`Ephemeral token (ttl 5 s) used at +6.5 s → ${late.status}.`);

  // Does a temporal key expiring mid-stream cut the answer? Start at +9.3 s with a long answer.
  const t = await call("POST", `${z}/service_account_temporal_key`, { auth: reader, body: { ttl: 10 }, quiet: true });
  await sleep(9300);
  const longAsk = await stream(askUrl, {
    auth: { sa: t.json.token },
    body: { ...body, query: "Write a detailed guide covering hours, insurance, payment plans and a first visit, with headings." },
  });
  summarizeStream(longAsk, "temporal key, request started at +9.3 s");

  // allowed_origins drives CORS, and changes take a while to apply: add a second origin,
  // time until its preflight passes, then remove it again and time until it is blocked.
  // (An empty list is rejected with 422, so "clearing" is not an option.)
  const preflight = async (origin: string) =>
    (
      await fetch(askUrl, {
        method: "OPTIONS",
        headers: { Origin: origin, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type" },
      })
    ).status;
  const kbUrl = `${z}/account/${s.accountId}/kb/${s.kbId}`;
  const extra = "http://localhost:4174";
  const waitFor = async (want: number) => {
    const t0 = Date.now();
    while (Date.now() - t0 < 180_000) {
      if ((await preflight(extra)) === want) return `${Math.round((Date.now() - t0) / 1000)}s`;
      await sleep(5000);
    }
    return "not within 180s";
  };
  await call("PATCH", kbUrl, { auth: admin, body: { allowed_origins: [BROWSER_ORIGIN, extra] }, label: "add :4174" });
  const added = await waitFor(200);
  await call("PATCH", kbUrl, { auth: admin, body: { allowed_origins: [BROWSER_ORIGIN] }, label: "remove :4174" });
  const removed = await waitFor(403);
  note(`allowed_origins propagation: added origin passed preflight after ${added}; removed origin blocked after ${removed}.`);
}

async function sitemap(args: string[]) {
  const s = need("zone", "kbId");
  if (!env.siteUrl) return note("SPIKE_SITE_URL is not set; skipped the sitemap test.");
  const site = new URL(env.siteUrl);
  const z = zoneApi(s.zone!);

  const html = await fetch(site, { redirect: "follow" })
    .then((r) => r.text())
    .catch(() => "");
  const generator =
    html.match(/<meta[^>]+name=["']generator["'][^>]*content=["']([^"']+)/i)?.[1] ??
    html.match(/<meta[^>]+content=["']([^"']+)["'][^>]*name=["']generator["']/i)?.[1];
  note(`${site.origin}: generator meta = ${generator ?? "none"}.`);

  const robots = await fetch(new URL("/robots.txt", site))
    .then((r) => (r.ok ? r.text() : ""))
    .catch(() => "");
  const listed = [...robots.matchAll(/^sitemap:\s*(\S+)/gim)].map((m) => m[1]);
  const sitemapUrl = s.sitemap?.sitemapUrl ?? listed[0] ?? new URL("/sitemap.xml", site).href;
  const pages = await countSitemap(sitemapUrl);
  note(`Sitemap ${sitemapUrl}${listed.length ? " (from robots.txt)" : ""}: ${pages} page URLs.`);
  if (pages > env.maxPages && !args.includes("--force")) {
    return note(`Stopped: ${pages} pages is over SPIKE_MAX_PAGES=${env.maxPages}. Pick a smaller site or re-run with --force.`);
  }

  const sm = { ...s.sitemap, sitemapUrl };
  const auths: [string, Auth][] = [
    ["manager key", { sa: secret("manager") }],
    [adminName, admin],
  ];
  if (!sm.connectionId) {
    const conn = await tryAuths("POST", `${z}/kb/${s.kbId}/external_connections`, { provider: "sitemap" }, auths);
    if (!conn) return;
    sm.connectionId = conn.res.json?.id;
    sm.auth = conn.name;
    saveState({ sitemap: sm });
  }
  if (!sm.configId) {
    const cfg = await tryAuths(
      "POST",
      `${z}/kb/${s.kbId}/sync_configs`,
      { name: "launchpad-sitemap", external_connection_id: sm.connectionId, sitemap: { url: sitemapUrl } },
      auths,
    );
    if (!cfg) return;
    sm.configId = cfg.res.json?.id;
    sm.auth = cfg.name;
    saveState({ sitemap: sm });
    note(`Sync config created: interval ${cfg.res.json?.sync_interval_minutes ?? "?"} min, provider ${cfg.res.json?.provider ?? "?"}.`);
  }
  const [authName, auth] = auths.find(([n]) => n === sm.auth) ?? auths[0];
  await call("POST", `${z}/kb/${s.kbId}/sync_config/${sm.configId}/sync`, { auth, body: {}, label: `trigger sync (${authName})` });

  const started = Date.now();
  let job: any;
  while (Date.now() - started < 10 * 60_000) {
    const jobs = await call("GET", `${z}/kb/${s.kbId}/sync_config/${sm.configId}/jobs?limit=1`, { auth, quiet: true });
    job = jobs.json?.items?.[0];
    console.log(`  +${Math.round((Date.now() - started) / 1000)}s  job ${job?.id ?? "?"} status=${job?.status ?? "?"}`);
    if (job?.finished_at) break;
    await sleep(10_000);
  }
  if (job) {
    note(`Sync job ${job.status ?? "?"} after ${Math.round((Date.now() - started) / 1000)} s: ${clip(JSON.stringify(job), 500)}`);
    await call("GET", `${z}/kb/${s.kbId}/sync_job/${job.id}/logs`, { auth, label: "job logs" });
  }
  const counters = await call("GET", `${z}/kb/${s.kbId}/counters`, { auth: { sa: secret("reader") }, label: "KB counters" });
  if (counters.ok) note(`KB counters after sync: ${JSON.stringify(counters.json)}`);
}

async function usage() {
  const s = need("accountId", "zone", "kbId");
  const z = zoneApi(s.zone!);
  const from = isoDaysAgo(7);

  if (pat) {
    const perKb = await call("GET", `${ACCOUNTS_API}/account/${s.accountId}/usage?knowledgebox=${s.kbId}&aggregation=day&from=${from}`, {
      auth: pat,
      label: "usage for the spike KB",
    });
    const names = new Map<string, number>();
    for (const bucket of Array.isArray(perKb.json) ? perKb.json : []) {
      for (const m of bucket.metrics ?? []) names.set(m.name, (names.get(m.name) ?? 0) + (Number(m.value) || 0));
    }
    note(`Usage metrics for the spike KB (7 days, summed): ${[...names].map(([k, v]) => `${k}=${v}`).join(", ") || "none returned"}`);
    await call("GET", `${ACCOUNTS_API}/account/${s.accountId}/usage?aggregation=millennium&from=${from}`, {
      auth: pat,
      label: "account total",
    });
  } else {
    const r = await call("GET", `${ACCOUNTS_API}/account/${s.accountId}/usage?knowledgebox=${s.kbId}&aggregation=day&from=${from}`, {
      auth: admin,
      label: "usage with the NUA key",
    });
    note(`Per-KB usage with only a NUA key → ${r.status}. Cost dashboards need a PAT (still to verify).`);
  }

  const auths: [string, Auth][] = [
    [adminName, admin],
    ["manager key", { sa: secret("manager") }],
  ];
  await tryAuths("GET", `${z}/kb/${s.kbId}/activity/metrics?aggregation=day&from=${from}`, undefined, auths);
  await tryAuths("GET", `${z}/kb/${s.kbId}/remi/scores?aggregation=day&from=${from}`, undefined, auths);
  const month = new Date().toISOString().slice(0, 7);
  await tryAuths("POST", `${z}/kb/${s.kbId}/remi/query`, { month, pagination: { limit: 5 } }, auths);
  await tryAuths(
    "POST",
    `${z}/kb/${s.kbId}/activity/ask/query`,
    { year_month: month, show: "all", filters: {}, pagination: { limit: 5 } },
    auths,
  );
}

async function cleanup(args: string[]) {
  const s = need("accountId", "zone", "kbId");
  if (!args.includes("--yes")) {
    console.log(`This permanently deletes the spike KB ${s.kbSlug} (${s.kbId}). Re-run with --yes to confirm.`);
    return;
  }
  const r = await call("DELETE", `${zoneApi(s.zone!)}/account/${s.accountId}/kb/${s.kbId}`, { auth: admin });
  if (r.ok)
    saveState({
      kbId: undefined,
      kbSlug: undefined,
      serviceAccounts: undefined,
      resources: undefined,
      searchConfig: undefined,
      sitemap: undefined,
    });
}

// ---------- helpers ----------

function need(...keys: (keyof State)[]): State {
  const s = readState();
  const missing = keys.filter((k) => !s[k]);
  if (missing.length) throw new Error(`Missing ${missing.join(", ")} in spike/out/state.json. Run the earlier steps first.`);
  return s;
}

function secret(role: Role): string {
  const v = readSecrets()[role];
  if (!v) throw new Error(`No ${role} key saved. Run: node spike/m0.ts keys`);
  return v;
}

// Tries each credential in turn and records which one the endpoint accepts.
async function tryAuths(method: string, url: string, body: unknown, auths: [string, Auth][]) {
  const results: string[] = [];
  for (const [name, auth] of auths) {
    const res = await call(method, url, { auth, body, label: name });
    results.push(`${name} → ${res.status}`);
    if (res.ok) {
      note(`${method} ${new URL(url).pathname}: ${results.join("; ")}`);
      return { name, res };
    }
  }
  note(`${method} ${new URL(url).pathname}: no credential worked (${results.join("; ")})`);
  return undefined;
}

function summarizeStream(st: Awaited<ReturnType<typeof stream>>, label: string) {
  if (!st.ok) return note(`Streaming /ask (${label}) failed: ${st.status} ${st.error}`);
  const types = new Map<string, number>();
  let firstAnswer: number | undefined;
  let answer = "";
  for (const { at, item } of st.lines) {
    const inner = item?.item ?? item;
    const type = inner?.type ?? Object.keys(item ?? {})[0] ?? "?";
    types.set(type, (types.get(type) ?? 0) + 1);
    if (type === "answer") {
      firstAnswer ??= at;
      answer += inner.text ?? "";
    }
  }
  note(
    `Streaming /ask (${label}): ${st.lines.length} NDJSON lines, first answer text at ${firstAnswer ?? "?"} ms, ` +
      `last line at ${st.lines.at(-1)?.at ?? "?"} ms; types ${[...types].map(([k, v]) => `${k}×${v}`).join(", ")}`,
  );
  if (answer) console.log(`    answer: ${clip(answer, 500)}`);
}

async function countSitemap(url: string, depth = 0): Promise<number> {
  const xml = await fetch(url)
    .then((r) => (r.ok ? r.text() : ""))
    .catch(() => "");
  const locs = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1]);
  if (/<sitemapindex/i.test(xml) && depth === 0) {
    let total = 0;
    for (const child of locs.slice(0, 25)) total += await countSitemap(child, 1);
    return total;
  }
  return locs.length;
}

// ---------- main ----------

const STEPS: Record<string, (args: string[]) => Promise<void>> = {
  whoami,
  kb,
  keys,
  content,
  searchconfig,
  ask,
  tokens,
  ephemeral,
  sitemap,
  usage,
  cleanup,
};
const ORDER = ["whoami", "kb", "keys", "content", "searchconfig", "ask", "tokens", "ephemeral", "sitemap", "usage"];

async function main() {
  const [cmd = "help", ...args] = process.argv.slice(2);
  if (cmd !== "all" && !STEPS[cmd]) {
    console.log(`Usage: node spike/m0.ts <${[...ORDER, "all", "cleanup"].join("|")}> [--force] [--yes]`);
    return;
  }
  env = loadEnv();
  pat = env.pat ? { user: env.pat } : null;
  admin = pat ?? { nua: env.nua!.token };
  adminName = pat ? "PAT" : "NUA key";
  for (const step of cmd === "all" ? ORDER : [cmd]) {
    if (cmd === "all") console.log(`\n=== ${step} ===`);
    await STEPS[step](args);
  }
}

main().catch((e) => {
  console.error(`✗ ${e instanceof Error ? e.message : e}`);
  process.exitCode = 1;
});
