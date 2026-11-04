// The content plan for New deployment, recomputed as the partner changes it. The sitemaps are
// read once per site (site-cache.ts); each change only reruns the plan over the same entries.
// A route handler rather than a server action: actions run one at a time, and the plan must
// not wait behind the scan. The key pages it takes are checked to load (checkKeyPages): one that
// answers 4xx or 5xx gives its place to the next of its intent before Create, and a page titled
// for its prices ("Plans & Pricing") is shown as the pricing page.

import { LANGUAGES } from "@launchpad/theme";
import { currentUser } from "@/lib/auth.ts";
import { DEFAULT_EXCLUDES, DEFAULT_PAGE_BUDGET, MAX_PAGE_BUDGET, parseSitemapAddress, siteAddress } from "@/lib/content-form.ts";
import {
  type ContentPlan,
  intentOf,
  isPlanRule,
  keyIntentFor,
  PLAN_RULES,
  type PlanInput,
  pageKey,
  planContent,
  rankPages,
} from "@/lib/content-plan.ts";
import { ScanError } from "@/lib/sniffer.ts";
import { probedPages, sitemapEntries } from "../site-cache.ts";

// Rounds of checking: each replaces the key pages that didn't load with the next candidates.
const CHECK_ROUNDS = 3;
const CHECK_MS = 12_000;

// The plan's key pages, checked to load: those answering 4xx or 5xx (or a block page) are left
// out for the next of their intent, until every key page taken has loaded or CHECK_ROUNDS have
// gone. titles: each loaded page's title, by path.
async function checkKeyPages(input: PlanInput) {
  const unusable = new Set<string>();
  const titles = new Map<string, string>();
  const failed: { url: string; status: number }[] = [];
  const checked = new Set<string>();
  const deadline = Date.now() + CHECK_MS;
  for (let round = 0; round < CHECK_ROUNDS && Date.now() < deadline; round++) {
    const keys = rankPages({ ...input, unusable }).ranked.filter((c) => c.keyPage);
    const urls = keys.map((c) => c.entry.url).filter((url) => !checked.has(url));
    if (!urls.length) break;
    const probed = await probedPages(urls);
    for (const url of urls) {
      checked.add(url);
      const page = probed.get(url);
      if (!page) continue;
      if (page.status >= 400 || page.blocked) {
        unusable.add(pageKey(url));
        failed.push({ url, status: page.status });
      } else if (page.title) titles.set(new URL(url).pathname, page.title);
    }
    if (!probed.size) break;
  }
  return { unusable, titles, failed };
}

// The plan with what checking the key pages found: a page titled for its prices is the pricing
// page, and those that didn't load are listed as not taken, with why.
function withChecks(plan: ContentPlan, checks: Awaited<ReturnType<typeof checkKeyPages>>): ContentPlan {
  const taken = plan.keyPages.taken.map((k) => {
    const intent = keyIntentFor(k.intent, checks.titles.get(k.path)) ?? k.intent;
    return intent === k.intent ? k : { ...k, intent };
  });
  const notTaken = [
    ...checks.failed.flatMap((f) => {
      const intent = intentOf(f.url);
      const why = f.status ? `answered ${f.status} when the plan checked it` : "didn't load when the plan checked it";
      return intent ? [{ path: new URL(f.url).pathname, intent, why }] : [];
    }),
    ...plan.keyPages.notTaken,
  ];
  // One reason a page: the first, what checking it found, over "more key pages than the plan takes".
  const once = notTaken.filter((k, i) => notTaken.findIndex((o) => o.path === k.path) === i);
  return { ...plan, keyPages: { ...plan.keyPages, taken, notTaken: once } };
}

export const dynamic = "force-dynamic";

const strings = (value: unknown, max: number) =>
  (Array.isArray(value) ? value : []).filter((v): v is string => typeof v === "string").slice(0, max);

export async function POST(request: Request) {
  await currentUser();
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const site = siteAddress(String(body.site ?? ""));
  if (!site) return Response.json({ error: "Enter the site's address, e.g. https://www.example.com." }, { status: 400 });
  const language = String(body.language ?? "en");
  const served = language === "auto" ? LANGUAGES.map((l) => l.code) : [language];
  const budget = Math.min(Math.max(Math.trunc(Number(body.budget) || DEFAULT_PAGE_BUDGET), 1), MAX_PAGE_BUDGET);
  const sitemap = parseSitemapAddress(String(body.sitemap ?? ""));
  if (sitemap.error) return Response.json({ error: sitemap.error }, { status: 400 });

  try {
    const read = await sitemapEntries(site, sitemap.sitemap);
    const input: PlanInput = {
      entries: read.entries,
      served,
      ...(Array.isArray(body.languages) && { languages: strings(body.languages, 40) }),
      rules: Array.isArray(body.rules) ? strings(body.rules, 10).filter(isPlanRule) : [...PLAN_RULES],
      include: strings(body.include, 50),
      exclude: Array.isArray(body.exclude) ? strings(body.exclude, 50) : DEFAULT_EXCLUDES,
      budget,
      today: new Date(),
    };
    // A blocked site has nothing to check; neither has one without a sitemap.
    const checks = read.blocked || !read.entries.length ? undefined : await checkKeyPages(input);
    const planned = planContent({ ...input, ...(checks && { unusable: checks.unusable }) });
    const plan = checks ? withChecks(planned, checks) : planned;
    return Response.json({
      plan,
      read: {
        total: read.total,
        files: read.files,
        sitemaps: read.sitemaps,
        truncated: read.truncated,
        ms: read.ms,
        ...(read.discovery && { discovery: read.discovery }),
        ...(read.failed?.length && { failed: read.failed }),
        ...(read.unread?.length && { unread: read.unread }),
        ...(read.blocked && { blocked: read.blocked }),
        ...(read.rateLimited && { rateLimited: read.rateLimited }),
        ...(read.gzipped && { gzipped: read.gzipped }),
        ...(read.found?.length && { found: read.found }),
      },
    });
  } catch (err) {
    if (err instanceof ScanError) return Response.json({ error: err.message }, { status: 422 });
    console.error("[plan]", err);
    return Response.json({ error: "The plan couldn't be computed. Try again shortly." }, { status: 500 });
  }
}
