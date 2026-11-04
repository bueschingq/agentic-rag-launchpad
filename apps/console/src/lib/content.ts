// Database side of a deployment's content: its sync settings and state (the worker does the
// syncing, see apps/worker/src/jobs/content.ts), the pages it synced, and the partner's
// requests (sync now, retry failed, leave a page out, add pages by hand, bring the pages up to
// the current extractor and rules). Every change is audited.

import { createHash } from "node:crypto";
import {
  auditLog,
  type Confirmation,
  type ContentPlanSummary,
  contentPages,
  deployments,
  type KeptPage,
  type PageFacts,
  syncSources,
  users,
} from "@launchpad/db";
import { LANGUAGES } from "@launchpad/theme";
import {
  and,
  asc,
  count,
  countDistinct,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  like,
  lt,
  lte,
  min,
  ne,
  or,
  sql,
} from "drizzle-orm";
import { type ContentSettings, DEFAULT_EXCLUDES, DEFAULT_PAGE_BUDGET, type PlanFormValue } from "./content-form.ts";
import {
  answeringIntents,
  duplicateTarget,
  EXTRACTOR_VERSION,
  fleetRateLimitedNote,
  intentName,
  intentOf,
  isEvergreenUrl,
  isKeyIntent,
  isSitemapAddress,
  KEEP_ASKED,
  KEY_INTENTS,
  type KeepRule,
  type KeyIntent,
  keepAsked,
  keepRule,
  keptKind,
  LEFT_OUT_BY_YOU,
  leaveOutLabel,
  loadedFacts,
  MAX_PINNED,
  matchScore,
  matchWords,
  PAGE_FLAGS,
  type PageFlag,
  PLAN_RULES,
  type PlanEntry,
  type PlanRule,
  pageFlags,
  pageKey,
  pathLanguage,
  pathMatches,
  planRules,
  primaryLanguage,
  publicationStamp,
  questionIntents,
  questionLanguage,
  RATE_LIMITED,
  REREAD,
  type RenderedFacts,
  RULES_VERSION,
  rankPages,
  rateLimitedNote,
  ruleLabel,
  ruleLeaveOut,
  selectPages,
  servedLanguages,
  shownDetail,
  storedFacts,
  storedFlags,
  takesKeyPages,
  unusableForKeys,
  urlDate,
  WOULD_LEAVE_OUT,
} from "./content-plan.ts";
import { db } from "./db.ts";
import type { PromptEvent } from "./prompt.ts";
import { withSetupName } from "./setup-name.ts";
import { isRefusalNote, NO_ANSWER_SQL, noAnswer, retryNote } from "./site-refusal.ts";
import { fetchPages, readSitemapEntries } from "./sniffer.ts";

export { keptSummary, LEFT_OUT_BY_YOU } from "./content-plan.ts";

export type PageStatus = (typeof contentPages.status.enumValues)[number];

// A page's Knowledge Box slug, fixed by its address: the worker's slugFor (its normalizeUrl is
// pageKey), so a page added here is the same resource the sync updates.
export const slugFor = (url: string) => `page-${createHash("sha256").update(pageKey(url)).digest("hex").slice(0, 32)}`;

// The sitemap sync a deployment starts with: the content plan accepted on New deployment, or
// else the default budget and the paths a chatbot should never answer from. The worker starts
// it within a minute.
export async function ensureContentSync(deploymentId: string): Promise<void> {
  await db()
    .insert(syncSources)
    .values({
      deploymentId,
      kind: "sitemap",
      pageBudget: DEFAULT_PAGE_BUDGET,
      excludePatterns: DEFAULT_EXCLUDES,
      lastJobStatus: "queued",
      resyncHours: 24,
    })
    .onConflictDoNothing();
  // A plan applied before provisioning waits, unqueued, for the Knowledge Box: queue it now.
  await db()
    .update(syncSources)
    .set({ lastJobStatus: "queued" })
    .where(and(eq(syncSources.deploymentId, deploymentId), eq(syncSources.kind, "sitemap"), isNull(syncSources.lastJobStatus)));
  await db().update(deployments).set({ contentPath: "sitemap" }).where(eq(deployments.id, deploymentId));
}

// New deployment's content plan becomes the sync's settings before anything can sync: the
// budget, paths and languages, and the ticked suggestions (stored with the plan, which every
// sync applies). Provisioning then queues the first sync (ensureContentSync).
export async function applyPlan(
  deploymentId: string,
  plan: PlanFormValue,
  summary: ContentPlanSummary | undefined,
  actor: string | null,
): Promise<void> {
  const values = {
    pageBudget: plan.pageBudget,
    includePatterns: plan.include,
    excludePatterns: plan.exclude,
    languages: plan.languages,
    // A sitemap address the partner entered is read directly by every sync.
    sitemapUrl: plan.sitemap ?? null,
    plan: summary ?? null,
    lastJobStatus: null,
  };
  await db()
    .insert(syncSources)
    .values({ deploymentId, kind: "sitemap", resyncHours: 24, ...values })
    .onConflictDoUpdate({ target: [syncSources.deploymentId, syncSources.kind], set: values });
  const version = plan.sitefinityVersion === "unknown" || plan.sitefinityVersion === "none" ? null : plan.sitefinityVersion;
  await db().update(deployments).set({ contentPath: "sitemap", sitefinityVersion: version }).where(eq(deployments.id, deploymentId));
  await audit(actor, deploymentId, "content.plan", {
    pageBudget: plan.pageBudget,
    ...(plan.sitemap && { sitemap: plan.sitemap }),
    include: plan.include,
    exclude: plan.exclude,
    languages: plan.languages,
    ...(summary && { total: summary.total, excluded: summary.excluded, oldestTaken: summary.oldestTaken }),
  });
}

export interface ContentSummary {
  source: typeof syncSources.$inferSelect | undefined;
  // Pages per status, as visitors meet them: a page being read again (waiting or processing)
  // that's still in the Knowledge Box counts as indexed (answerable), not waiting, so a serving
  // chat never reads "0 of 227 answerable" (inChatCounts).
  counts: Record<PageStatus, number>;
  // Of those answerable pages, the ones being read again now (rereadNote).
  rereading: number;
  // The pages the sync takes (left-out pages, replaced by others, aren't counted).
  total: number;
  // Every page on the content list, left-out ones included.
  listed: number;
  // The newest problems, for the panel; the full list is on the content page.
  problems: { url: string; title: string | null; status: PageStatus; detail: string | null }[];
  // The oldest page the sync takes (waiting, processing or answerable), by its last-modified day.
  oldestTaken?: string;
  // Other deployments' pages the worker loads before this one's next page, while it waits.
  queueAhead?: number;
  // While it syncs: about how long until every page it takes is answerable.
  estimate?: SyncEstimate;
  // Failed pages that are simply gone from the site (404, 410): not something to act on.
  gone: number;
  // Pages the site rate-limited (waiting to be tried again, or failed for it), and what the header
  // says about them in place of "failed" (rateLimitedNote).
  rateLimited?: number;
  rateLimitedNote?: string;
}

export async function loadContent(deploymentId: string): Promise<ContentSummary> {
  const [source] = await db()
    .select()
    .from(syncSources)
    .where(and(eq(syncSources.deploymentId, deploymentId), eq(syncSources.kind, "sitemap")));
  const rows = await db()
    .select({
      status: contentPages.status,
      n: sql<number>`count(*)`.mapWith(Number),
      inChat: sql<number>`count(*) filter (where ${contentPages.indexedAt} is not null)`.mapWith(Number),
    })
    .from(contentPages)
    .where(eq(contentPages.deploymentId, deploymentId))
    .groupBy(contentPages.status);
  // As the worker sees them (the time left), and as visitors meet them (what's answerable).
  const raw = { queued: 0, processing: 0, indexed: 0, skipped: 0, failed: 0, removed: 0 } as Record<PageStatus, number>;
  for (const r of rows) raw[r.status] = r.n;
  const { counts, rereading } = inChatCounts(rows);
  const [limited] = await db()
    .select({ n: sql<number>`count(*)`.mapWith(Number) })
    .from(contentPages)
    .where(
      and(
        eq(contentPages.deploymentId, deploymentId),
        inArray(contentPages.status, ["queued", "failed", "indexed"]),
        like(contentPages.detail, `${RATE_LIMITED}%`),
      ),
    );
  const [gone] = await db()
    .select({ n: sql<number>`count(*)`.mapWith(Number) })
    .from(contentPages)
    .where(
      and(
        eq(contentPages.deploymentId, deploymentId),
        eq(contentPages.status, "failed"),
        inArray(contentPages.detail, ["The site answered 404.", "The site answered 410."]),
      ),
    );
  const problems = await db()
    .select({ url: contentPages.url, title: contentPages.title, status: contentPages.status, detail: contentPages.detail })
    .from(contentPages)
    .where(and(eq(contentPages.deploymentId, deploymentId), eq(contentPages.status, "failed")))
    .orderBy(desc(contentPages.updatedAt))
    .limit(5);
  const total = counts.queued + counts.processing + counts.indexed + counts.failed;
  // A date stored after today isn't the page's (knownDate): it never stands as the oldest.
  const [oldest] = await db()
    .select({ at: min(contentPages.lastModified) })
    .from(contentPages)
    .where(
      and(
        eq(contentPages.deploymentId, deploymentId),
        inArray(contentPages.status, ["queued", "processing", "indexed"]),
        lte(contentPages.lastModified, new Date(Date.now() + 86_400_000)),
      ),
    );
  const waiting = source && (source.lastJobStatus === "queued" || (source.lastJobStatus === "running" && raw.queued > 0));
  const syncing = source && (source.lastJobStatus === "queued" || source.lastJobStatus === "running");
  const queue = waiting || syncing ? await queueFacts(deploymentId) : undefined;
  let estimate: SyncEstimate | undefined;
  if (syncing && queue) {
    const now = Date.now();
    const shown = shownEstimate(
      deploymentId,
      `${source.lastJobStatus}|${source.startedAt?.toISOString() ?? ""}`,
      syncEstimate(source, raw, queue),
      now,
    );
    estimate = syncEstimate(source, raw, queue, shown, now);
  }
  return {
    source,
    counts,
    rereading,
    total,
    listed: total + counts.skipped,
    problems,
    gone: gone?.n ?? 0,
    ...(oldest?.at && { oldestTaken: oldest.at.toISOString().slice(0, 10) }),
    ...(waiting && queue && { queueAhead: queue.ahead }),
    ...(estimate && { estimate }),
    ...(limited?.n && { rateLimited: limited.n, rateLimitedNote: rateLimitedNote(limited.n, Boolean(syncing)) }),
  };
}

// Pages per status as visitors meet them: a page waiting to be read again, or whose new text
// Agentic RAG is processing, is still answerable from its indexed copy (indexedAt set), so it
// counts as indexed. rereading: how many of those there are. Pure.
export function inChatCounts(rows: readonly { status: PageStatus; n: number; inChat?: number }[]): {
  counts: Record<PageStatus, number>;
  rereading: number;
} {
  const counts = { queued: 0, processing: 0, indexed: 0, skipped: 0, failed: 0, removed: 0 } as Record<PageStatus, number>;
  let rereading = 0;
  for (const r of rows) {
    const moving = r.status === "queued" || r.status === "processing" ? (r.inChat ?? 0) : 0;
    counts[r.status] += r.n - moving;
    counts.indexed += moving;
    rereading += moving;
  }
  return { counts, rereading };
}

// "227 pages being read again; the chat keeps answering from the current copy": while a re-read
// runs, for the deployment page, Content and Bring up to date, in place of a count that falls.
export function rereadNote(content: Pick<ContentSummary, "rereading">): string | undefined {
  const n = content.rereading;
  if (!n) return undefined;
  return `${n.toLocaleString("en")} ${n === 1 ? "page" : "pages"} being read again; the chat keeps answering from the current copy.`;
}

// When each deployment's current "about N min" was first shown, per sync: the same N is never
// shown for longer than N minutes (telerik.com's tail said "about 3 min" for 20). Kept by each
// console process; a restart shows the count afresh.
const estimateStore = globalThis as { __launchpadEstimates?: Map<string, EstimateShown & { run: string }> };
function shownEstimate(deploymentId: string, run: string, estimate: SyncEstimate, now: number): EstimateShown {
  estimateStore.__launchpadEstimates ??= new Map();
  const store = estimateStore.__launchpadEstimates;
  const previous = store.get(deploymentId);
  if (previous && previous.run === run && previous.minutes === estimate.minutes) return previous;
  const next = { run, minutes: estimate.minutes, since: now };
  store.set(deploymentId, next);
  if (store.size > 1000) for (const [id, v] of store) if (now - v.since > 6 * 3_600_000) store.delete(id);
  return next;
}

// The worker's queue order (apps/worker/src/jobs/content.ts queueTier): pages a person added
// by hand, then first syncs, then re-syncs (and re-reads a partner asked for), then the nightly
// re-read; within each, deployments take turns a page at a time.
const queueTier = sql<number>`case
  when ${contentPages.url} = any(${syncSources.pinned}) then 0
  when ${syncSources.lastSyncedAt} is null then 1
  when ${contentPages.detail} = ${REREAD.nightly} then 3
  else 2 end`;

// The worker loads about this many pages a minute when it's busy (PAGES_PER_RUN), and the
// Knowledge Box takes about this long to make a sent page answerable.
const PAGES_PER_MINUTE = 60;
const PROCESSING_MINUTES = 2;
// The window the worker's pace is measured over.
const RECENT_MINUTES = 3;

export interface QueueFacts {
  // Other deployments' pages loaded before this one's next page.
  ahead: number;
  // Other deployments' pages loaded before this one's last page: every page in an earlier tier,
  // and, in its own tier, as many of each other deployment's as this one has (they take turns).
  beforeLast: number;
  // Pages loaded in the last 3 minutes, all deployments: the worker's pace right now (a longer
  // window reads far too slow early in a run, before it has filled).
  recent: number;
}

