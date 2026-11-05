// Every page a deployment synced: its status, its own dates beside the sitemap's, its flags
// (conversion, old, other language, overview, short text, a stale price, a date without a year
// that couldn't be placed), why a page was left out or failed, how each date without a year was
// read, the text the chatbot answers from, and a way to leave a page out for good. A search over
// every page in the sitemap by address and title, and every synced page by its text, with near
// misses, adds a page by hand (Always include), asking first when the page trips a date or
// stale-price rule (Keep it anyway, with a reason). Key pages (pricing, contact, support…) are
// labelled with their intent and what they state ("States: $ 59 per node, per year · $ 189"). A
// page being read again is still answerable from its current copy, and says so.

import Link from "next/link";
import { notFound } from "next/navigation";
import { FocusNotice } from "@/components/focus.tsx";
import { PageProblem } from "@/components/page-problem.tsx";
import { Badge, type Tone } from "@/components/ui.tsx";
import { currentUser } from "@/lib/auth.ts";
import {
  flagCounts,
  keyPages,
  keyPagesUnused,
  loadContent,
  loadPages,
  matchNote,
  type PageStatus,
  pageText,
  rereadNote,
  rereadState,
  sitemapCandidates,
  thinKeyPages,
} from "@/lib/content.ts";
import {
  countLine,
  FLAG_LABELS,
  factsLine,
  formatPlanDay,
  intentName,
  isKeyIntent,
  KEEP_ASKED,
  keptKind,
  MAX_PINNED,
  PAGE_FLAGS,
  type PageFlag,
  pageKey,
  pageLabel,
  planRules,
  shownDetail,
  WOULD_LEAVE_OUT,
} from "@/lib/content-plan.ts";
import { loadDeployment } from "@/lib/provisioning.ts";
import { isRefusalNote } from "@/lib/site-refusal.ts";
import { readPagesAgain } from "./actions.ts";
import { AlwaysInclude } from "./always-include.tsx";
import { LeaveOut } from "./leave-out.tsx";

export const dynamic = "force-dynamic";
export const metadata = { title: "Content" };

type Props = {
  params: Promise<{ id: string; deploymentId: string }>;
  searchParams: Promise<{
    status?: string;
    flag?: string;
    text?: string;
    excluded?: string;
    q?: string;
    reread?: string;
  }>;
};

// Status words; a page being read again from its indexed copy reads as answerable (inChat).
const STATUS: Record<PageStatus, [Tone, string]> = {
  indexed: ["good", "Answerable"],
  processing: ["neutral", "Processing"],
  queued: ["neutral", "Waiting"],
  skipped: ["warning", "Left out"],
  failed: ["critical", "Failed"],
  removed: ["neutral", "Removed"],
};
const FILTERS: (PageStatus | "all")[] = ["all", "indexed", "processing", "queued", "skipped", "failed", "removed"];
// The worker loads about this many pages a minute.
const PAGES_PER_MINUTE = 60;
// Long titles, addresses and reasons wrap, so the table fits a 1280 px window with its actions.
const WRAP = { whiteSpace: "normal", overflowWrap: "anywhere" } as const;

const n = (value: number) => value.toLocaleString("en");
const day = (at: Date) => formatPlanDay(at.toISOString().slice(0, 10));

