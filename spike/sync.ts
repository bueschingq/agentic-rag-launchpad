// Content sync spike: can the console sync a site's pages into a KB as link resources, read
// from the page's main content? Measures processing time and checks slug idempotency,
// reprocessing, listing and the extracted text. Creates its own KB and deletes it at the end.
//
//   node --env-file=.env spike/sync.ts <page url> [<page url> …] [--selector main] [--keep]

import { createHash } from "node:crypto";
import { KB_ROLE, KbClient, ParError, resolveNuaKey, ZoneClient, zoneApi } from "@launchpad/par-client";

const args = process.argv.slice(2);
const selector = args.includes("--selector") ? args[args.indexOf("--selector") + 1] : undefined;
const keep = args.includes("--keep");
const pages = args.filter((a) => a.startsWith("http"));
const nua = process.env.PAR_NUA_KEY;
if (!nua || !pages.length) throw new Error("Set PAR_NUA_KEY and pass page URLs.");

const info = await resolveNuaKey(nua);
const zone = new ZoneClient({ zone: info.zone, accountId: info.accountId, credential: { kind: "nua", token: nua } });
const SLUG = "launchpad-sync-spike";
const t0 = Date.now();
const since = () => `${((Date.now() - t0) / 1000).toFixed(1)} s`;

const existing = (await zone.listKbs()).find((k) => k.slug === SLUG);
const kbId =
  existing?.id ?? (await zone.createKb({ slug: SLUG, title: "Launchpad sync spike", allowedOrigins: ["https://www.example.com"] })).id;
console.log(`${since()} KB ${kbId} (${existing ? "reused" : "created"})`);

const sa = await zone.createServiceAccount(kbId, { title: `spike-writer-${Date.now()}`, role: KB_ROLE.writer });
const key = await zone.createServiceAccountKey(kbId, sa.id, new Date(Date.now() + 86_400_000));
const kb = new KbClient({ zone: info.zone, kbId, credential: { kind: "key", token: key.token } });
const base = `${zoneApi(info.zone)}/kb/${kbId}`;
const headers = { "X-NUCLIA-SERVICEACCOUNT": `Bearer ${key.token}`, "Content-Type": "application/json" };
const raw = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text.slice(0, 600) };
};

const slugFor = (url: string) => `page-${createHash("sha256").update(url).digest("hex").slice(0, 24)}`;
const created: { url: string; rid: string; at: number }[] = [];
for (const url of pages) {
  const at = Date.now();
  try {
    const { uuid } = await kb.createResource({ slug: slugFor(url), title: url, originUrl: url, link: { uri: url, cssSelector: selector } });
    created.push({ url, rid: uuid, at });
    console.log(`${since()} queued ${url} → ${uuid}`);
  } catch (err) {
    console.log(`${since()} create failed for ${url}: ${err instanceof ParError ? `${err.status} ${err.message}` : err}`);
  }
}

// Same slug again: does the API refuse it (409), and can we reprocess by slug?
const again = await raw("POST", "/resources", { slug: slugFor(pages[0]!), title: pages[0], links: { link: { uri: pages[0] } } });
console.log(`${since()} same slug again → ${again.status} ${again.body.slice(0, 160)}`);

// Poll until every resource is processed or errored (5 min cap).
const done = new Map<string, string>();
while (done.size < created.length && Date.now() - t0 < 300_000) {
  for (const c of created) {
    if (done.has(c.rid)) continue;
    const r = await kb.getResource(c.rid, ["basic"]);
    const status = r.metadata?.status ?? "?";
    if (status === "PROCESSED" || status === "ERROR") {
      done.set(c.rid, status);
      console.log(`${since()} ${status} after ${((Date.now() - c.at) / 1000).toFixed(1)} s: ${c.url} (title: ${r.title})`);
    }
  }
  if (done.size < created.length) await new Promise((r) => setTimeout(r, 2000));
}

for (const c of created) {
  const errors = await raw("GET", `/resource/${c.rid}?show=errors&show=basic`);
  const why = /"errors?":({[^}]*}|[[^]]*])/.exec(errors.body)?.[0] ?? /"error":{[^}]*}/.exec(errors.body)?.[0];
  if (done.get(c.rid) === "ERROR") console.log(`error detail (${c.url}): ${why ?? errors.body.slice(0, 400)}`);
  const r = await raw("GET", `/resource/${c.rid}?show=extracted&extracted=text`);
  const match = /"text":"((?:[^"\\]|\\.){0,240})/.exec(r.body);
  console.log(`extracted (${c.url}): ${match?.[1] ?? r.body.slice(0, 200)}`);
}

const list = await raw("GET", "/resources?page=0&size=5");
console.log(`list → ${list.status} ${list.body.slice(0, 300)}`);
const reprocess = await raw("POST", `/slug/${slugFor(pages[0]!)}/reprocess`);
console.log(`reprocess by slug → ${reprocess.status} ${reprocess.body.slice(0, 160)}`);

// Can the writer key ask? (If not, answers need the reader key.)
try {
  const answer = await kb.ask({ query: "What is this page about?", citations: true });
  console.log(`ask with writer key → ${String(answer.answer).slice(0, 300)}`);
} catch (err) {
  console.log(`ask with writer key → ${err instanceof ParError ? err.status : err}`);
}

if (!keep) {
  await zone.deleteKb(kbId);
  console.log(`${since()} KB deleted`);
}