async function queueFacts(deploymentId: string): Promise<QueueFacts> {
  const rows = await db()
    .select({
      deploymentId: contentPages.deploymentId,
      tier: queueTier.mapWith(Number),
      waiting: sql<number>`count(*)`.mapWith(Number),
      first: min(contentPages.createdAt),
    })
    .from(contentPages)
    .innerJoin(syncSources, and(eq(syncSources.deploymentId, contentPages.deploymentId), eq(syncSources.kind, "sitemap")))
    .where(and(eq(contentPages.status, "queued"), eq(syncSources.lastJobStatus, "running")))
    .groupBy(contentPages.deploymentId, sql`2`);
  const mine = rows.filter((r) => r.deploymentId === deploymentId);
  const tier = mine.length ? Math.min(...mine.map((r) => r.tier)) : 1;
  const myWaiting = mine.reduce((n, r) => n + r.waiting, 0);
  const myFirst = mine.find((r) => r.tier === tier)?.first ?? new Date();
  let ahead = 0;
  let beforeLast = 0;
  for (const r of rows) {
    if (r.deploymentId === deploymentId || r.tier > tier) continue;
    if (r.tier < tier) {
      ahead += r.waiting;
      beforeLast += r.waiting;
    } else {
      if (r.first && r.first < myFirst) ahead += 1;
      beforeLast += Math.min(r.waiting, myWaiting);
    }
  }
  const [recent] = await db()
    .select({ n: sql<number>`count(*)`.mapWith(Number) })
    .from(contentPages)
    .where(and(gte(contentPages.updatedAt, new Date(Date.now() - RECENT_MINUTES * 60_000)), ne(contentPages.status, "queued")));
  return { ahead, beforeLast, recent: recent?.n ?? 0 };
}

export interface SyncEstimate {
  // Pages still to load or still processing.
  pagesLeft: number;
  // About how many minutes until they're all answerable (or left out).
  minutes: number;
  // A first sync, which goes ahead of every re-sync and re-read.
  first: boolean;
  // "about 9 min left", for the checklist and the deployment page.
  text: string;
}

// When a minute count was first shown in this sync.
export interface EstimateShown {
  minutes: number;
  since: number;
}

// The time left in a sync: this deployment's waiting pages and the pages loaded before its
// last one, at the worker's recent pace (never faster than it loads), plus the Knowledge Box's
// processing. A count shown for longer than itself (shown, from loadContent) says so instead of
// repeating: in a sync's tail, pages left out are replaced one at a time. Pure, given the counts.
export function syncEstimate(
  source: Pick<typeof syncSources.$inferSelect, "lastSyncedAt" | "lastJobStatus">,
  counts: Pick<Record<PageStatus, number>, "queued" | "processing">,
  queue: QueueFacts,
  shown?: EstimateShown,
  now = Date.now(),
): SyncEstimate {
  const pagesLeft = counts.queued + counts.processing;
  const pace = queue.recent >= 20 ? Math.min(PAGES_PER_MINUTE, Math.max(10, queue.recent / RECENT_MINUTES)) : PAGES_PER_MINUTE;
  const loading = counts.queued ? (counts.queued + queue.beforeLast) / pace : 0;
  // A sync just queued hasn't listed its pages yet: about a minute to read the sitemaps.
  const listing = source.lastJobStatus === "queued" ? 1 : 0;
  const minutes = pagesLeft || listing ? Math.max(1, Math.ceil(listing + loading + PROCESSING_MINUTES)) : 0;
  const overdue = Boolean(shown && minutes && shown.minutes === minutes && now - shown.since > minutes * 60_000);
  // Before the pages are listed, and once only indexing is left, a minute count would be a guess.
  const text =
    listing && !pagesLeft
      ? "reading the site's sitemaps"
      : !counts.queued && counts.processing
        ? `almost done: Agentic RAG is indexing the last ${counts.processing} page${counts.processing === 1 ? "" : "s"}`
        : minutes
          ? overdue
            ? `taking longer than the ${minutes} min estimated ${Math.floor((now - shown!.since) / 60_000)} min ago`
            : `about ${minutes} min left`
          : "finishing";
  return { pagesLeft, minutes, first: !source.lastSyncedAt, text };
}

// Fleet's and the customer page's "Last sync": during a first sync it's running, not "Never".
// ago formats a past moment ("3 h ago").
export function lastSyncLabel(
  sync: { lastJobStatus: string | null; lastSyncedAt: Date | null } | undefined,
  ago: (at: Date) => string,
): string {
  const running = sync?.lastJobStatus === "running" || sync?.lastJobStatus === "queued";
  if (running && !sync?.lastSyncedAt) return "First sync running";
  if (running && sync?.lastSyncedAt) return `Syncing now (last ${ago(sync.lastSyncedAt)})`;
  return sync?.lastSyncedAt ? ago(sync.lastSyncedAt) : "Never";
}

export function loadPages(deploymentId: string, filter: { status?: PageStatus; flag?: PageFlag } = {}) {
  return db()
    .select({
      id: contentPages.id,
      url: contentPages.url,
      title: contentPages.title,
      status: contentPages.status,
      words: contentPages.words,
      detail: contentPages.detail,
      indexedAt: contentPages.indexedAt,
      updatedAt: contentPages.updatedAt,
      lastModified: contentPages.lastModified,
      publishedAt: contentPages.publishedAt,
      pageModifiedAt: contentPages.pageModifiedAt,
      sitemapLastmod: contentPages.sitemapLastmod,
      lang: contentPages.lang,
      flags: contentPages.flags,
      keyIntent: contentPages.keyIntent,
      facts: contentPages.facts,
    })
    .from(contentPages)
    .where(
      and(
        eq(contentPages.deploymentId, deploymentId),
        filter.status ? eq(contentPages.status, filter.status) : undefined,
        filter.flag ? sql`${filter.flag} = any(${contentPages.flags})` : undefined,
      ),
    )
    .orderBy(asc(contentPages.url))
    .limit(2000);
}

// Pages per flag, for the content list's filters (removed pages left out).
export async function flagCounts(deploymentId: string): Promise<Record<string, number>> {
  const rows = await db()
    .select({ flag: sql<string>`unnest(${contentPages.flags})`, n: sql<number>`count(*)`.mapWith(Number) })
    .from(contentPages)
    .where(and(eq(contentPages.deploymentId, deploymentId), ne(contentPages.status, "removed")))
    .groupBy(sql`1`);
  return Object.fromEntries(rows.map((r) => [r.flag, r.n]));
}

export async function pageText(
  deploymentId: string,
  pageId: string,
): Promise<{ url: string; title: string | null; text: string | null } | undefined> {
  const [row] = await db()
    .select({ url: contentPages.url, title: contentPages.title, text: contentPages.text })
    .from(contentPages)
    .where(and(eq(contentPages.deploymentId, deploymentId), eq(contentPages.id, pageId)));
  return row;
}

async function audit(actor: string | null, deploymentId: string, action: string, detail: Record<string, unknown>) {
  await db()
    .insert(auditLog)
    .values(await withSetupName({ actorUserId: actor, action, targetType: "deployment", targetId: deploymentId, detail }));
}

// A full pass: every listed page is checked again, and only changed text is resent.
export async function requestSync(deploymentId: string, actor: string | null): Promise<void> {
  await ensureContentSync(deploymentId);
  await db()
    .update(syncSources)
    .set({ lastJobStatus: "queued", lastError: null })
    .where(
      and(
        eq(syncSources.deploymentId, deploymentId),
        eq(syncSources.kind, "sitemap"),
        sql`${syncSources.lastJobStatus} is distinct from 'running'`,
      ),
    );
  await audit(actor, deploymentId, "content.sync", {});
}

// Planned pages that aren't in the chat because the site didn't let us read them, with the key pages
// among them, for Review. While a site is refusing, the pages waiting for it count too.
export interface MissingPages {
  missing: number;
  keys: { url: string; intent: KeyIntent }[];
}
export async function missingPages(deploymentId: string, refused: boolean): Promise<MissingPages> {
  const rows = await db()
    .select({ url: contentPages.url, keyIntent: contentPages.keyIntent })
    .from(contentPages)
    .where(
      and(
        eq(contentPages.deploymentId, deploymentId),
        isNull(contentPages.indexedAt),
        or(
          and(
            eq(contentPages.status, "failed"),
            sql`(${contentPages.detail} ~ ${NO_ANSWER_SQL} or ${contentPages.detail} ~ '^The site answered (401|403|405|406|451|5)')`,
          ),
          refused ? eq(contentPages.status, "queued") : undefined,
        ),
      ),
    );
  return {
    missing: rows.length,
    keys: rows.flatMap((r) => (isKeyIntent(r.keyIntent) ? [{ url: r.url, intent: r.keyIntent }] : [])),
  };
}

// Only the failed pages, without listing the site again.
export async function retryFailedPages(deploymentId: string, actor: string | null): Promise<number> {
  const retried = await db()
    .update(contentPages)
    .set({ status: "queued", detail: null })
    .where(and(eq(contentPages.deploymentId, deploymentId), eq(contentPages.status, "failed")))
    .returning({ id: contentPages.id });
  if (retried.length) {
    const [source] = await db()
      .select({ lastError: syncSources.lastError })
      .from(syncSources)
      .where(and(eq(syncSources.deploymentId, deploymentId), eq(syncSources.kind, "sitemap")));
    // A site that stopped answering: the sentence stays and says the retry is slow (the worker paces it).
    await db()
      .update(syncSources)
      .set({
        lastJobStatus: "running",
        startedAt: new Date(),
        lastError: source?.lastError && isRefusalNote(source.lastError) ? retryNote(source.lastError) : null,
      })
      .where(and(eq(syncSources.deploymentId, deploymentId), eq(syncSources.kind, "sitemap")));
  }
  await audit(actor, deploymentId, "content.retry", { pages: retried.length });
  return retried.length;
}

// Leaves a page out for good: its exact path joins the exclude rules, it's no longer added by
// hand or kept, and the next sync takes it out of the KB.
export async function excludePage(deploymentId: string, url: string, actor: string | null): Promise<void> {
  const path = new URL(url).pathname;
  await db()
    .update(syncSources)
    .set({ excludePatterns: sql`array_append(${syncSources.excludePatterns}, ${path})` })
    .where(
      and(
        eq(syncSources.deploymentId, deploymentId),
        eq(syncSources.kind, "sitemap"),
        sql`not (${path} = any(${syncSources.excludePatterns}))`,
      ),
    );
  const [source] = await db()
    .select({ id: syncSources.id, pinned: syncSources.pinned, kept: syncSources.kept })
    .from(syncSources)
    .where(and(eq(syncSources.deploymentId, deploymentId), eq(syncSources.kind, "sitemap")));
  const key = pageKey(url);
  if (source && (source.pinned.some((u) => pageKey(u) === key) || source.kept.some((k) => pageKey(k.url) === key))) {
    await db()
      .update(syncSources)
      .set({ pinned: source.pinned.filter((u) => pageKey(u) !== key), kept: source.kept.filter((k) => pageKey(k.url) !== key) })
      .where(eq(syncSources.id, source.id));
  }
  // Out of the chat now, even while another sync runs (which wouldn't list the pages again): the
  // worker takes it out of the Knowledge Box within a minute (retractLeftOut).
  await db()
    .update(contentPages)
    .set({ status: "removed", detail: LEFT_OUT_BY_YOU })
    .where(
      and(
        eq(contentPages.deploymentId, deploymentId),
        inArray(contentPages.url, [url, ...(key !== url ? [key] : [])]),
        ne(contentPages.status, "removed"),
      ),
    );
  await audit(actor, deploymentId, "content.exclude", { url });
  // A sync starts with the new Leave out, or a running one starts over with it (as saving the
  // content settings does), so it can't put the page back.
  await ensureContentSync(deploymentId);
  await db()
    .update(syncSources)
    .set({ lastJobStatus: "queued", lastError: null })
    .where(and(eq(syncSources.deploymentId, deploymentId), eq(syncSources.kind, "sitemap")));
}

export async function saveContentSettings(
  deploymentId: string,
  siteUrl: string,
  input: ContentSettings,
  actor: string | null,
): Promise<{ restarted: boolean }> {
  await ensureContentSync(deploymentId);
  const [before] = await db()
    .select()
    .from(syncSources)
    .where(and(eq(syncSources.deploymentId, deploymentId), eq(syncSources.kind, "sitemap")));
  const connector = input.path === "sitefinity_connector";
  await db()
    .update(syncSources)
    .set({
      // A sitemap address is read directly; else a start page other than the site's address.
      sitemapUrl: input.sitemap ?? (input.startUrl === siteUrl ? null : input.startUrl),
      pageBudget: input.pageBudget,
      includePatterns: input.include,
      excludePatterns: input.exclude,
      // With Sitefinity's connector pushing content, the sitemap sync stands down. Otherwise a
      // sync starts, or a running one starts over with these rules: the worker lists the pages
      // again and takes out of the Knowledge Box any it already sent that the rules now leave out.
      resyncHours: connector ? null : input.resyncHours,
      ...(connector ? {} : { lastJobStatus: "queued", lastError: null }),
    })
    .where(and(eq(syncSources.deploymentId, deploymentId), eq(syncSources.kind, "sitemap")));
  await db()
    .update(deployments)
    .set({
      contentPath: input.path,
      sitefinityVersion: input.sitefinityVersion === "unknown" || input.sitefinityVersion === "none" ? null : input.sitefinityVersion,
    })
    .where(eq(deployments.id, deploymentId));
  await audit(actor, deploymentId, "content.settings", {
    before: before && {
      startUrl: isSitemapAddress(before.sitemapUrl) ? null : before.sitemapUrl,
      sitemap: isSitemapAddress(before.sitemapUrl) ? before.sitemapUrl : null,
      pageBudget: before.pageBudget,
      include: before.includePatterns,
      exclude: before.excludePatterns,
      resyncHours: before.resyncHours,
    },
    after: input,
  });
  return { restarted: !connector && before?.lastJobStatus === "running" };
}