// "Published 11 Oct 2016 · sitemap 25 Sep 2026": the page's own dates first, then the sitemap's.
function dates(p: {
  publishedAt: Date | null;
  pageModifiedAt: Date | null;
  sitemapLastmod: Date | null;
  lastModified: Date | null;
}): string | undefined {
  const parts: string[] = [];
  if (p.publishedAt) parts.push(`Published ${day(p.publishedAt)}`);
  if (p.pageModifiedAt && (!p.publishedAt || day(p.pageModifiedAt) !== day(p.publishedAt))) {
    parts.push(`${p.publishedAt ? "updated" : "Updated"} ${day(p.pageModifiedAt)}`);
  }
  if (p.sitemapLastmod) parts.push(`sitemap ${day(p.sitemapLastmod)}`);
  // Synced before the page's own dates were read: the one date kept then.
  else if (!parts.length && p.lastModified) parts.push(`Last modified ${day(p.lastModified)}`);
  if (!parts.length) return undefined;
  const text = parts.join(" · ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// A stale price on a page that stays in reads as something to check, with the year.
const flagText = (flag: PageFlag, publishedAt: Date | null) =>
  flag === "stale-commercial" && publishedAt
    ? `Check this: states a price or offer, published ${publishedAt.getUTCFullYear()}`
    : FLAG_LABELS[flag];

// In the chat: answerable, or being read again (or reprocessed) from the copy indexed before.
const inChat = (p: { status: PageStatus; indexedAt: Date | null }) =>
  p.status === "indexed" || ((p.status === "queued" || p.status === "processing") && Boolean(p.indexedAt));

// How each date without a year was read ("Read as 5 November 2026, from the sitemap date"), and
// any that couldn't be placed: the dates' own words as the page wrote them.
function readDates(facts: { events?: { date: string; line: string; readAs: string }[] } | null): string[] {
  return (facts?.events ?? [])
    .filter((e) => !e.readAs.endsWith(", as written"))
    .map((e) => (e.date ? `Read as ${e.readAs}: “${e.line}”` : `${e.readAs} “${e.line}”`));
}

export default async function ContentPage({ params, searchParams }: Props) {
  const { id, deploymentId } = await params;
  const { status, flag: rawFlag, text, excluded, q, reread: rereadQueued } = await searchParams;
  const row = await loadDeployment(id, deploymentId);
  if (!row) notFound();
  const filter = FILTERS.includes(status as PageStatus) && status !== "all" ? (status as PageStatus) : undefined;
  const flag = PAGE_FLAGS.includes(rawFlag as PageFlag) ? (rawFlag as PageFlag) : undefined;
  const search = q?.trim().slice(0, 200);
  const [pages, shown, content, flags, found, keys, user, unusedKeys, reread, thinKeys] = await Promise.all([
    loadPages(deploymentId, { ...(filter && { status: filter }), ...(flag && { flag }) }),
    text ? pageText(deploymentId, text) : undefined,
    loadContent(deploymentId),
    flagCounts(deploymentId),
    search ? sitemapCandidates(deploymentId, search, 20).catch(() => undefined) : undefined,
    keyPages(deploymentId),
    currentUser(),
    keyPagesUnused(deploymentId),
    rereadState(deploymentId),
    thinKeyPages(deploymentId),
  ]);
  const base = `/customers/${id}/deployments/${deploymentId}`;
  const query = (over: { status?: string; flag?: string; text?: string }) => {
    const q = new URLSearchParams();
    const s = "status" in over ? over.status : filter;
    const f = "flag" in over ? over.flag : flag;
    if (s) q.set("status", s);
    if (f) q.set("flag", f);
    if (over.text) q.set("text", over.text);
    const qs = q.toString();
    return `${base}/content${qs ? `?${qs}` : ""}`;
  };
  const source = content.source;
  const pinned = source?.pinned ?? [];
  const pinnedKeys = new Set(pinned.map((u) => pageKey(u)));
  // Pages kept by hand despite a date or stale-price rule, by page.
  const keptBy = new Map((source?.kept ?? []).filter((k) => pinnedKeys.has(pageKey(k.url))).map((k) => [pageKey(k.url), k]));
  const keysInSync = keys.filter((k) => k.status === "indexed" || k.status === "processing" || k.status === "queued");
  // What each key page in the sync states, for checking answers against it at a glance.
  const keysStating = keysInSync.filter((k) => factsLine(k.facts));
  // A page added by hand that waits for a reason, or one the rules left out: Always include
  // offers to keep it (asking first when a rule applies).
  const waitsForReason = (detail: string | null | undefined) => Boolean(detail?.replace(WOULD_LEAVE_OUT, "").startsWith(KEEP_ASKED));
  const includable = (p: { url: string; status: PageStatus; detail: string | null }) =>
    p.status === "skipped" && (!pinnedKeys.has(pageKey(p.url)) || waitsForReason(p.detail));
  const filteredTo = [filter && STATUS[filter][1].toLowerCase(), flag && FLAG_LABELS[flag].toLowerCase()].filter(Boolean).join(", ");

  return (
    <main id="main" className="shell">
      <p className="crumbs">
        <Link href={`${base}#content`}>{row.deployment.name}</Link>
      </p>
      <div className="page-head">
        <h1>Content</h1>
        <p className="muted">
          Pages synced from {new URL(row.deployment.siteUrl).host}. Leaving a page out adds its path to the content settings' exclusions,
          and it leaves the chat within a minute.
        </p>
      </div>
      {excluded && (
        <p className="notice" role="status">
          Page left out. It leaves the chat within a minute, whether or not a sync is running.
        </p>
      )}

      {source && (
        <section className="panel" id="summary" aria-label="Summary">
          <p>
            {countLine({
              ...(source.plan && { total: source.plan.total }),
              found: source.pagesFound,
              budget: source.pageBudget ?? 200,
              include: source.includePatterns,
              exclude: source.excludePatterns,
              languages: source.languages,
              rules: planRules(source.plan),
              discovery: source.discovery,
              pinned: pinned.length,
            })}{" "}
            {n(content.listed)} {content.listed === 1 ? "page is" : "pages are"} listed below ({n(content.counts.indexed)} answerable).
          </p>
          {content.rateLimitedNote && (
            <p className="notice" data-tone="warning" role="status">
              {content.rateLimitedNote}
            </p>
          )}
          {isRefusalNote(source.lastError) ? (
            <p className="notice" data-tone="warning" role="status">
              {source.lastError}
            </p>
          ) : (
            source.lastJobStatus === "partial" && source.lastError && <p className="help">{source.lastError}</p>
          )}
          <p>
            Oldest page taken: <strong>{content.oldestTaken ? formatPlanDay(content.oldestTaken) : "none dated yet"}</strong>
            {source.plan?.oldestTaken && source.plan.oldestTaken !== content.oldestTaken && (
              <span className="muted"> (the plan expected {formatPlanDay(source.plan.oldestTaken)})</span>
            )}
            . <span className="muted">By each page's own date where it states one, else the sitemap's.</span>
          </p>
          {keys.length > 0 && (
            <p>
              Key pages: <strong>{n(keysInSync.length)}</strong> in the sync (
              {[...new Set(keysInSync.map((k) => pageLabel(new URL(k.url).pathname)))].slice(0, 8).join(", ")}
              {keysInSync.length > 8 ? "…" : ""}).{" "}
              <span className="muted">
                Pricing, contact, support and similar pages, taken ahead of the sections and never left out by age alone.
              </span>
            </p>
          )}
          {keysStating.length > 0 && (
            <ul className="plain" aria-label="What the key pages state">
              {keysStating.map((k) => (
                <li key={k.url} style={WRAP}>
                  <Badge tone="neutral">{intentName(k.intent)}</Badge> {new URL(k.url).pathname}:{" "}
                  <span className="muted">{factsLine(k.facts)}</span>
                </li>
              ))}
            </ul>
          )}
          {rereadNote(content) && (
            <p role="status">
              {rereadNote(content)} <span className="muted">Each row shows what it found as it's read.</span>
            </p>
          )}
          {rereadQueued !== undefined ? (
            <FocusNotice>
              {n(Number(rereadQueued) || reread.reading)} {Number(rereadQueued) === 1 ? "page is" : "pages are"} being read again with
              today's extractor and rules. They stay in the chat meanwhile, and each row shows what it found as it's read.
            </FocusNotice>
          ) : (
            reread.outOfDate > 0 && (
              <form action={readPagesAgain.bind(null, id, deploymentId)} className="actions">
                <p>
                  {n(reread.outOfDate)} {reread.outOfDate === 1 ? "page was" : "pages were"} read under an older extractor or older rules
                  {reread.reading ? `, ${n(reread.reading)} of them being read again now` : ""}.{" "}
                  <span className="muted">
                    The overnight job reads them again between 00:00 and 06:00 server time; they stay in the chat meanwhile.
                  </span>
                </p>
                {!reread.reading && (
                  <button type="submit" className="button secondary">
                    Read the pages again
                  </button>
                )}
              </form>
            )
          )}
          {unusedKeys.length > 0 && (
            <div className="notice" data-tone="warning">
              <p>
                {n(unusedKeys.length)} key {unusedKeys.length === 1 ? "page the plan took couldn't" : "pages the plan took couldn't"} be
                used. Each gave its place to the next page for the same question, where the site has one:
              </p>
              <ul>
                {unusedKeys.map((k) => (
                  <li key={k.url} style={WRAP}>
                    <Badge tone="neutral">{intentName(k.intent)}</Badge> {k.why}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {thinKeys.length > 0 && (
            <div className="notice" data-tone="warning">
              <p>
                {n(thinKeys.length)} contact key {thinKeys.length === 1 ? "page is" : "pages are"} too thin to answer a contact question:
              </p>
              <ul>
                {thinKeys.map((k) => (
                  <li key={k.url} style={WRAP}>
                    <Badge tone="neutral">{intentName(k.intent)}</Badge> {k.why}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {content.estimate && content.estimate.pagesLeft > 0 && (
            <p role="status">
              {content.estimate.first ? "First sync" : "Sync"}: {content.estimate.text} ({n(content.estimate.pagesLeft)}{" "}
              {content.estimate.pagesLeft === 1 ? "page" : "pages"} to go).
            </p>
          )}
          {content.queueAhead !== undefined && (
            <p role="status">
              In line:{" "}
              {content.queueAhead === 0
                ? "next"
                : `${n(content.queueAhead)} ${content.queueAhead === 1 ? "page from another deployment" : "pages from other deployments"} ahead`}
              {content.queueAhead > 0 && ` (about ${Math.ceil(content.queueAhead / PAGES_PER_MINUTE)} min)`}. Pages added by hand go first,
              then new deployments' first syncs, then re-syncs, then pages read again for a newer extractor.
            </p>
          )}
        </section>
      )}

      {shown && (
        <section className="panel" aria-labelledby="text-title">
          <div className="panel-head">
            <h2 id="text-title">{shown.title ?? shown.url}</h2>
            <Link href={query({})}>Close</Link>
          </div>
          <p className="help">
            The text the chatbot answers from, as extracted from{" "}
            <a href={shown.url} target="_blank" rel="noreferrer">
              {shown.url}
            </a>
            : the page's main content, without its header, navigation and footer.
          </p>
          {/* The text scrolls on its own, so its labelled region takes keyboard focus to be scrolled (axe scrollable-region-focusable). */}
          {/* biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling region must be focusable to be scrolled by keyboard */}
          <section className="prompt extracted" tabIndex={0} aria-label={`Extracted text of ${shown.title ?? shown.url}`}>
            <pre style={{ margin: 0, font: "inherit", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
              {shown.text ?? "Not sent yet."}
            </pre>
          </section>
        </section>
      )}

      <section className="panel" id="search" aria-labelledby="search-title">
        <h2 id="search-title">Find a page on the site</h2>
        <form method="get" action={`${base}/content#search`} className="actions">
          <label htmlFor="page-search" className="sr-only">
            Words in the page's address, title or text
          </label>
          <input id="page-search" name="q" type="search" defaultValue={search ?? ""} placeholder="e.g. crayon painted wall" />
          <button type="submit" className="button secondary">
            Search
          </button>
        </form>
        <p className="help">
          Searches every page in the sitemap, synced or not, by the words in its address and title; every synced page by its text, each word
          on its own; and by one word like "contact" or "price" for the site's key pages. Near misses follow the matches. Try the client's
          own word for it: the site may name the thing differently. Always include keeps a page whatever the budget and the plan's rules, up
          to {MAX_PINNED}, and syncs it ahead of every waiting page. A page the date or stale-price rules leave out asks first, and is kept
          only with a reason.
          {pinned.length > 0 && ` ${n(pinned.length)} added by hand so far${keptBy.size ? `, ${n(keptBy.size)} kept despite a rule` : ""}.`}
        </p>
        {search && found === undefined && <p className="notice">The site's sitemap couldn't be read just now. Try again shortly.</p>}
        {search && found?.length === 0 && (
          <p className="muted">No page holds any of those words, in its address, its title or its synced text. Try another word for it.</p>
        )}
        {found && found.length > 0 && (
          <ul className="plain">
            {found.map((c) => (
              <li key={c.url} style={WRAP}>
                <a href={c.url} target="_blank" rel="noreferrer">
                  {c.title ?? new URL(c.url).pathname}
                </a>{" "}
                {c.inSync ? <Badge tone="good">In the sync</Badge> : <Badge tone="neutral">Not in the sync</Badge>}
                {c.match === "near" && <Badge tone="neutral">Near miss</Badge>}
                {c.keyPage && c.intent && <Badge tone="neutral">Key page: {intentName(c.intent)}</Badge>}
                <span className="sub">{new URL(c.url).pathname}</span>
                {matchNote(c) && <span className="step-detail">{matchNote(c)}</span>}
                {c.found && <span className="step-detail">“{c.found}”</span>}
                {c.leftOutBecause && <span className="step-detail">{c.leftOutBecause}</span>}
                {/* Stays once the page is added (included), so its result keeps focus as the list refreshes. */}
                {(!c.inSync || pinnedKeys.has(pageKey(c.url))) && (
                  <AlwaysInclude
                    tenantId={id}
                    deploymentId={deploymentId}
                    url={c.url}
                    label={c.title ?? c.url}
                    setupMode={user.setupMode}
                    included={pinnedKeys.has(pageKey(c.url)) && !waitsForReason(c.leftOutBecause)}
                  />
                )}
                {pinnedKeys.has(pageKey(c.url)) && <span className="sub">Added by hand.</span>}
              </li>
            ))}
          </ul>
        )}
      </section>

      <nav className="filters" aria-label="Filter pages by status">
        {FILTERS.map((f) => (
          <Link key={f} href={query({ status: f === "all" ? undefined : f })} aria-current={(filter ?? "all") === f ? "page" : undefined}>
            {f === "all" ? "All" : STATUS[f][1]}
          </Link>
        ))}
      </nav>
      <nav className="filters" aria-label="Filter pages by flag">
        <Link href={query({ flag: undefined })} aria-current={flag ? undefined : "page"}>
          Any flag
        </Link>
        {PAGE_FLAGS.map((f) => (
          <Link key={f} href={query({ flag: f })} aria-current={flag === f ? "page" : undefined}>
            {FLAG_LABELS[f]} ({n(flags[f] ?? 0)})
          </Link>
        ))}
      </nav>

      <section className="panel">
        {pages.length === 0 ? (
          <p className="muted">No pages {filteredTo ? `that are ${filteredTo}` : "yet"}.</p>
        ) : (
          <div className="table-wrap">
            {filteredTo && (
              <p className="help">
                {n(pages.length)} {pages.length === 1 ? "page" : "pages"}: {filteredTo}.
              </p>
            )}
            <table>
              <thead>
                <tr>
                  <th scope="col">Page</th>
                  <th scope="col">Status</th>
                  <th scope="col">Published</th>
                  <th scope="col">Flags</th>
                  <th scope="col">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {pages.map((p) => {
                  // Being read again from its indexed copy: still answerable, and says so.
                  const live = inChat(p);
                  const rereading = live && p.status !== "indexed";
                  const [tone, word] = rereading ? STATUS.indexed : STATUS[p.status];
                  const when = dates(p);
                  const keptHere = keptBy.get(pageKey(p.url));
                  const detail = shownDetail(p.detail, live);
                  const read = readDates(p.facts);
                  const states = isKeyIntent(p.keyIntent) ? factsLine(p.facts) : undefined;
                  return (
                    <tr key={p.id}>
                      <td style={{ ...WRAP, minWidth: "16rem" }}>
                        <a href={p.url} target="_blank" rel="noreferrer">
                          {p.title ?? new URL(p.url).pathname}
                        </a>
                        <span className="sub">
                          {new URL(p.url).pathname}
                          {p.words ? ` · ${n(p.words)} words` : ""}
                          {pinnedKeys.has(pageKey(p.url)) ? " · added by hand" : ""}
                          {isKeyIntent(p.keyIntent) ? ` · key page: ${intentName(p.keyIntent)}` : ""}
                        </span>
                        {keptHere && (
                          <span className="step-detail">
                            Kept by hand despite {keptKind(keptHere.rule) === "stale-price" ? "a stale price" : "its date"}, by{" "}
                            {keptHere.name}
                            {keptHere.verified ? "" : " (not verified)"}: "{keptHere.reason}". {keptHere.rule}
                          </span>
                        )}
                        <PageProblem detail={detail} />
                        {states && <span className="step-detail">{states}</span>}
                        {read.map((r) => (
                          <span key={r} className="step-detail">
                            {r}
                          </span>
                        ))}
                      </td>
                      <td>
                        <Badge tone={tone}>{word}</Badge>
                        {rereading && <span className="sub">Being read again; the chat answers from the current copy.</span>}
                      </td>
                      <td style={{ ...WRAP, minWidth: "8rem" }}>{when ?? <span className="muted">—</span>}</td>
                      <td style={WRAP}>
                        {p.flags
                          .filter((f): f is PageFlag => PAGE_FLAGS.includes(f as PageFlag))
                          .map((f) => (
                            <span key={f}>
                              <Badge tone="warning">{flagText(f, p.publishedAt)}</Badge>{" "}
                            </span>
                          ))}
                        {p.flags.includes("other-language") && p.lang && <span className="sub">{p.lang}</span>}
                      </td>
                      <td>
                        <div className="actions">
                          {(live || p.status === "processing") && (
                            <Link href={query({ text: p.id })}>
                              View text<span className="sr-only"> of {p.title ?? p.url}</span>
                            </Link>
                          )}
                          {/* Both stay on the row after acting, so their results keep focus as the list refreshes. */}
                          {(includable(p) || pinnedKeys.has(pageKey(p.url))) && (
                            <AlwaysInclude
                              tenantId={id}
                              deploymentId={deploymentId}
                              url={p.url}
                              label={p.title ?? p.url}
                              setupMode={user.setupMode}
                              included={!includable(p)}
                            />
                          )}
                          <LeaveOut
                            tenantId={id}
                            deploymentId={deploymentId}
                            url={p.url}
                            label={p.title ?? p.url}
                            removed={p.status === "removed"}
                          />
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}
