// End-to-end check of content sync, as the worker runs it, against a real Knowledge Box: a
// throwaway database, a temporary KB with a writer key, one deployment, then worker runs every
// 10 s until every page is answerable. Asks one question at the end, then deletes the KB.
//
//   DATABASE_URL=<throwaway> SNIFFER_URL=http://localhost:4101 \
//     node --env-file=.env spike/sync-e2e.ts <site> [--budget 15] [--include /path] [--question "…"]

import { contentPages, createDb, deployments, parseMasterKey, storeKey, syncSources, tenants } from "@launchpad/db";
import { KB_ROLE, KbClient, resolveNuaKey, ZoneClient } from "@launchpad/par-client";
import { eq, sql } from "drizzle-orm";
import { syncContent } from "../apps/worker/src/jobs/content.ts";
import { snifferClient } from "../apps/worker/src/sniffer.ts";

const args = process.argv.slice(2);
const opt = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const site = args.find((a) => a.startsWith("http"));
const budget = Number(opt("--budget") ?? 15);
const include = opt("--include");
const question = opt("--question") ?? "What does this organization offer?";
const nua = process.env.PAR_NUA_KEY;
const plain = snifferClient();
// Logs what each sniffer call asked for and how long it took.
const sniffer = plain && {
  listPages: async (...a: Parameters<typeof plain.listPages>) => {
    const t = Date.now();
    console.log(`sniffer list → ${process.env.SNIFFER_URL} ${JSON.stringify(a)}`);
    try {
      return await plain.listPages(...a);
    } finally {
      console.log(`sniffer list took ${Date.now() - t} ms`);
    }
  },
  fetchPages: async (urls: string[]) => {
    const t = Date.now();
    try {
      return await plain.fetchPages(urls);
    } finally {
      console.log(`sniffer fetched ${urls.length} pages in ${Date.now() - t} ms`);
    }
  },
};
if (!site || !nua || !sniffer || !process.env.DATABASE_URL)
  throw new Error("Pass a site; set PAR_NUA_KEY, SNIFFER_URL/TOKEN, DATABASE_URL.");

const t0 = Date.now();
const since = () => `${((Date.now() - t0) / 1000).toFixed(0).padStart(4)} s`;
const { db, close } = createDb(process.env.DATABASE_URL, { max: 2 });
const masterKey = parseMasterKey(process.env.LAUNCHPAD_MASTER_KEY);
const log = (m: string) => console.log(`${since()} ${m}`);

const info = await resolveNuaKey(nua);
const zone = new ZoneClient({ zone: info.zone, accountId: info.accountId, credential: { kind: "nua", token: nua } });
const slug = `launchpad-sync-e2e-${Date.now().toString(36)}`;
const { id: kbId } = await zone.createKb({ slug, title: "Launchpad sync check", allowedOrigins: [new URL(site).origin] });
log(`KB ${kbId} created`);
try {
  const sa = await zone.createServiceAccount(kbId, { title: "launchpad-writer", role: KB_ROLE.writer });
  const key = await zone.createServiceAccountKey(kbId, sa.id, new Date(Date.now() + 86_400_000));

  const [tenant] = await db.insert(tenants).values({ name: "Sync check", slug }).returning({ id: tenants.id });
  const [d] = await db
    .insert(deployments)
    .values({
      tenantId: tenant!.id,
      name: "Sync check",
      siteUrl: site,
      domains: [new URL(site).origin],
      contentPath: "sitemap",
      zone: info.zone,
      kbId,
      kbSlug: slug,
      status: "live",
    })
    .returning({ id: deployments.id });
  await storeKey(db, masterKey, {
    deploymentId: d!.id,
    role: "writer",
    serviceAccountId: sa.id,
    keyId: key.id,
    token: key.token,
    expiresAt: new Date(Date.now() + 86_400_000),
  });
  await db.insert(syncSources).values({
    deploymentId: d!.id,
    kind: "sitemap",
    pageBudget: budget,
    includePatterns: include ? [include] : [],
    lastJobStatus: "queued",
  });

  const ctx = { db, masterKey, log: (m: string) => log(`[worker] ${m}`) };
  let firstIndexed: string | undefined;
  for (let run = 0; run < 60; run++) {
    await syncContent(ctx, sniffer);
    const rows = await db
      .select({ status: contentPages.status, n: sql<number>`count(*)`.mapWith(Number) })
      .from(contentPages)
      .where(eq(contentPages.deploymentId, d!.id))
      .groupBy(contentPages.status);
    const counts = Object.fromEntries(rows.map((r) => [r.status, r.n]));
    const [source] = await db.select().from(syncSources).where(eq(syncSources.deploymentId, d!.id));
    log(
      `run ${run + 1}: sync ${source?.lastJobStatus} (${source?.discovery ?? "?"}, ${source?.pagesFound ?? "?"} found) pages ${JSON.stringify(counts)}`,
    );
    if (counts.indexed && !firstIndexed) firstIndexed = since();
    if (source?.lastJobStatus !== "running" && !counts.queued && !counts.processing) break;
    await new Promise((r) => setTimeout(r, 10_000));
  }
  log(`first page answerable at ${firstIndexed ?? "never"}`);

  const pages = await db.select().from(contentPages).where(eq(contentPages.deploymentId, d!.id));
  for (const p of pages)
    console.log(
      `  ${p.status.padEnd(10)} ${String(p.words).padStart(5)} words  ${p.title ?? ""}  ${p.url}${p.detail ? `  (${p.detail})` : ""}`,
    );

  const kb = new KbClient({ zone: info.zone, kbId, credential: { kind: "key", token: key.token } });
  const answer = await kb.ask({ query: question, citations: true, show: ["basic", "origin"] });
  log(`Q: ${question}\n     A: ${String(answer.answer).slice(0, 500)}`);
  const cited = Object.values((answer.retrieval_results?.resources ?? {}) as Record<string, { title?: string; origin?: { url?: string } }>)
    .slice(0, 3)
    .map((r) => `${r.title} <${r.origin?.url}>`);
  log(`sources: ${cited.join(" · ")}`);
} finally {
  await zone.deleteKb(kbId);
  log("KB deleted");
  await close();
}