// Pages per status for several deployments at once (fleet, checklist), as visitors meet them
// (inChatCounts: a page being read again still answers from its indexed copy).
export async function pageCounts(deploymentIds: string[]): Promise<Map<string, Record<string, number>>> {
  const map = new Map<string, Record<string, number>>();
  if (!deploymentIds.length) return map;
  const rows = await db()
    .select({
      id: contentPages.deploymentId,
      status: contentPages.status,
      n: sql<number>`count(*)`.mapWith(Number),
      inChat: sql<number>`count(*) filter (where ${contentPages.indexedAt} is not null)`.mapWith(Number),
    })
    .from(contentPages)
    .where(inArray(contentPages.deploymentId, deploymentIds))
    .groupBy(contentPages.deploymentId, contentPages.status);
  for (const [id, own] of groupRows(rows)) {
    const { counts } = inChatCounts(own);
    map.set(id, Object.fromEntries(Object.entries(counts).filter(([status, n]) => n > 0 || own.some((r) => r.status === status))));
  }
  return map;
}

// The deployment's pages per status as visitors meet them, for validation's "how much is
// answerable" (inChatCounts).
export async function contentCounts(deploymentId: string): Promise<{ counts: Record<PageStatus, number>; rereading: number }> {
  const rows = await db()
    .select({
      status: contentPages.status,
      n: sql<number>`count(*)`.mapWith(Number),
      inChat: sql<number>`count(*) filter (where ${contentPages.indexedAt} is not null)`.mapWith(Number),
    })
    .from(contentPages)
    .where(eq(contentPages.deploymentId, deploymentId))
    .groupBy(contentPages.status);
  return inChatCounts(rows);
}

const groupRows = <T extends { id: string }>(rows: readonly T[]) => {
  const by = new Map<string, T[]>();
  for (const r of rows) by.set(r.id, [...(by.get(r.id) ?? []), r]);
  return by;
};

// ---- bringing pages up to the current extractor and rules (Bring up to date) ----

// Read, and by an older extractor or rules: a page waiting for its first read (a new
// deployment's first sync), or one that failed to load, hasn't been read by anything yet (round 6:
// a deployment minutes old said "140 pages were read under an older extractor"). Pages queued to
// be read again count.
const outdated = and(
  or(lt(contentPages.extractorVersion, EXTRACTOR_VERSION), lt(contentPages.rulesVersion, RULES_VERSION)),
  or(
    inArray(contentPages.status, ["indexed", "skipped", "processing"]),
    inArray(contentPages.detail, [REREAD.nightly, REREAD.now, REREAD.apply]),
  ),
);

// Pages read by an older extractor or older rules: read again in the nightly batch, or now on
// Bring up to date.
export async function pagesOutOfDate(deploymentId: string): Promise<number> {
  const [row] = await db()
    .select({ n: sql<number>`count(*)`.mapWith(Number) })
    .from(contentPages)
    .where(and(eq(contentPages.deploymentId, deploymentId), ne(contentPages.status, "removed"), outdated));
  return row?.n ?? 0;
}

// Pages read under an older extractor or rules, and those of them being read again now: Content
// and Bring up to date offer "Read the pages again" while any wait, whatever the checks the
// deployment was signed off under.
export async function rereadState(deploymentId: string): Promise<{ outOfDate: number; reading: number }> {
  const [row] = await db()
    .select({
      outOfDate: sql<number>`count(*) filter (where ${outdated})`.mapWith(Number),
      reading:
        sql<number>`count(*) filter (where ${contentPages.status} = 'queued' and ${inArray(contentPages.detail, [REREAD.now, REREAD.apply, REREAD.nightly])})`.mapWith(
          Number,
        ),
    })
    .from(contentPages)
    .where(and(eq(contentPages.deploymentId, deploymentId), ne(contentPages.status, "removed")));
  return { outOfDate: row?.outOfDate ?? 0, reading: row?.reading ?? 0 };
}

// The rules Bring up to date applies: the plan's ticked suggestions, or, for a deployment from
// before the plan (it never chose), every suggestion but "not updated in 2 years": that one goes
// by sitemap dates, which lag pages that are still current (the demo's FAQ pages are dated
// 2022), so it stays the partner's choice. Pages older than 2 years by their own date are
// still flagged.
const LEGACY_RULES = PLAN_RULES.filter((r) => r !== "old");
const currentRules = (source: typeof syncSources.$inferSelect | undefined): PlanRule[] =>
  source?.plan ? planRules(source.plan) : [...LEGACY_RULES];
// Which plan rule to name when a page matches several: the most specific first.
const RULE_ORDER: readonly PlanRule[] = ["conversion", "versions", "archive", "old", "year", "duplicate"];

export interface UpToDatePreview {
  // Pages in the chat now that the current rules leave out. reason is short enough to count by
  // ("Older than 2 years"); detail says it for the page ("Published 28 Jun 2019: …").
  leaveOut: { url: string; title: string; reason: string; detail: string }[];
  // Pages still to be read again by the current extractor and rules.
  reextract: number;
  // Every flag the current rules give the deployment's pages.
  flags: Record<PageFlag, number>;
}

// What the current rules and extractor would change. Pages read by older ones are queued to be
// read again now (they stay in the chat meanwhile), so the list fills in with each page's own
// dates as they're read: whatsupgold.com's 2016 price posts only show their age once loaded.
export async function upToDatePreview(deploymentId: string, opts: { reread?: boolean } = { reread: false }): Promise<UpToDatePreview> {
  const [d] = await db()
    .select({
      language: deployments.language,
      siteUrl: deployments.siteUrl,
      published: deployments.published,
      signOff: deployments.signOff,
    })
    .from(deployments)
    .where(eq(deployments.id, deploymentId));
  // A live deployment on the selection from before key pages keeps it until Add switches it.
  const keys = d ? await keyPagesSwitched(deploymentId, d) : true;
  const [source] = await db()
    .select()
    .from(syncSources)
    .where(and(eq(syncSources.deploymentId, deploymentId), eq(syncSources.kind, "sitemap")));
  if (opts.reread === true) await queueRereadFor(deploymentId, source, REREAD.now);
  const rows = await db()
    .select({
      url: contentPages.url,
      title: contentPages.title,
      status: contentPages.status,
      detail: contentPages.detail,
      lang: contentPages.lang,
      lastModified: contentPages.lastModified,
      publishedAt: contentPages.publishedAt,
      pageModifiedAt: contentPages.pageModifiedAt,
      flags: contentPages.flags,
      text: contentPages.text,
      extractorVersion: contentPages.extractorVersion,
      rulesVersion: contentPages.rulesVersion,
    })
    .from(contentPages)
    .where(and(eq(contentPages.deploymentId, deploymentId), ne(contentPages.status, "removed")))
    .orderBy(asc(contentPages.url));
  const today = new Date();
  const rules = currentRules(source);
  const served = servedLanguages(source?.languages ?? [], d?.language ?? "en");
  const flags = Object.fromEntries(PAGE_FLAGS.map((f) => [f, 0])) as Record<PageFlag, number>;
  const leaveOut: UpToDatePreview["leaveOut"] = [];
  let reextract = 0;
  let ranking: Awaited<ReturnType<typeof planRanking>> | null | undefined;
  // Pages added by hand answer only to the date and stale-price rules, and not once kept.
  // Not one a person left out since (its exact path in Leave out), as the worker lists them.
  const pinned = new Set(
    (source?.pinned ?? []).filter((u) => !source?.excludePatterns.includes(new URL(u).pathname)).map((u) => pageKey(u)),
  );
  const keptByPerson = new Set((source?.kept ?? []).map((k) => pageKey(k.url)));
  // Each page's flags; the counts are of the pages that stay, not those listed to leave.
  const kept = new Map<string, PageFlag[]>();
  for (const row of rows) {
    const current = row.extractorVersion >= EXTRACTOR_VERSION && row.rulesVersion >= RULES_VERSION;
    if (!current) reextract += 1;
    const pageFlags = current
      ? (row.flags.filter((f) => (PAGE_FLAGS as readonly string[]).includes(f)) as PageFlag[])
      : storedFlags(row, { served, today, keyPages: keys });
    kept.set(row.url, pageFlags);
    if (!["indexed", "processing", "queued"].includes(row.status)) continue;
    const facts = storedFacts(row, today);
    const byHand = pinned.has(pageKey(row.url));
    const keptNow = keptByPerson.has(pageKey(row.url));
    const held = row.detail?.startsWith(WOULD_LEAVE_OUT) ? row.detail.slice(WOULD_LEAVE_OUT.length) : undefined;
    const handRule = byHand && !keptNow ? keepRule(facts, pageFlags, rules, today) : undefined;
    const detail =
      held && !(keptNow && held.startsWith(KEEP_ASKED))
        ? held
        : byHand
          ? handRule && keepAsked(handRule)
          : ruleLeaveOut(facts, pageFlags, rules, today);
    const title = row.title ?? new URL(row.url).pathname;
    if (detail) {
      // These pages are in the chat now: never "not synced" (shownDetail).
      const said = shownDetail(detail, true)!;
      leaveOut.push({ url: row.url, title, reason: leaveOutLabel(said), detail: said });
      continue;
    }
    // Kept whatever the plan's suggestions say.
    if (byHand) continue;
    // The plan's suggestions that go by the address and the sitemap (years, earlier versions…),
    // as the next sync ranks the sitemap under these rules.
    ranking ??= d && source ? await planRanking(d, source, rules, keys).catch(() => null) : null;
    const planned = ranking?.inScope.get(pageKey(row.url));
    const rule =
      planned && !ranking!.ranked.has(planned.key) ? RULE_ORDER.find((r) => planned.matches.includes(r) && rules.includes(r)) : undefined;
    if (rule) {
      leaveOut.push({
        url: row.url,
        title,
        reason: RULE_REASONS[rule],
        detail: `The plan's suggested exclusions leave it out: ${ruleLabel(rule, today)}.`,
      });
    }
  }
  const leaving = new Set(leaveOut.map((p) => p.url));
  for (const [url, pageFlags] of kept) if (!leaving.has(url)) for (const f of pageFlags) flags[f] += 1;
  return { leaveOut, reextract, flags };
}

// A plan rule's leave-out, said short enough to count by.
const RULE_REASONS: Record<PlanRule, string> = {
  conversion: "Conversion page",
  duplicate: "Duplicate of another page",
  archive: "Campaign, event, webinar or news page over 12 months old",
  year: "An earlier year in the address",
  versions: "An earlier version's page",
  old: "Older than 2 years",
};

// The site's sitemap ranked under the given rules, as the next sync ranks it.
async function planRanking(
  d: { siteUrl: string; language: string },
  source: typeof syncSources.$inferSelect,
  rules: readonly PlanRule[],
  keys: boolean,
) {
  if (source.discovery === "crawl") return null;
  const sitemap = isSitemapAddress(source.sitemapUrl) ? source.sitemapUrl! : undefined;
  const entries = await siteEntries(sitemap ? d.siteUrl : (source.sitemapUrl ?? d.siteUrl), sitemap);
  const { ranked, inScope } = rankPages({
    entries,
    served: d.language === "auto" ? [] : [d.language],
    languages: source.languages,
    rules,
    include: source.includePatterns,
    exclude: source.excludePatterns,
    budget: source.pageBudget ?? DEFAULT_PAGE_BUDGET,
    today: new Date(),
    keyPages: keys,
  });
  return { ranked: new Set(ranked.map((c) => c.key)), inScope: new Map(inScope.map((c) => [c.key, c])) };
}

// Whether a deployment takes key pages (content-plan.ts takesKeyPages: not yet published, or
// signed off under checks 3 or later), or Bring up to date's Add switched it (addKeyPages, audited
// content.key-pages): as the worker decides it.
async function keyPagesSwitched(
  deploymentId: string,
  d: { published: boolean; signOff?: { checksVersion?: number } | null },
): Promise<boolean> {
  if (takesKeyPages(d)) return true;
  const [switched] = await db()
    .select({ id: auditLog.id })
    .from(auditLog)
    .where(and(eq(auditLog.targetType, "deployment"), eq(auditLog.targetId, deploymentId), eq(auditLog.action, "content.key-pages")))
    .limit(1);
  return Boolean(switched);
}

// Queues the deployment's pages read by an older extractor or rules to be read again now, ahead
// of the nightly batch. why: REREAD.now keeps answerable pages in the chat and says why the
// current rules would leave them out; REREAD.apply applies the rules as it reads.
async function queueRereadFor(deploymentId: string, source: typeof syncSources.$inferSelect | undefined, why: string): Promise<number> {
  // A first sync reads every page with the current extractor anyway.
  if (!source || !source.lastSyncedAt) return 0;
  const queued = await db()
    .update(contentPages)
    .set({ status: "queued", detail: why })
    .where(
      and(
        eq(contentPages.deploymentId, deploymentId),
        or(
          and(inArray(contentPages.status, ["indexed", "skipped"]), outdated),
          // Already waiting to be read again: now, or under the current rules.
          and(eq(contentPages.status, "queued"), inArray(contentPages.detail, [REREAD.nightly, REREAD.now, REREAD.apply])),
        ),
      ),
    )
    .returning({ id: contentPages.id });
  if (queued.length) {
    await db()
      .update(syncSources)
      .set({ lastJobStatus: "running", startedAt: new Date(), lastError: null })
      .where(and(eq(syncSources.id, source.id), inArray(syncSources.lastJobStatus, ["ok", "partial", "failed"])));
  }
  return queued.length;
}

// Reads the deployment's pages read by older versions again now, keeping them in the chat (a
// partner forcing the nightly re-read for one deployment).
export async function reextractNow(deploymentId: string, actor: string | null): Promise<number> {
  const [source] = await db()
    .select()
    .from(syncSources)
    .where(and(eq(syncSources.deploymentId, deploymentId), eq(syncSources.kind, "sitemap")));
  const n = await queueRereadFor(deploymentId, source, REREAD.now);
  await audit(actor, deploymentId, "content.reread", { pages: n });
  return n;
}

// Fleet's "Read the pages again for all, tonight": each deployment's pages read by an older
// extractor or rules wait for Bring up to date overnight (00:00 to 06:00 server time: the worker's
// jobs/rules-rollout.ts), each deployment followed by its re-check. They stay in the chat meanwhile, and the re-read keeps every
// answerable page in, saying why today's rules would leave it out, for Bring up to date's step 1
// to apply in the morning. A deployment in its first sync is skipped: it reads every page anyway.
// Returns the pages queued per deployment.
export async function queueReread(deploymentIds: readonly string[], actor: string | null): Promise<Map<string, number>> {
  const queued = new Map<string, number>();
  for (const deploymentId of deploymentIds) {
    const [source] = await db()
      .select({ lastSyncedAt: syncSources.lastSyncedAt })
      .from(syncSources)
      .where(and(eq(syncSources.deploymentId, deploymentId), eq(syncSources.kind, "sitemap")));
    if (!source?.lastSyncedAt) continue;
    const rows = await db()
      .update(contentPages)
      .set({ status: "queued", detail: REREAD.nightly })
      .where(and(eq(contentPages.deploymentId, deploymentId), inArray(contentPages.status, ["indexed", "skipped"]), outdated))
      .returning({ id: contentPages.id });
    queued.set(deploymentId, rows.length);
    await audit(actor, deploymentId, "content.reread", { pages: rows.length, tonight: true });
  }
  return queued;
}

// Bring up to date's Apply: takes the pages the current rules leave out out of the chat (all of
// them, or the URLs given; the worker takes them out of the Knowledge Box within a minute), and
// reads every page read by older versions again. With all, a deployment from before the plan
// takes on every suggested exclusion for later syncs too, and the re-read applies the rules as
// it reads; with some, pages not chosen stay in and keep saying why they'd be left out.
export async function applyUpToDate(
  deploymentId: string,
  actor: string | null,
  urls?: readonly string[],
): Promise<{ leftOut: number; reread: number }> {
  const preview = await upToDatePreview(deploymentId, { reread: false });
  const chosen = urls ? preview.leaveOut.filter((p) => urls.includes(p.url)) : preview.leaveOut;
  // Left out under the current rules, so not read again: the re-read below would otherwise take
  // back a page the plan's address rules (years, versions) leave out.
  for (const page of chosen) {
    await db()
      .update(contentPages)
      .set({ status: "skipped", detail: page.detail, extractorVersion: EXTRACTOR_VERSION, rulesVersion: RULES_VERSION })
      .where(and(eq(contentPages.deploymentId, deploymentId), eq(contentPages.url, page.url)));
  }
  const [source] = await db()
    .select()
    .from(syncSources)
    .where(and(eq(syncSources.deploymentId, deploymentId), eq(syncSources.kind, "sitemap")));
  if (!urls && source && !source.plan) {
    const plan: ContentPlanSummary = {
      at: new Date().toISOString(),
      total: source.pagesFound ?? 0,
      excluded: LEGACY_RULES.map((rule) => ({ rule, pages: 0 })),
    };
    await db().update(syncSources).set({ plan }).where(eq(syncSources.id, source.id));
  }
  const reread = await queueRereadFor(deploymentId, source, urls ? REREAD.now : REREAD.apply);
  await audit(actor, deploymentId, "content.up-to-date", {
    leftOut: chosen.map((p) => ({ url: p.url, reason: p.reason })),
    proposed: preview.leaveOut.length,
    reread,
    ...(!urls && !source?.plan && { rules: LEGACY_RULES }),
  });
  return { leftOut: chosen.length, reread };
}

// ---- pages a person adds by hand (validation's Add these pages, Content's Always include) ----

export interface PageCandidate {
  url: string;
  title?: string;
  // Synced, or waiting to be.
  inSync: boolean;
  // Why the sync doesn't take it.
  leftOutBecause?: string;
  // The intent its address names, and whether the sync took it as a key page.
  intent?: KeyIntent;
  keyPage?: boolean;
  // How it was found: its address or title (or an intent word), its synced text, or a near miss
  // (some of the question's words, not enough); the words it holds and the telling ones it
  // lacks; and, found by its text, the line that holds them.
  match?: "address" | "text" | "near";
  // false: the candidates come from an incomplete sitemap read, or a crawl, so a page that answers
  // may not be among them (syncedAnswerNote never says "Adding pages won't help" then).
  readComplete?: boolean;
  matched?: string[];
  missing?: string[];
  found?: string;
}

// Each site's sitemap entries for a while, so several questions on one screen read them once
// (the sniffer keeps its own read for 10 minutes too).
const CANDIDATE_ENTRIES_MS = 10 * 60_000;
// complete: no sitemap file failed, went unread or was blocked (the held-answer panel says "Adding
// pages won't help" only after such a read).
const entryStore = globalThis as {
  __launchpadSitemapEntries?: Map<string, { at: number; read: Promise<PlanEntry[]>; complete?: boolean }>;
};
function siteEntries(site: string, sitemap: string | undefined): Promise<PlanEntry[]> {
  entryStore.__launchpadSitemapEntries ??= new Map();
  const cache = entryStore.__launchpadSitemapEntries;
  const key = `${site} ${sitemap ?? ""}`;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < CANDIDATE_ENTRIES_MS) return cached.read;
  const entry: { at: number; read: Promise<PlanEntry[]>; complete?: boolean } = { at: Date.now(), read: Promise.resolve([]) };
  entry.read = readSitemapEntries(site, undefined, fetch, sitemap).then((r) => {
    entry.complete = !r.failed?.length && !r.unread?.length && !r.blocked && r.total > 0;
    return r.entries;
  });
  const read = entry.read;
  cache.set(key, entry);
  read.catch(() => cache.delete(key));
  for (const [k, v] of cache) if (cache.size > 4 || Date.now() - v.at > CANDIDATE_ENTRIES_MS) cache.delete(k);
  return read;
}

type Source = typeof syncSources.$inferSelect;

// The served languages the worker ranks with (apps/worker/src/jobs/content.ts servedFor).
const syncServed = (language: string) => (language === "auto" ? LANGUAGES.map((l) => l.code) : [language]);

// Whether the site's last sitemap read (siteEntries) was complete; undefined before one finished.
function siteReadComplete(site: string, sitemap: string | undefined): boolean | undefined {
  return entryStore.__launchpadSitemapEntries?.get(`${site} ${sitemap ?? ""}`)?.complete;
}

// The sitemap's entries for a source, or undefined for a crawled site.
async function sourceEntries(d: { siteUrl: string }, source: Source): Promise<PlanEntry[] | undefined> {
  if (source.discovery === "crawl") return undefined;
  const sitemap = isSitemapAddress(source.sitemapUrl) ? source.sitemapUrl! : undefined;
  return siteEntries(sitemap ? d.siteUrl : (source.sitemapUrl ?? d.siteUrl), sitemap);
}

// The sitemap ranked as the next sync ranks it (the worker's rankedPages), with what earlier
// syncs found by loading pages (their overview flags).
// Kept for a minute per deployment: the fix panel asks for several questions on one screen, and
// ranking telerik.com's 150,000 pages takes about 2 s.
const rankingStore = globalThis as { __launchpadRankings?: Map<string, { at: number; ranking: ReturnType<typeof rankPages> }> };
function syncRanking(
  d: { language: string },
  source: Source,
  entries: readonly PlanEntry[],
  rows: readonly { url: string; flags?: readonly string[]; status: string; detail?: string | null }[],
  keys: boolean,
): ReturnType<typeof rankPages> {
  rankingStore.__launchpadRankings ??= new Map();
  const store = rankingStore.__launchpadRankings;
  const memo = `${source.id}|${source.updatedAt?.getTime() ?? 0}|${keys}|${entries.length}|${rows.length}`;
  const cached = store.get(memo);
  if (cached && Date.now() - cached.at < 60_000) return cached.ranking;
  for (const [k, v] of store) if (store.size > 8 || Date.now() - v.at >= 60_000) store.delete(k);
  const ranking = rankSync(d, source, entries, rows, keys);
  store.set(memo, { at: Date.now(), ranking });
  return ranking;
}

const rankSync = (
  d: { language: string },
  source: Source,
  entries: readonly PlanEntry[],
  rows: readonly { url: string; flags?: readonly string[]; status: string; detail?: string | null }[],
  keys: boolean,
) =>
  rankPages({
    entries,
    served: syncServed(d.language),
    languages: source.languages,
    rules: planRules(source.plan),
    include: source.includePatterns,
    exclude: source.excludePatterns,
    budget: source.pageBudget ?? DEFAULT_PAGE_BUDGET,
    today: new Date(),
    known: new Map(rows.filter((r) => r.flags?.length).map((r) => [pageKey(r.url), r.flags!])),
    keyPages: keys,
    // Key pages loading found unusable give way to the next (the worker's unusableKeys).
    unusable: new Set(rows.filter((r) => unusableForKeys(r)).map((r) => pageKey(r.url))),
  });

// Words that say little about which page answers ("out" in "slime out of carpet"): left out of
// the search box's words, and of near misses when nothing else matched.
const VAGUE_WORDS = new Set("out off way need want help please find know tell use make able best good new one two get getting".split(" "));

// The words the pages panel's Find a page box starts with, for a question: its telling words, in
// order ("How do I get slime out of carpet?" → "slime carpet"), so trying the client's own word
// is one edit ("goo carpet").
export function searchWords(question: string): string {
  const words = matchWords(question);
  const telling = words.filter((w) => !VAGUE_WORDS.has(w));
  return (telling.length ? telling : words).join(" ");
}

// Addresses on the deployment's site typed into a question or search: a full address on its host
// (with or without www), or a path ("/fr/prix", "fr/contact"). Pure.
export function typedAddresses(text: string, siteUrl: string): string[] {
  const site = new URL(siteUrl);
  const bareHost = (h: string) => h.replace(/^www\./, "").toLowerCase();
  const found = new Set<string>();
  for (const token of text.split(/\s+/)) {
    const raw = token.replace(/^[("'<]+|[)"'>.,;!?]+$/g, "");
    // Not "24/7" or "and/or": an address, a path from "/", or one starting with a language folder.
    if (!raw.includes("/") || !/[a-z]{2,}/i.test(raw)) continue;
    if (!/^https?:|^\//i.test(raw) && !pathLanguage(`${site.origin}/${raw}`)) continue;
    try {
      const u = /^https?:\/\//i.test(raw) ? new URL(raw) : new URL(raw.startsWith("/") ? raw : `/${raw}`, site.origin);
      if (bareHost(u.hostname) !== bareHost(site.hostname) || u.pathname === "/") continue;
      u.hash = "";
      found.add(u.href);
    } catch {
      // Not an address.
    }
  }
  return [...found].slice(0, 5);
}

// The stem a word is looked for by in pages' text: "painted" finds "paint", "removing" "remov".
const textStem = (word: string) => {
  const m = /^(.{4,}?)(ing|ed|es|er)$/.exec(word);
  return m ? m[1]! : word;
};

// Synced pages' text (in the chat, or being read again from it), by each word on its own: which
// of the words each page's text holds, by address, and how many pages hold each word. A page
// whose address says "goo" but whose text says "slime" is found this way.
async function textMatches(
  deploymentId: string,
  question: readonly string[],
): Promise<{ hits: Map<string, Set<string>>; pages: Map<string, string>; total: number }> {
  const hits = new Map<string, Set<string>>();
  const pages = new Map<string, string>();
  // Vague words say nothing here ("out" is in every "About" menu): the telling ones, each at the
  // start of a word ("carpet" finds "carpets", not "Scarpetta").
  const words = question.filter((w) => !VAGUE_WORDS.has(w));
  if (!words.length) return { hits, pages, total: 0 };
  const patterns = words.map((w) => `\\m${textStem(w)}`);
  const inChat = or(
    eq(contentPages.status, "indexed"),
    and(inArray(contentPages.status, ["queued", "processing"]), isNotNull(contentPages.indexedAt)),
  );
  const flags = sql.join(
    patterns.map((p) => sql`(${contentPages.text} ~* ${p})::int`),
    sql`::text || `,
  );
  const [rows, [count]] = await Promise.all([
    db()
      .select({ url: contentPages.url, flags: sql<string>`${flags}::text` })
      .from(contentPages)
      .where(
        and(
          eq(contentPages.deploymentId, deploymentId),
          inChat,
          sql`${contentPages.text} ~* any(array[${sql.join(
            patterns.map((p) => sql`${p}`),
            sql`, `,
          )}]::text[])`,
        ),
      )
      .limit(1000),
    db()
      .select({ n: sql<number>`count(*)`.mapWith(Number) })
      .from(contentPages)
      .where(and(eq(contentPages.deploymentId, deploymentId), inChat)),
  ]);
  for (const r of rows) {
    const found = new Set(words.filter((_, i) => r.flags[i] === "1"));
    if (!found.size) continue;
    hits.set(pageKey(r.url), found);
    pages.set(pageKey(r.url), r.url);
  }
  return { hits, pages, total: count?.n ?? 0 };
}

// The line of a synced page's text that holds the most of the words, rarest first: what the
// panel shows of a page found by its text ("…lift the Goo out of the carpet fibres…").
async function foundLines(deploymentId: string, urls: readonly string[], question: readonly string[]): Promise<Map<string, string>> {
  const lines = new Map<string, string>();
  // Each telling word at the start of a word, as textMatches looks for it.
  const finds = question.filter((w) => !VAGUE_WORDS.has(w)).map((w) => new RegExp(`\\b${textStem(w)}`, "i"));
  if (!urls.length || !finds.length) return lines;
  const rows = await db()
    .select({ url: contentPages.url, text: contentPages.text })
    .from(contentPages)
    .where(and(eq(contentPages.deploymentId, deploymentId), inArray(contentPages.url, [...urls])));
  for (const r of rows) {
    let best = "";
    let most = 0;
    for (const line of (r.text ?? "").split("\n")) {
      const n = finds.filter((re) => re.test(line)).length;
      if (n > most && !/^\s*#/.test(line)) {
        most = n;
        best = line;
      }
    }
    if (!best) continue;
    const clean = best
      .replace(/^\s*(?:[-*+>]|\d+\.)\s+/, "")
      .replace(/\s+/g, " ")
      .trim();
    // The stretch around the first word it holds.
    const at = Math.max(
      0,
      finds
        .map((re) => clean.search(re))
        .filter((i) => i >= 0)
        .sort((a, b) => a - b)[0]! - 60,
    );
    const piece = clean.slice(at, at + 160);
    lines.set(pageKey(r.url), `${at > 0 ? "…" : ""}${piece}${at + 160 < clean.length ? "…" : ""}`);
  }
  return lines;
}

// Pages on the site that may answer a question: from the whole sitemap (or the crawl's pages),
// not only the synced ones, by the question's words in each address and title, and in each synced
// page's text, each word on its own. One intent word is enough, with its synonyms ("contact"
// finds /contact for "How do I contact sales?", "price" finds /purchase.aspx), and the
// deployment's key pages come first. Each says whether it's in the sync, and if not, why not.
// When fewer pages match than asked for, near misses follow (match "near": pages holding some of
// the words, the rarest words first, with which they hold and which they lack), so the panel
// never ends at "no page matches" while any page holds one of the words.
export async function sitemapCandidates(deploymentId: string, question: string, limit = 5): Promise<PageCandidate[]> {
  const words = matchWords(question);
  const answering = answeringIntents(questionIntents(question));
  // A German price question prefers /de/preise to /pricing.
  const asked = questionLanguage(question);
  if (!words.length && !answering.size && !question.includes("/")) return [];
  const [d] = await db()
    .select({
      siteUrl: deployments.siteUrl,
      language: deployments.language,
      published: deployments.published,
      signOff: deployments.signOff,
    })
    .from(deployments)
    .where(eq(deployments.id, deploymentId));
  if (!d) return [];
  const [source] = await db()
    .select()
    .from(syncSources)
    .where(and(eq(syncSources.deploymentId, deploymentId), eq(syncSources.kind, "sitemap")));
  const rows = await db()
    .select({
      url: contentPages.url,
      title: contentPages.title,
      status: contentPages.status,
      detail: contentPages.detail,
      keyIntent: contentPages.keyIntent,
      flags: contentPages.flags,
    })
    .from(contentPages)
    .where(eq(contentPages.deploymentId, deploymentId));
  const byKey = new Map(rows.map((r) => [pageKey(r.url), r]));
  const fromSitemap = source
    ? await sourceEntries(d, source).catch(() => undefined)
    : await siteEntries(d.siteUrl, undefined).catch(() => undefined);
  const listed: PlanEntry[] = fromSitemap ?? rows.map((r) => ({ url: r.url }));
  // A crawl, a read that failed, or one with files missing: the site may have more pages than these.
  const readSitemap = source && isSitemapAddress(source.sitemapUrl) ? source.sitemapUrl! : undefined;
  const readComplete =
    Boolean(fromSitemap?.length) && siteReadComplete(readSitemap ? d.siteUrl : (source?.sitemapUrl ?? d.siteUrl), readSitemap) !== false;
  // Synced pages the sitemap doesn't list (added by hand, a crawled site) are searched by their
  // text too.
  const text = await textMatches(deploymentId, words);
  const listedKeys = new Set(listed.map((e) => pageKey(e.url)));
  // An address or path typed in ("https://www.teamleader.eu/fr/prix", "fr/contact") is offered
  // whether or not the sitemap read has it: Always include loads it to check.
  const typed = typedAddresses(question, d.siteUrl).filter((url) => !listedKeys.has(pageKey(url)));
  const typedKeys = new Set(typed.map((url) => pageKey(url)));
  const entries: PlanEntry[] = [
    ...listed,
    ...typed.map((url) => ({ url })),
    ...[...text.pages].filter(([key]) => !listedKeys.has(key) && !typedKeys.has(key)).map(([, url]) => ({ url })),
  ];

  const served = servedLanguages(source?.languages ?? [], d.language);
  const all = entries
    .map((entry, order) => {
      const key = pageKey(entry.url);
      const row = byKey.get(key);
      const path = new URL(entry.url).pathname;
      let readable = path;
      try {
        readable = decodeURIComponent(path);
      } catch {
        // As written.
      }
      const own = words.length ? matchWords(`${readable} ${row?.title ?? ""}`) : [];
      const inAddress = words.filter((w) => matchScore([w], own) > 0);
      const score = inAddress.length;
      // Every word the page holds, in its address and title or in its synced text.
      const matched = [...new Set([...inAddress, ...(text.hits.get(key) ?? [])])];
      // 2: a key page the sync took for one of the question's intents; 1: an address naming one.
      const intent = answering.size ? (isKeyIntent(row?.keyIntent) ? row.keyIntent : intentOf(entry.url)) : undefined;
      const fits = intent !== undefined && answering.has(intent) ? (isKeyIntent(row?.keyIntent) ? 2 : 1) : 0;
      const segments = path.split("/").filter(Boolean);
      // Depth after a language folder: /de/preise is as shallow as /pricing.
      const depth = segments.length - (segments[0] && pathLanguage(`${new URL(entry.url).origin}/${segments[0]}`) ? 1 : 0);
      const lang = primaryLanguage(pathLanguage(entry.url) ?? entry.lang ?? (d.language === "auto" ? "en" : d.language));
      return {
        entry,
        row,
        score,
        matched,
        fits: typedKeys.has(key) ? 3 : fits,
        intent,
        order,
        depth,
        inAsked: !asked || lang === asked ? 0 : 1,
      };
    })
    .filter((c) => c.fits > 0 || c.matched.length > 0)
    // Not pages in a language the deployment doesn't sync: they'd be left out again.
    .filter((c) => {
      const lang = pathLanguage(c.entry.url) ?? c.entry.lang;
      return !served.length || !lang || served.includes(primaryLanguage(lang));
    });
  // A match: an intent's page, or at least two of the telling words (or the only one) in its
  // address, title or text. A near miss: fewer, the rarest words first (a word few pages hold
  // says more).
  const telling = words.filter((w) => !VAGUE_WORDS.has(w));
  const counted = telling.length ? telling : words;
  const enough = Math.min(2, counted.length);
  const tells = (c: { matched: string[] }) => c.matched.filter((w) => counted.includes(w)).length;
  const scored = all.filter((c) => c.fits > 0 || (words.length > 0 && tells(c) >= enough));
  const rarity = new Map(
    words.map((w) => {
      const holders = all.filter((c) => c.matched.includes(w)).length;
      return [w, Math.log((entries.length + 1) / (holders + 1)) + (VAGUE_WORDS.has(w) ? 0 : 1)];
    }),
  );
  const weight = (c: (typeof all)[number]) => c.matched.reduce((sum, w) => sum + (rarity.get(w) ?? 0), 0);
  const inSyncRow = (c: (typeof all)[number]) => Boolean(c.row && ["queued", "processing", "indexed"].includes(c.row.status));
  const scoredSet = new Set(scored);
  const nearAll = all
    .filter((c) => !scoredSet.has(c) && c.matched.some((w) => counted.includes(w)))
    .sort(
      (a, b) =>
        weight(b) - weight(a) || b.score - a.score || Number(inSyncRow(b)) - Number(inSyncRow(a)) || a.depth - b.depth || a.order - b.order,
    );
  // Each telling word on its own, in turn, the rarest first: "slime" pages, then "carpet" pages.
  const byWord = [...counted]
    .sort((a, b) => (rarity.get(b) ?? 0) - (rarity.get(a) ?? 0))
    .map((w) => nearAll.filter((c) => c.matched.includes(w)));
  const near: typeof nearAll = [];
  const taken = new Set<(typeof nearAll)[number]>();
  for (let i = 0; near.length < limit && i < nearAll.length; i++) {
    for (const list of byWord) {
      const c = list[i];
      if (c && !taken.has(c) && near.length < limit) {
        taken.add(c);
        near.push(c);
      }
    }
  }
  if (!scored.length && !near.length) return [];
  const inSync = (c: (typeof scored)[number]) => Boolean(c.row && ["queued", "processing", "indexed"].includes(c.row.status));
  const ranking = source ? syncRanking(d, source, listed, rows, await keyPagesSwitched(deploymentId, d)) : undefined;
  const scope = new Map(ranking?.inScope.map((c) => [c.key, c]));
  const rank = new Map(ranking?.ranked.map((c, i) => [c.key, i]));
  const ticked = planRules(source?.plan);
  // Last among equals: pages adding wouldn't help (too little text, or it failed to load), and
  // pages a suggested exclusion leaves out (/devreach-2022/contact-us). Not pages a person left
  // out: they may have left out the page that answers.
  const unhelpful = (c: (typeof scored)[number]) =>
    (c.row?.status === "skipped" && Boolean(c.row.detail?.startsWith("Too little text") || c.row.detail?.startsWith("An error page"))) ||
    c.row?.status === "failed" ||
    Boolean(scope.get(pageKey(c.entry.url))?.matches.some((r) => ticked.includes(r)));
  const flags = new Map(scored.map((c) => [c, unhelpful(c) ? 1 : 0]));
  // Among equal matches, the page about just the question's words: crayola.com's
  // regular-crayons-on-painted-walls before glitter-crayons-… Words most candidates share
  // ("stain", "tip") and plain modifiers ("regular") don't count against a page.
  const slug = (c: (typeof scored)[number]) => {
    const last = new URL(c.entry.url).pathname.split("/").filter(Boolean).at(-1) ?? "";
    try {
      return matchWords(decodeURIComponent(last));
    } catch {
      return matchWords(last);
    }
  };
  const slugs = new Map(scored.map((c) => [c, slug(c)]));
  const shared = new Map<string, number>();
  for (const list of slugs.values()) for (const w of new Set(list)) shared.set(w, (shared.get(w) ?? 0) + 1);
  const extra = new Map(
    scored.map((c) => [
      c,
      slugs
        .get(c)!
        .filter((w) => !matchScore([w], words) && !PLAIN_WORDS.has(w) && !(scored.length >= 4 && (shared.get(w) ?? 0) > scored.length / 2))
        .length,
    ]),
  );
  // Pages an intent word found go shallowest first (telerik.com's /purchase.aspx before its
  // product pages); pages found by their words, best match first.
  scored.sort(
    (a, b) =>
      b.fits - a.fits ||
      flags.get(a)! - flags.get(b)! ||
      (a.fits ? a.inAsked - b.inAsked || a.depth - b.depth : 0) ||
      b.score - a.score ||
      tells(b) - tells(a) ||
      weight(b) - weight(a) ||
      extra.get(a)! - extra.get(b)! ||
      Number(inSync(b)) - Number(inSync(a)) ||
      a.depth - b.depth ||
      a.order - b.order,
  );
  // Near misses fill what matches leave of the limit: at least two whenever any page holds a word.
  const matches = scored.slice(0, limit);
  const misses = near.slice(0, Math.max(limit - matches.length, matches.length ? 0 : Math.min(2, limit)));
  const best = [...matches, ...misses];
  const missed = new Set(misses);
  const found = await foundLines(
    deploymentId,
    best.filter((c) => text.hits.has(pageKey(c.entry.url)) && c.matched.length > c.score).map((c) => c.entry.url),
    [...words].sort((a, b) => (rarity.get(b) ?? 0) - (rarity.get(a) ?? 0)),
  ).catch(() => new Map<string, string>());

  // Why the sync doesn't take the others: the reason it left the page out, else the plan's.
  const why = (c: (typeof best)[number]): string | undefined => {
    if (inSync(c)) return undefined;
    const key = pageKey(c.entry.url);
    const planned = scope.get(key);
    // A page a person left out, whatever an earlier sync recorded about it.
    if (ranking && !planned && source && pathMatches(c.entry.url, source.excludePatterns)) return LEFT_OUT_BY_YOU;
    if (c.row?.detail && !c.row.detail.startsWith("Waiting")) return c.row.detail;
    if (!planned && typedKeys.has(key)) return "Not in the sitemap read: Always include loads it to check it.";
    if (!ranking) return "Not synced yet.";
    if (!planned) return "Outside the content settings' Only these paths or Leave out.";
    const rule = planned.matches.find((r) => ticked.includes(r));
    if (rule) return `Left out by the plan: ${ruleLabel(rule, new Date()).toLowerCase()}.`;
    if (!rank.has(key)) return `In a language the sync doesn't take (${planned.lang}).`;
    if (planned.keyPage) return "A key page the next sync takes: not synced yet.";
    return "Past the page budget: the plan ranks other pages first.";
  };
  return best.map((c): PageCandidate => {
    const leftOutBecause = why(c);
    const key = pageKey(c.entry.url);
    const line = found.get(key);
    return {
      url: c.entry.url,
      ...(c.row?.title && { title: c.row.title }),
      inSync: inSync(c),
      ...(leftOutBecause && { leftOutBecause }),
      ...(c.intent && { intent: c.intent }),
      ...(isKeyIntent(c.row?.keyIntent) && { keyPage: true }),
      match: missed.has(c) ? "near" : c.score >= enough || c.fits > 0 || !text.hits.has(key) ? "address" : "text",
      ...(words.length && { matched: c.matched, missing: words.filter((w) => !c.matched.includes(w) && !VAGUE_WORDS.has(w)) }),
      ...(line && { found: line }),
      readComplete,
    };
  });
}

// A candidate's match in words, for the panel and Find a page: "Near miss: has slime, not carpet",
// "Found in the page's text".
export function matchNote(c: PageCandidate): string | undefined {
  if (c.match === "near") {
    const has = (c.matched ?? []).filter((w) => !VAGUE_WORDS.has(w));
    return `Near miss: has ${has.join(", ") || (c.matched ?? []).join(", ")}${c.missing?.length ? `, not ${c.missing.join(", ")}` : ""}.`;
  }
  if (c.match === "text") return "Found in the page's text.";
  return undefined;
}

// Plain modifiers that don't make a page about something else.
const PLAIN_WORDS = new Set(["regular", "standard", "classic", "original", "basic", "general", "normal", "plain", "simple"]);

// When the page that should answer is already synced (telerik.com's /purchase.aspx for "How much
// do your products cost?", whatsupgold.com's /pricing), the fix panel says so rather than
// offering only pages that are in already.
export function syncedAnswerNote(candidates: readonly PageCandidate[]): string | undefined {
  // A near miss isn't the page most likely to answer.
  const top = candidates[0];
  if (!top?.inSync || top.match === "near") return undefined;
  const path = new URL(top.url).pathname;
  const page = top.title ? `"${top.title}" (${path})` : path;
  const as = top.keyPage && top.intent ? `, as the site's ${intentName(top.intent)} page` : "";
  // Only a complete sitemap read can say every page that may answer is in (round 6: a crawled site
  // said so while its /technical-support had never been crawled).
  const complete = candidates.every((c) => c.readComplete !== false);
  const others = candidates.some((c) => !c.inSync)
    ? "Adding the other pages below may still help."
    : complete
      ? "Adding pages won't help: every page that may answer is in already."
      : "The site's pages weren't all read (its sitemap read was incomplete, or it was crawled), so a page that answers may be missing: use Find a page with its address first.";
  return `${page}, the page most likely to answer, is already in the sync${as}, yet the answer didn't use it. ${others} Check that the page states the answer in words a visitor would use, ask the question in the site's own words, or mark it The site doesn't cover this, with a reason.`;
}

// Key pages loading found unusable, with why in words a partner can act on: Content and Review
// list them together. Each gave its place to the next page for the same question, where the site
// has one.
export interface UnusedKeyPage {
  intent: KeyIntent;
  url: string;
  title?: string;
  why: string;
}

export function unusedKeyReason(intent: KeyIntent, url: string, detail: string | null, status: string): string | undefined {
  const path = new URL(url).pathname;
  const advice =
    intent === "contact"
      ? " Put the contact details in Handoff, or add a page that states them."
      : intent === "price" || intent === "buy"
        ? " Add the page that states the prices, or a quote button."
        : " Add a page that answers it, if the site has one.";
  const words = /^Too little text to answer from \((\d+) words?\)/.exec(detail ?? "")?.[1];
  if (words) return `${path} has almost no text (${words} ${words === "1" ? "word" : "words"}): the chat can't answer from it.${advice}`;
  if (detail?.startsWith("An error page"))
    return `${path} is an error page: ${detail.replace(/^An error page /, "").replace(/, with nothing to answer from\.$/, "")}.${advice}`;
  if (/answered 404|answered 410/.test(detail ?? "")) return `${path} isn't on the site any more (${/\d{3}/.exec(detail!)![0]}).${advice}`;
  if (detail?.startsWith("Duplicate of")) return undefined;
  // Left out as a page of links by an older rule: key pages aren't any more.
  if (detail?.startsWith("An overview page"))
    return `${path} was left out as a page of links by an older rule: it comes back as the pages are read again.`;
  if (status === "failed" && noAnswer(detail)) return `${path} didn't load: the site didn't answer when we read it.`;
  if (status === "failed") return `${path} didn't load: ${detail?.replace(/^Didn't load: /, "") ?? "no reason given"}.`;
  if (status === "skipped" && detail) return `${path}: ${detail}`;
  return undefined;
}

// Contact key pages in the chat that state no phone number or email address: a form, and little
// else (teamleader.eu's contact pages), so the chat can only point to them. Content lists them as
// too thin to answer a contact question, with what to do. Pure.
export function thinContactPages(
  rows: readonly { url: string; title: string | null; keyIntent: string | null; facts: PageFacts | null; status: string }[],
): UnusedKeyPage[] {
  return rows
    .filter((r) => r.keyIntent === "contact" && r.status === "indexed")
    .filter((r) => !(r.facts?.contacts ?? []).some((c) => c.kind === "phone" || c.kind === "email"))
    .map((r) => ({
      intent: "contact" as const,
      url: r.url,
      ...(r.title && { title: r.title }),
      why: `${new URL(r.url).pathname} is a form with no phone number or email address: the chat can only point to it. Put the contact details in Handoff, or add a page that states them.`,
    }));
}

export async function thinKeyPages(deploymentId: string): Promise<UnusedKeyPage[]> {
  const rows = await db()
    .select({
      url: contentPages.url,
      title: contentPages.title,
      keyIntent: contentPages.keyIntent,
      facts: contentPages.facts,
      status: contentPages.status,
    })
    .from(contentPages)
    .where(and(eq(contentPages.deploymentId, deploymentId), eq(contentPages.keyIntent, "contact"), eq(contentPages.status, "indexed")));
  // Facts are filled from extractor 3: a page read before then isn't judged yet.
  return thinContactPages(rows.filter((r) => r.facts));
}

export async function keyPagesUnused(deploymentId: string): Promise<UnusedKeyPage[]> {
  const rows = await db()
    .select({
      url: contentPages.url,
      title: contentPages.title,
      status: contentPages.status,
      detail: contentPages.detail,
      keyIntent: contentPages.keyIntent,
    })
    .from(contentPages)
    .where(
      and(
        eq(contentPages.deploymentId, deploymentId),
        isNotNull(contentPages.keyIntent),
        inArray(contentPages.status, ["skipped", "failed"]),
      ),
    );
  return uniqueReasons(
    rows
      .flatMap((r) => {
        if (!isKeyIntent(r.keyIntent) || r.detail?.startsWith(KEEP_ASKED)) return [];
        const why = unusedKeyReason(r.keyIntent, r.url, r.detail, r.status);
        return why ? [{ intent: r.keyIntent, url: r.url, ...(r.title && { title: r.title }), why }] : [];
      })
      .sort((a, b) => KEY_INTENTS.indexOf(a.intent) - KEY_INTENTS.indexOf(b.intent) || (a.url < b.url ? -1 : 1)),
  );
}

// One line per reason: addresses that differ only by a query say the same words (round 7:
// alfredapp.com's /shop/checkout/?type=single and ?type=mega, listed twice in Review). Pure.
export const uniqueReasons = <T extends { why: string }>(pages: readonly T[]): T[] =>
  pages.filter((p, i) => pages.findIndex((o) => o.why === p.why) === i);

// Fleet's line while sites rate-limit the sync, across deployments. Undefined when none does.
export async function fleetRateLimited(): Promise<string | undefined> {
  const [row] = await db()
    .select({ pages: count(), sites: countDistinct(contentPages.deploymentId) })
    .from(contentPages)
    .where(and(inArray(contentPages.status, ["queued", "failed"]), like(contentPages.detail, `${RATE_LIMITED}%`)));
  return row?.pages ? fleetRateLimitedNote(row.pages, row.sites) : undefined;
}

// Keeping a page that trips a date or stale-price rule: why, and who.
export interface KeepAnyway {
  reason: string;
  // The signed-in person, or setup mode's typed name (validation-rules.ts confirmationBy). Without
  // it, the actor's own name.
  who?: Confirmation;
  // The pages it's for; every page in the call when not given.
  urls?: readonly string[];
}

export interface PinResult {
  added: string[];
  refused: { url: string; reason: string }[];
  // Pages that trip a date or stale-price rule: not added until called again with keep. rule is
  // the sentence to ask with ("This page states a price and was published 11 Oct 2016."), and
  // "Keep it anyway?" follows it.
  needsReason: { url: string; rule: string; title?: string }[];
}

// What a page added by hand is checked by: loaded now in the sniffer's interactive lane (kept
// for a while, so asking and keeping load it once), else what the sync stored, else its address.
const FACTS_MS = 10 * 60_000;
const factStore = globalThis as { __launchpadPinFacts?: Map<string, { at: number; facts: RenderedFacts }> };
async function pinFacts(
  urls: readonly string[],
  rows: ReadonlyMap<
    string,
    {
      url: string;
      title: string | null;
      lang: string | null;
      lastModified: Date | null;
      publishedAt: Date | null;
      pageModifiedAt: Date | null;
      text: string | null;
      extractorVersion: number;
    }
  >,
  today: Date,
): Promise<Map<string, RenderedFacts>> {
  factStore.__launchpadPinFacts ??= new Map();
  const cache = factStore.__launchpadPinFacts;
  for (const [k, v] of cache) if (today.getTime() - v.at > FACTS_MS) cache.delete(k);
  const facts = new Map<string, RenderedFacts>();
  const missing = urls.filter((u) => {
    const cached = cache.get(pageKey(u));
    if (cached) facts.set(pageKey(u), cached.facts);
    return !cached;
  });
  const planDate = (url: string) => {
    const row = rows.get(pageKey(url));
    const day = urlDate(url, today);
    return row?.lastModified ?? (day ? new Date(`${day}T00:00:00Z`) : null);
  };
  const loaded = missing.length ? await fetchPages(missing) : undefined;
  for (const [i, url] of missing.entries()) {
    const page = loaded?.[i];
    const key = pageKey(url);
    if (page && !page.error && page.status < 400) {
      const f = loadedFacts({ ...page, url }, planDate(url), today);
      facts.set(key, f);
      cache.set(key, { at: today.getTime(), facts: f });
      continue;
    }
    const row = rows.get(key);
    if (row && row.extractorVersion > 0) facts.set(key, storedFacts(row, today));
    else {
      const date = planDate(url);
      facts.set(key, { url, ...(date && { lastModified: date }) });
    }
  }
  return facts;
}

// Adds pages by hand: kept whatever the budget and the plan's rules (up to MAX_PINNED), and
// loaded ahead of every other page waiting, within a minute. Pages on another site are refused.
// A page that trips a date or stale-price rule ("This page states a price and was published 11
// Oct 2016.") isn't added until a person keeps it with a reason (keep): kept pages are listed in
// sync_sources.kept with who and why, and Review shows them (keptByHand).
export async function pinPages(deploymentId: string, urls: readonly string[], actor: string | null, keep?: KeepAnyway): Promise<PinResult> {
  const [d] = await db()
    .select({
      siteUrl: deployments.siteUrl,
      language: deployments.language,
      published: deployments.published,
      signOff: deployments.signOff,
    })
    .from(deployments)
    .where(eq(deployments.id, deploymentId));
  if (!d) return { added: [], refused: urls.map((url) => ({ url, reason: "The deployment doesn't exist." })), needsReason: [] };
  await ensureContentSync(deploymentId);
  const [source] = await db()
    .select()
    .from(syncSources)
    .where(and(eq(syncSources.deploymentId, deploymentId), eq(syncSources.kind, "sitemap")));
  const rows = new Map(
    (
      await db()
        .select({
          url: contentPages.url,
          title: contentPages.title,
          status: contentPages.status,
          detail: contentPages.detail,
          lang: contentPages.lang,
          lastModified: contentPages.lastModified,
          publishedAt: contentPages.publishedAt,
          pageModifiedAt: contentPages.pageModifiedAt,
          text: contentPages.text,
          extractorVersion: contentPages.extractorVersion,
        })
        .from(contentPages)
        .where(eq(contentPages.deploymentId, deploymentId))
    ).map((r) => [pageKey(r.url), r]),
  );
  const bare = (u: URL) => u.hostname.replace(/^www\./, "").toLowerCase();
  const site = new URL(d.siteUrl);
  const pinned = [...(source?.pinned ?? [])];
  const pinnedKeys = new Set(pinned.map((u) => pageKey(u)));
  const keptList = [...(source?.kept ?? [])];
  const keptKeys = new Set(keptList.map((k) => pageKey(k.url)));
  const refused: PinResult["refused"] = [];
  // New pages, and pages already added that wait for a person to keep them.
  const asked: string[] = [];
  for (const raw of urls) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      refused.push({ url: raw, reason: "Not a web address." });
      continue;
    }
    if (!/^https?:$/.test(url.protocol) || bare(url) !== bare(site)) {
      refused.push({ url: raw, reason: `Not a page on ${site.hostname}.` });
      continue;
    }
    const key = pageKey(url.href);
    const waiting = rows.get(key)?.detail?.replace(WOULD_LEAVE_OUT, "").startsWith(KEEP_ASKED);
    if (asked.some((u) => pageKey(u) === key) || (pinnedKeys.has(key) && (!waiting || keptKeys.has(key)))) continue;
    asked.push(url.href);
  }

  // The date and stale-price rules, as the worker applies them to pages added by hand.
  const today = new Date();
  const rules = planRules(source?.plan);
  const served = servedLanguages(source?.languages ?? [], d.language);
  // On the selection from before key pages: no intent line, and every page ages alike.
  const keys = await keyPagesSwitched(deploymentId, d);
  const facts = asked.length ? await pinFacts(asked, rows, today) : new Map<string, RenderedFacts>();
  const reason = keep?.reason.trim().slice(0, 300) ?? "";
  const keepFor = new Set((keep?.urls ?? asked).map((u) => pageKey(u)));
  const who = keep && reason.length >= 3 ? (keep.who ?? (await actorConfirmation(actor, today))) : undefined;
  const added: string[] = [];
  const keptNow: KeptPage[] = [];
  const needsReason: PinResult["needsReason"] = [];
  for (const url of asked) {
    const key = pageKey(url);
    const f = facts.get(key) ?? { url };
    const rule: KeepRule | undefined = keepRule(f, pageFlags(f, { served, today, keyPages: keys }), rules, today);
    if (rule && !(who && keepFor.has(key))) {
      const title = f.title ?? rows.get(key)?.title ?? undefined;
      needsReason.push({ url, rule: rule.ask, ...(title && { title }) });
      continue;
    }
    if (!pinnedKeys.has(key)) {
      if (pinned.length >= MAX_PINNED) {
        refused.push({ url, reason: `${MAX_PINNED} pages are already added by hand, the most a deployment keeps.` });
        continue;
      }
      pinned.push(url);
      pinnedKeys.add(key);
    }
    if (rule && who) {
      const record: KeptPage = { url, rule: rule.ask, reason, ...who };
      keptNow.push(record);
      const at = keptList.findIndex((k) => pageKey(k.url) === key);
      if (at >= 0) keptList[at] = record;
      else keptList.push(record);
    }
    added.push(url);
  }
  // Always include takes back the page's own Leave out line (the worker skips pages added by hand
  // whose exact path is left out).
  const addedPaths = new Set(added.map((u) => new URL(u).pathname));
  const excludePatterns = (source?.excludePatterns ?? []).filter((p) => !addedPaths.has(p));
  if (added.length && source) {
    await db().update(syncSources).set({ pinned, kept: keptList, excludePatterns }).where(eq(syncSources.id, source.id));
    const now = new Date();
    for (const url of added) {
      const row = rows.get(pageKey(url));
      // Already answerable or on its way: pinning keeps it whatever the budget. A page held for
      // a reason is synced as it is now that it's kept.
      if (row && ["indexed", "processing", "queued"].includes(row.status)) {
        if (row.detail?.replace(WOULD_LEAVE_OUT, "").startsWith(KEEP_ASKED)) {
          await db()
            .update(contentPages)
            .set({ detail: null })
            .where(and(eq(contentPages.deploymentId, deploymentId), eq(contentPages.url, row.url)));
        }
        continue;
      }
      if (row) {
        await db()
          .update(contentPages)
          .set({ status: "queued", detail: null, createdAt: now, keyIntent: keys ? (intentOf(url) ?? null) : null })
          .where(and(eq(contentPages.deploymentId, deploymentId), eq(contentPages.url, row.url)));
      } else {
        await db()
          .insert(contentPages)
          .values({ deploymentId, url, slug: slugFor(url), createdAt: now, keyIntent: keys ? (intentOf(url) ?? null) : null })
          .onConflictDoUpdate({ target: [contentPages.deploymentId, contentPages.url], set: { status: "queued", detail: null } });
      }
    }
    // The worker loads waiting pages of running syncs: a queued sync lists the added pages itself.
    await db()
      .update(syncSources)
      .set({ lastJobStatus: "running", startedAt: now, lastError: null })
      .where(
        and(
          eq(syncSources.id, source.id),
          or(isNull(syncSources.lastJobStatus), inArray(syncSources.lastJobStatus, ["ok", "partial", "failed"])),
        ),
      );
  }
  await audit(actor, deploymentId, "content.pin", {
    added,
    refused,
    ...(needsReason.length && { needsReason: needsReason.map((n) => ({ url: n.url, rule: n.rule })) }),
    ...(keptNow.length && { kept: keptNow.map((k) => ({ url: k.url, rule: k.rule, reason: k.reason })) }),
    ...(source &&
      excludePatterns.length < source.excludePatterns.length && {
        unexcluded: source.excludePatterns.filter((p) => addedPaths.has(p)),
      }),
    ...(who && { name: who.name, verified: who.verified }),
  });
  return { added, refused, needsReason };
}

// The signed-in person as a confirmation, for a keep without one (never setup mode: its typed
// name comes with the call).
async function actorConfirmation(actor: string | null, at: Date): Promise<Confirmation | undefined> {
  if (!actor) return undefined;
  const [user] = await db().select({ name: users.name, email: users.email }).from(users).where(eq(users.id, actor));
  return user ? { by: actor, name: user.name ?? user.email, at: at.toISOString(), verified: true } : undefined;
}

// Pages kept by hand although a date or stale-price rule leaves them out, still added by hand:
// Review's Content line ("Check this: 1 page kept by hand despite a stale price", keptSummary),
// with each page's name, reason and who kept it.
export interface KeptByHand extends KeptPage {
  kind: KeepRule["kind"];
  title?: string;
  status?: PageStatus;
}

export async function keptByHand(deploymentId: string): Promise<KeptByHand[]> {
  const [source] = await db()
    .select({ pinned: syncSources.pinned, kept: syncSources.kept })
    .from(syncSources)
    .where(and(eq(syncSources.deploymentId, deploymentId), eq(syncSources.kind, "sitemap")));
  const pinned = new Set((source?.pinned ?? []).map((u) => pageKey(u)));
  const kept = (source?.kept ?? []).filter((k) => pinned.has(pageKey(k.url)));
  if (!kept.length) return [];
  const rows = new Map(
    (
      await db()
        .select({ url: contentPages.url, title: contentPages.title, status: contentPages.status })
        .from(contentPages)
        .where(
          and(
            eq(contentPages.deploymentId, deploymentId),
            inArray(
              contentPages.url,
              kept.map((k) => k.url),
            ),
          ),
        )
    ).map((r) => [pageKey(r.url), r]),
  );
  return kept.map((k) => {
    const row = rows.get(pageKey(k.url));
    return { ...k, kind: keptKind(k.rule), ...(row?.title && { title: row.title }), ...(row && { status: row.status }) };
  });
}

// ---- key pages ----

export interface KeyPage {
  intent: KeyIntent;
  url: string;
  title?: string;
  // "not-synced": the plan's key page that the sync hasn't taken yet (deployments synced before
  // key pages existed); Bring up to date's Add (addKeyPages) takes it.
  status: PageStatus | "not-synced";
  detail?: string;
  // What it states, from its last read (content_pages.facts).
  facts?: PageFacts;
}

// The deployment's key pages: those the sync took, by intent (price, contact, support, buy,
// trial, faq). With plan, also the plan's key pages the sync hasn't taken, and the pages a
// re-sync would drop to make room for them.
export async function keyPages(deploymentId: string, opts: { plan?: boolean } = {}): Promise<KeyPage[]> {
  const rows = await db()
    .select({
      url: contentPages.url,
      title: contentPages.title,
      status: contentPages.status,
      detail: contentPages.detail,
      keyIntent: contentPages.keyIntent,
      facts: contentPages.facts,
    })
    .from(contentPages)
    .where(and(eq(contentPages.deploymentId, deploymentId), isNotNull(contentPages.keyIntent), ne(contentPages.status, "removed")));
  const pages: KeyPage[] = rows.flatMap((r) =>
    isKeyIntent(r.keyIntent)
      ? [
          {
            intent: r.keyIntent,
            url: r.url,
            ...(r.title && { title: r.title }),
            status: r.status,
            ...(r.detail && { detail: r.detail }),
            ...(r.facts && { facts: r.facts }),
          },
        ]
      : [],
  );
  if (opts.plan) pages.push(...(await keyPageChanges(deploymentId)).add);
  return pages.sort((a, b) => KEY_INTENTS.indexOf(a.intent) - KEY_INTENTS.indexOf(b.intent) || (a.url < b.url ? -1 : 1));
}

// ---- what the site states (content_pages.facts): for checking answers against ----

export interface KeyPageFacts {
  url: string;
  title?: string;
  intent: KeyIntent;
  facts: PageFacts;
}

// The facts of the key pages that answer an intent's questions (a price question: pricing and
// buying pages; contact: contact and support pages), answerable now, those of the question's own
// intent first. For validation's evidence check ("The pricing page /how-to-buy states $59
// (Business) and $189 (Enterprise); this answer gives neither") and the judge.
// lang: the question's language: its own language's pages, when there are any (a French
// question is checked against /fr/prix, not /es/precio). Within an intent, the site's main page
// first: the shallowest address after any language folder, so teamwork.com's /pricing/ comes
// before /desk/pricing/ (an add-on's).
export async function keyFacts(deploymentId: string, intent: KeyIntent, lang?: string): Promise<KeyPageFacts[]> {
  const answering = [...answeringIntents([intent])];
  const rows = await db()
    .select({
      url: contentPages.url,
      title: contentPages.title,
      keyIntent: contentPages.keyIntent,
      facts: contentPages.facts,
      lang: contentPages.lang,
    })
    .from(contentPages)
    .where(
      and(
        eq(contentPages.deploymentId, deploymentId),
        inArray(contentPages.keyIntent, answering),
        // In the chat now: answerable, or being read again from its indexed copy.
        or(
          eq(contentPages.status, "indexed"),
          and(inArray(contentPages.status, ["queued", "processing"]), isNotNull(contentPages.indexedAt)),
        ),
      ),
    );
  const pageLang = (r: { url: string; lang: string | null }) => primaryLanguage(pathLanguage(r.url) ?? r.lang ?? "und");
  const own = lang ? rows.filter((r) => pageLang(r) === primaryLanguage(lang)) : [];
  return (own.length ? own : rows)
    .flatMap((r) =>
      isKeyIntent(r.keyIntent)
        ? [{ url: r.url, ...(r.title && { title: r.title }), intent: r.keyIntent, facts: r.facts ?? {}, depth: mainDepth(r.url) }]
        : [],
    )
    .sort((a, b) => answering.indexOf(a.intent) - answering.indexOf(b.intent) || a.depth - b.depth || (a.url < b.url ? -1 : 1))
    .map(({ depth: _depth, ...page }) => page);
}

// How deep an address is below any language folder: the site's main pages are the shallowest.
const mainDepth = (url: string) => {
  const segments = new URL(url).pathname.split("/").filter(Boolean);
  return segments.length - (segments[0] && pathLanguage(`${new URL(url).origin}/${segments[0]}`) ? 1 : 0);
};

// What the price table's note can say without a table: a first sync still reading ("reading"), a page
// read (true), or none (false).
// Whether any of the deployment's pages has been read: before that, nothing is known about a pricing
// page (noPriceTableNote). A query that fails says yes, the note's plain case.
export async function priceTableRead(deploymentId: string): Promise<boolean | "reading"> {
  const [source] = await db()
    .select({ lastSyncedAt: syncSources.lastSyncedAt })
    .from(syncSources)
    .where(and(eq(syncSources.deploymentId, deploymentId), eq(syncSources.kind, "sitemap")))
    .limit(1)
    .catch(() => []);
  const read = await anyPageRead(deploymentId);
  return source && !source.lastSyncedAt && read ? "reading" : read;
}

export async function anyPageRead(deploymentId: string): Promise<boolean> {
  const [row] = await db()
    .select({ id: contentPages.id })
    .from(contentPages)
    .where(and(eq(contentPages.deploymentId, deploymentId), inArray(contentPages.status, ["indexed", "processing", "skipped", "failed"])))
    .limit(1)
    .catch(() => [{ id: "unknown" }]);
  return Boolean(row);
}

export interface UpcomingEvent {
  // ISO day, on or after today.
  date: string;
  line: string;
  readAs: string;
  url: string;
  title?: string;
  lang?: string;
}

// The dates still to come that the deployment's pages in the chat state, soonest first, with
// their pages: dates written without a year as they were placed at ingest. For validation's
// events questions and its check that no answer calls a future date past.
export async function upcomingEvents(deploymentId: string, today = new Date()): Promise<UpcomingEvent[]> {
  const day = today.toISOString().slice(0, 10);
  const rows = await db()
    .select({ url: contentPages.url, title: contentPages.title, facts: contentPages.facts, lang: contentPages.lang })
    .from(contentPages)
    .where(
      and(
        eq(contentPages.deploymentId, deploymentId),
        sql`jsonb_array_length(coalesce(${contentPages.facts}->'events', '[]'::jsonb)) > 0`,
        or(
          eq(contentPages.status, "indexed"),
          and(inArray(contentPages.status, ["queued", "processing"]), isNotNull(contentPages.indexedAt)),
        ),
      ),
    );
  return rows
    .flatMap((r) =>
      (r.facts?.events ?? [])
        .filter((e) => e.date && e.date >= day && !publicationStamp(e.line))
        .map((e) => ({
          date: e.date,
          line: e.line,
          readAs: e.readAs,
          url: r.url,
          ...(r.title && { title: r.title }),
          ...(r.lang && { lang: r.lang }),
        })),
    )
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.url < b.url ? -1 : 1));
}

// The upcoming events as the events configuration's prompt lists them (prompt.ts eventsParagraph):
// upcomingEvents with each page's own heading, the event's name on an event page ("The Agency of
// 2027: Turning AI Savings Into Margin", where the title is "How AI Impacts Agency Profit Margins").
export async function eventsForPrompt(deploymentId: string, today = new Date()): Promise<PromptEvent[]> {
  const events = await upcomingEvents(deploymentId, today);
  const urls = [...new Set(events.map((e) => e.url))];
  const rows = urls.length
    ? await db()
        .select({ url: contentPages.url, heading: sql<string | null>`substring(${contentPages.text} from '(?:^|\n)# ([^\n]+)')` })
        .from(contentPages)
        .where(and(eq(contentPages.deploymentId, deploymentId), inArray(contentPages.url, urls)))
    : [];
  const headings = new Map(rows.map((r) => [r.url, r.heading?.trim() || undefined]));
  return events.map((e) => {
    const name = headings.get(e.url);
    return {
      date: e.date,
      url: e.url,
      line: e.line,
      ...(name && { name }),
      ...(e.title && { title: e.title }),
      ...(e.lang && { lang: e.lang }),
    };
  });
}

// The Knowledge Box resource ids of the key pages that answer an intent's questions (and, for
// "events", of the pages stating a date still to come): what a routed ask filters on while pages
// sent before labels existed wait to be read again (content-plan.ts labelFilter takes them).
export async function keyPageResources(
  deploymentId: string,
  intent: KeyIntent | "events",
  today = new Date(),
  opts: { main?: boolean } = {},
): Promise<string[]> {
  if (intent === "events") {
    const events = await upcomingEvents(deploymentId, today);
    const urls = [...new Set(events.map((e) => e.url))];
    if (!urls.length) return [];
    const rows = await db()
      .select({ resourceId: contentPages.resourceId })
      .from(contentPages)
      .where(and(eq(contentPages.deploymentId, deploymentId), inArray(contentPages.url, urls), isNotNull(contentPages.resourceId)));
    return rows.map((r) => r.resourceId!);
  }
  const answering = [...answeringIntents([intent])];
  const rows = await db()
    .select({ resourceId: contentPages.resourceId, url: contentPages.url, keyIntent: contentPages.keyIntent, lang: contentPages.lang })
    .from(contentPages)
    .where(
      and(
        eq(contentPages.deploymentId, deploymentId),
        inArray(contentPages.keyIntent, answering),
        isNotNull(contentPages.resourceId),
        or(
          eq(contentPages.status, "indexed"),
          and(inArray(contentPages.status, ["queued", "processing"]), isNotNull(contentPages.indexedAt)),
        ),
      ),
    );
  // The intent's own pages before those that also answer it, the site's main page first.
  const sorted = rows.sort(
    (a, b) =>
      answering.indexOf(a.keyIntent as KeyIntent) - answering.indexOf(b.keyIntent as KeyIntent) ||
      mainDepth(a.url) - mainDepth(b.url) ||
      (a.url < b.url ? -1 : 1),
  );
  if (!opts.main) return sorted.map((r) => r.resourceId!);
  // main: per language, only the shallowest pages of the intent itself (teamwork.com's /pricing/,
  // not /desk/pricing/), for a generic question; the others when it has none.
  const own = sorted.filter((r) => r.keyIntent === intent);
  const pool = own.length ? own : sorted;
  const byLang = new Map<string, number>();
  for (const r of pool) {
    const l = primaryLanguage(pathLanguage(r.url) ?? r.lang ?? "und");
    byLang.set(l, Math.min(byLang.get(l) ?? Number.POSITIVE_INFINITY, mainDepth(r.url)));
  }
  return pool
    .filter((r) => mainDepth(r.url) === byLang.get(primaryLanguage(pathLanguage(r.url) ?? r.lang ?? "und")))
    .map((r) => r.resourceId!);
}

// What switching to today's selection would change on a deployment synced before key pages:
// the key pages that join, every other page that joins and why, and every page that leaves, as
// the next sync lists them (the worker's selectPages, pages added by hand, and pages synced in
// place of a duplicate). Key pages come in place of the pages at the end of the budget; other
// changes are the FAQ, help and support pages no longer left out by age. Nothing changes until
// addKeyPages.
export interface KeyPageChanges {
  add: KeyPage[];
  join: { url: string; title?: string; why: string }[];
  drop: { url: string; title?: string }[];
}

export async function keyPageChanges(deploymentId: string): Promise<KeyPageChanges> {
  const [d] = await db()
    .select({ siteUrl: deployments.siteUrl, language: deployments.language })
    .from(deployments)
    .where(eq(deployments.id, deploymentId));
  const [source] = await db()
    .select()
    .from(syncSources)
    .where(and(eq(syncSources.deploymentId, deploymentId), eq(syncSources.kind, "sitemap")));
  if (!d || !source) return { add: [], join: [], drop: [] };
  const entries = await sourceEntries(d, source);
  if (!entries) return { add: [], join: [], drop: [] };
  const rows = await db()
    .select({
      url: contentPages.url,
      title: contentPages.title,
      status: contentPages.status,
      detail: contentPages.detail,
      flags: contentPages.flags,
    })
    .from(contentPages)
    .where(eq(contentPages.deploymentId, deploymentId));
  const existing = new Map(rows.map((r) => [pageKey(r.url), r]));
  const pinned = new Set(source.pinned.filter((u) => !source.excludePatterns.includes(new URL(u).pathname)).map((u) => pageKey(u)));
  const { ranked } = syncRanking(d, source, entries, rows, true);
  const listed = selectPages(ranked, existing, source.pageBudget ?? DEFAULT_PAGE_BUDGET, pinned);
  const listedKeys = new Set(listed.map((c) => c.key));
  // Pages synced in place of a listed duplicate stay, as the worker keeps them.
  const replacements = new Set(
    rows.flatMap((r) => {
      const target = r.status === "skipped" && listedKeys.has(pageKey(r.url)) ? duplicateTarget(r.detail) : undefined;
      return target ? [pageKey(target)] : [];
    }),
  );
  const taking = (status: string | undefined) => status !== undefined && ["queued", "processing", "indexed", "failed"].includes(status);
  // Listed pages not in the sync now that loading hasn't already left out.
  const joining = listed.filter((c) => !taking(existing.get(c.key)?.status) && existing.get(c.key)?.status !== "skipped");
  const add: KeyPage[] = joining
    .filter((c) => c.keyPage && c.intent)
    .map((c) => {
      const row = existing.get(c.key);
      return {
        intent: c.intent!,
        url: c.entry.url,
        ...(row?.title && { title: row.title }),
        status: "not-synced" as const,
        detail: "Not synced yet: checked as it loads, and replaced by the next page for the same question if it can't be used.",
      };
    });
  const join = joining
    .filter((c) => !(c.keyPage && c.intent))
    .map((c) => {
      const row = existing.get(c.key);
      return {
        url: c.entry.url,
        ...(row?.title && { title: row.title }),
        why: isEvergreenUrl(c.entry.url)
          ? "An FAQ, help or support page that today's rules no longer leave out by age alone."
          : "Comes back in as the sections take their turns with the other changes.",
      };
    });
  const drop = rows
    .filter((r) => taking(r.status) && !pinned.has(pageKey(r.url)) && !listedKeys.has(pageKey(r.url)) && !replacements.has(pageKey(r.url)))
    .map((r) => ({ url: r.url, ...(r.title && { title: r.title }) }));
  return { add, join, drop };
}

// Bring up to date's Add: switches a live deployment signed off under older checks to today's
// selection (key pages, and key, FAQ, help and support pages never left out by age alone; the
// audit entry is the switch the worker reads), and re-syncs: the key pages join and the pages at
// the end of the budget leave. Returns the key pages it adds.
// The sync starts now even while another runs (a re-read clicked seconds before: round 5's "Add
// said Done while no key page had joined"): the running one starts over with today's selection,
// as Leave out does, and the pages it was reading again stay queued in it. The entry records the
// pages in the sync before Add; once its sync finishes, the worker replaces the preview with what
// actually joined and left (settleKeyPages), which History and step 2 then show.
export async function addKeyPages(deploymentId: string, actor: string | null, name?: string): Promise<string[]> {
  const { add, join, drop } = await keyPageChanges(deploymentId);
  const before = await db()
    .select({ url: contentPages.url })
    .from(contentPages)
    .where(and(eq(contentPages.deploymentId, deploymentId), inArray(contentPages.status, ["queued", "processing", "indexed"])));
  await audit(actor, deploymentId, "content.key-pages", {
    added: add.map((k) => k.url),
    joined: join.map((p) => p.url),
    dropped: drop.map((p) => p.url),
    before: before.map((r) => r.url),
    ...(name && { name }),
  });
  await ensureContentSync(deploymentId);
  await db()
    .update(syncSources)
    .set({ lastJobStatus: "queued", lastError: null })
    .where(and(eq(syncSources.deploymentId, deploymentId), eq(syncSources.kind, "sitemap")));
  await audit(actor, deploymentId, "content.sync", { ...(name && { name }) });
  return add.map((k) => k.url);
}

// Add's outcome for step 2 and History: settled once its sync has finished, with the key pages
// that joined, the other pages that joined and the pages that left; until then, what it proposed
// and whether the key pages it proposed are in yet. Entries from before Add recorded what was in
// the sync count as settled once no sync runs. Pure.
export function keyPagesState(
  detail: Record<string, unknown>,
  keysNow: readonly { url: string; status: string }[],
  syncing: boolean,
): { settled: boolean; added: string[]; joined: string[]; dropped: string[]; waiting: string[]; unusable: string[] } {
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((u): u is string => typeof u === "string") : []);
  const proposed = (detail.proposed ?? {}) as Record<string, unknown>;
  const asked = detail.settled && detail.proposed ? list(proposed.added) : list(detail.added);
  const status = new Map(keysNow.map((k) => [pageKey(k.url), k.status]));
  const waiting = asked.filter((u) => ["queued", "processing", undefined].includes(status.get(pageKey(u))));
  const unusable = asked.filter((u) => ["skipped", "failed"].includes(status.get(pageKey(u)) ?? ""));
  const settled = Boolean(detail.settled) || (!("before" in detail) && !syncing);
  return { settled, added: list(detail.added), joined: list(detail.joined), dropped: list(detail.dropped), waiting, unusable };
}

// ---- content changes since sign-off ----

export interface ContentChange {
  kind: "added" | "kept" | "left-out" | "key-pages" | "settings";
  url?: string;
  // "Added by hand: /contact", for "Changed since sign-off".
  label: string;
  at: string;
  by: string | null;
  // The typed or signed-in name, when the change recorded one.
  name?: string;
  reason?: string;
}

const SETTING_NAMES: Record<string, string> = {
  pageBudget: "page budget",
  include: "Only these paths",
  exclude: "Leave out",
  resyncHours: "re-sync interval",
  startUrl: "start page",
  sitemap: "sitemap address",
};

// The audit entries contentChangesSince reads (Fleet looks for them first, dashboard.ts).
export const CONTENT_CHANGE_ACTIONS = ["content.pin", "content.exclude", "content.key-pages", "content.settings"] as const;

// Pages added, kept or left out by hand, key pages added, and content settings changed since
// a moment (the sign-off), where they still differ: a page added and then left out again, or
// settings put back, aren't listed.
export async function contentChangesSince(deploymentId: string, since: Date | string): Promise<ContentChange[]> {
  const at = typeof since === "string" ? new Date(since) : since;
  const entries = await db()
    .select()
    .from(auditLog)
    .where(
      and(
        eq(auditLog.targetType, "deployment"),
        eq(auditLog.targetId, deploymentId),
        gt(auditLog.at, at),
        inArray(auditLog.action, [...CONTENT_CHANGE_ACTIONS]),
      ),
    )
    .orderBy(asc(auditLog.at), asc(auditLog.id));
  if (!entries.length) return [];
  const [source] = await db()
    .select()
    .from(syncSources)
    .where(and(eq(syncSources.deploymentId, deploymentId), eq(syncSources.kind, "sitemap")));
  const pinned = new Set((source?.pinned ?? []).map((u) => pageKey(u)));
  const excluded = new Set(source?.excludePatterns ?? []);
  const byUrl = new Map<string, ContentChange>();
  const keyAdded: ContentChange[] = [];
  let settingsBefore: Record<string, unknown> | undefined;
  let settingsAt: { at: string; by: string | null } | undefined;
  const pathOf = (url: string) => {
    try {
      return new URL(url).pathname;
    } catch {
      return url;
    }
  };
  for (const e of entries) {
    const detail = (e.detail ?? {}) as Record<string, unknown>;
    const base = { at: e.at.toISOString(), by: e.actorUserId, ...(typeof detail.name === "string" && { name: detail.name }) };
    if (e.action === "content.pin") {
      for (const url of Array.isArray(detail.added) ? detail.added.filter((u): u is string => typeof u === "string") : []) {
        byUrl.set(pageKey(url), { kind: "added", url, label: `Added by hand: ${pathOf(url)}`, ...base });
      }
      for (const k of Array.isArray(detail.kept) ? (detail.kept as { url?: unknown; rule?: unknown; reason?: unknown }[]) : []) {
        if (typeof k.url !== "string") continue;
        const despite = typeof k.rule === "string" && keptKind(k.rule) === "stale-price" ? "a stale price" : "its date";
        byUrl.set(pageKey(k.url), {
          kind: "kept",
          url: k.url,
          label: `Kept by hand despite ${despite}: ${pathOf(k.url)}`,
          ...base,
          ...(typeof k.reason === "string" && { reason: k.reason }),
        });
      }
    } else if (e.action === "content.exclude" && typeof detail.url === "string") {
      const key = pageKey(detail.url);
      const before = byUrl.get(key);
      // Added (or kept) after the sign-off and left out again: visitors had it meanwhile.
      if (before?.kind === "added" || before?.kind === "kept") {
        const minutes = Math.max(1, Math.round((e.at.getTime() - Date.parse(before.at)) / 60_000));
        byUrl.set(key, {
          kind: "left-out",
          url: detail.url,
          label: `${before.label}, then left out again: in the chat for about ${minutes} min`,
          ...base,
          ...(before.reason && { reason: before.reason }),
        });
      } else byUrl.set(key, { kind: "left-out", url: detail.url, label: `Left out by hand: ${pathOf(detail.url)}`, ...base });
    } else if (e.action === "content.key-pages") {
      const added = Array.isArray(detail.added) ? detail.added.filter((u): u is string => typeof u === "string") : [];
      if (added.length) keyAdded.push({ kind: "key-pages", label: `Key pages added: ${added.map(pathOf).join(", ")}`, ...base });
    } else if (e.action === "content.settings" && detail.before && typeof detail.before === "object") {
      settingsBefore ??= detail.before as Record<string, unknown>;
      settingsAt = { at: base.at, by: base.by };
    }
  }
  const changes = [...byUrl.values()].filter((c) => (c.kind === "left-out" ? excluded.has(pathOf(c.url!)) : pinned.has(pageKey(c.url!))));
  if (settingsBefore && source && settingsAt) {
    const leftOutByHand = new Set(changes.filter((c) => c.kind === "left-out").map((c) => pathOf(c.url!)));
    const sitemap = isSitemapAddress(source.sitemapUrl) ? source.sitemapUrl : null;
    const now: Record<string, unknown> = {
      startUrl: sitemap ? null : source.sitemapUrl,
      sitemap,
      pageBudget: source.pageBudget,
      include: source.includePatterns,
      exclude: source.excludePatterns.filter((p) => !leftOutByHand.has(p)),
      resyncHours: source.resyncHours,
    };
    const differs = Object.keys(SETTING_NAMES).filter((k) => {
      const before =
        k === "exclude" && Array.isArray(settingsBefore![k])
          ? (settingsBefore![k] as string[]).filter((p) => !leftOutByHand.has(p))
          : settingsBefore![k];
      return JSON.stringify(before ?? null) !== JSON.stringify(now[k] ?? null);
    });
    if (differs.length) {
      changes.push({ kind: "settings", label: `Content settings: ${differs.map((k) => SETTING_NAMES[k]).join(", ")}`, ...settingsAt });
    }
  }
  return [...changes, ...keyAdded].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}
