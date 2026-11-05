// RULES_VERSION and EXTRACTOR_VERSION guard: what the page rules decide about a fixed set of pages (the plan's rule
// matches and key pages, each loaded page's flags, leave-out reason, keep-it-anyway question
// and the text sent) is recorded per version in fixtures/rules-versions.json. If the rules
// change without a bump, this fails: existing deployments would never be read again under the
// new rules (the nightly re-read and Bring up to date only touch pages below RULES_VERSION).
//
// EXTRACTOR_VERSION is guarded the same way, on what the sync does to a page's text before
// sending it (the chrome lines dropped), as "extractor-N" records.
//
// After a deliberate change: bump RULES_VERSION (or EXTRACTOR_VERSION) in src/lib/content-plan.ts,
// then record the new version's output with RECORD_RULES=1 node --test apps/console/test/rules-version.test.ts.
// Recording never overwrites a version, and never records one below the newest recorded.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { describe, it } from "node:test";
import { pageFacts, pageVerdict, type SyncRules } from "../../worker/src/jobs/content.ts";
import type { SitePage } from "../../worker/src/sniffer.ts";
import {
  chromeLines,
  dropChrome,
  EXTRACTOR_VERSION,
  intentLine,
  joinFigures,
  KEY_INTENTS,
  keepRule,
  PLAN_RULES,
  type PlanEntry,
  pageFlags,
  placeDates,
  RULES_VERSION,
  rankPages,
  ruleLeaveOut,
  statedFacts,
} from "../src/lib/content-plan.ts";

const RECORD = new URL("fixtures/rules-versions.json", import.meta.url);
const TODAY = new Date("2026-10-30T12:00:00Z");
const at = (path: string, more: Omit<PlanEntry, "url"> = {}): PlanEntry => ({ url: `https://www.example.com${path}`, ...more });

// A sitemap with one or more of every kind of page the rules tell apart.
const ENTRIES: PlanEntry[] = [
  at("/"),
  at("/purchase.aspx", { lastmod: "2026-09-01" }),
  at("/purchase/support-plans", { lastmod: "2025-01-10" }),
  at("/purchase/request-a-quote", { lastmod: "2023-02-01" }),
  at("/purchase-order-app-for-sap-netweaver", { lastmod: "2026-01-01" }),
  at("/contact", { lastmod: "2021-05-01" }),
  at("/contact-m", { lastmod: "2026-05-01" }),
  at("/contact/thank-you", { lastmod: "2026-10-01" }),
  at("/support"),
  at("/support/wpf", { lastmod: "2026-10-01" }),
  at("/support/blazor", { lastmod: "2026-10-01" }),
  at("/support/uwp", { lastmod: "2026-10-01" }),
  at("/support/winui", { lastmod: "2026-10-01" }),
  at("/support/maui", { lastmod: "2026-10-01" }),
  at("/faqs"),
  at("/faqs/pricing-and-licensing/how-can-i-access-support-open-a-support-ticket", { lastmod: "2024-09-03" }),
  at("/products/x/faq", { lastmod: "2020-01-01" }),
  at("/start-free-trial"),
  at("/how-to-buy", { lastmod: "2022-01-01" }),
  at("/de/preise", { lang: "de", alternates: 3 }),
  at("/de/kontakt", { lang: "de", alternates: 3 }),
  at("/es/contacto", { lang: "es", alternates: 3 }),
  at("/fr/tarification", { lang: "fr", alternates: 3 }),
  at("/blog/real-cost-of-network-monitor", { lastmod: "2026-09-25" }),
  at("/blog/pricing-update", { lastmod: "2016-10-11" }),
  at("/blog/2025/04/25/spring-release"),
  at("/blog/tag/pricing"),
  at("/forums/trial-edition", { lastmod: "2026-10-01" }),
  at("/webinars/q2-2025-release", { lastmod: "2025-06-09" }),
  at("/devreach-2022/agenda"),
  at("/devreach-2022/contact-us"),
  at("/release-notes/product-10-2"),
  at("/release-notes/product-11-1"),
  at("/release-notes/product-12-0"),
  at("/products/old-page", { lastmod: "2021-03-01" }),
  at("/about", { lastmod: "2021-03-01" }),
  at("/tips-and-articles/our-cleaning-tips/how-to-clean-grout", { lastmod: "2023-01-20" }),
  at("/fr/ebooks/devis"),
  at("/nl-be/s/offerte-programma"),
  at("/glossary/value-based-pricing"),
  at("/2026-strategic-shifts/value-beyond-price"),
  // From rules 6: /plans is a pricing page, a feature page about support isn't a support page, and
  // the events section's own pages follow the key pages.
  at("/plans", { lastmod: "2026-09-01" }),
  at("/plans/premium", { lastmod: "2026-09-01" }),
  at("/technical-support", { lastmod: "2026-08-01" }),
  at("/product-feature/regulatory-compliance-support", { lastmod: "2026-08-01" }),
  at("/events/automation-summit-2026", { lastmod: "2026-10-01" }),
  at("/events/expo-2024", { lastmod: "2024-01-10" }),
  ...Array.from({ length: 12 }, (_, i) => at(`/resources/whitepaper-${i}`, { lastmod: "2026-06-29" })),
  ...Array.from({ length: 30 }, (_, i) => at(`/products/grid/feature-${i}`, { lastmod: `2026-0${(i % 9) + 1}-15` })),
];

const page = (path: string, more: Partial<SitePage> = {}): SitePage => ({
  url: `https://www.example.com${path}`,
  finalUrl: `https://www.example.com${path}`,
  status: 200,
  title: path,
  noindex: false,
  markdown: Array.from({ length: 60 }, (_, i) => `word${i}`).join(" "),
  words: 60,
  links: [],
  ...more,
});

// Loaded pages: their own dates, types, languages and text.
const PAGES: { page: SitePage; planDate?: string }[] = [
  {
    page: page("/blog/real-cost-of-network-monitor", {
      datePublished: "2016-10-11T13:00:00",
      dateModified: "2026-09-25T12:42:14",
      articleType: "BlogPosting",
      markdown: `${"word ".repeat(60)}The Total Plus 300 license costs $7,995.`,
    }),
  },
  { page: page("/pricing", { dateModified: "2016-02-01", markdown: `${"word ".repeat(60)}From $1,229 per year.` }) },
  { page: page("/contact", { dateModified: "2021-05-01" }) },
  { page: page("/faqs/pricing-and-licensing/how-can-i-access-support-open-a-support-ticket", { datePublished: "2024-09-03" }) },
  { page: page("/products/old-page"), planDate: "2021-03-01" },
  { page: page("/products/new-page", { dateModified: "2026-10-01" }) },
  { page: page("/webinars/q2-2025-release", { datePublished: "2025-06-09", markdown: `${"word ".repeat(60)}Version 2025 Q2.` }) },
  { page: page("/devreach-2022/agenda") },
  { page: page("/thank-you", { title: "Thank you" }) },
  { page: page("/it/prodotti", { lang: "it" }) },
  { page: page("/blog/tag/pricing", { linkShare: 0.8, textChars: 500 }) },
  { page: page("/products/short", { rootChars: 4000, textChars: 900 }) },
  { page: page("/de/preise", { lang: "de", markdown: `${"Wort ".repeat(60)}Ab 1.229 $.` }) },
  { page: page("/about", { dateModified: "2020-12-18" }) },
  { page: page("/tips/how-to-clean-grout", { datePublished: "2023-01-20", articleType: "Article" }) },
  {
    page: page("/nl-be/prijs", {
      lang: "nl",
      datePublished: "2023-06-07",
      dateModified: "2026-10-28",
      markdown: `${"woord ".repeat(60)}€ 24,75 per maand.`,
    }),
  },
  { page: page("/events/summit", { dateModified: "2026-10-28", markdown: `${"word ".repeat(60)}\n\nSaturday, November 5: the summit.` }) },
  { page: page("/events/webinar", { dateModified: "2026-10-28", markdown: `${"word ".repeat(60)}\n\nThursday, November 5 at 11:00 AM.` }) },
];

const short = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);

function rulesOutput() {
  const plan = (rules: readonly string[], budget: number, keys = true) => {
    const { inScope, keyPages } = rankPages({
      entries: ENTRIES,
      served: ["en", "de"],
      languages: ["und", "de"],
      rules: PLAN_RULES.filter((r) => rules.includes(r)),
      include: [],
      exclude: [],
      budget,
      today: TODAY,
      keyPages: keys,
    });
    return {
      pages: Object.fromEntries(
        inScope.map((c) => [
          new URL(c.entry.url).pathname,
          [c.matches.join(" "), c.intent ?? "", c.keyPage ? "key" : "", c.date ?? "", c.stamped ? "stamped" : ""].join("|"),
        ]),
      ),
      keyPages,
    };
  };
  const all = [...PLAN_RULES];
  const loaded = PAGES.map(({ page: p, planDate }) => {
    const facts = pageFacts(p, planDate ? new Date(`${planDate}T00:00:00Z`) : undefined, TODAY);
    const flags = pageFlags(facts, { served: ["en", "de"], today: TODAY });
    const sync = (over: Partial<SyncRules>): SyncRules => ({ rules: all, served: ["en", "de"], spare: true, today: TODAY, ...over });
    const verdict = (over: Partial<SyncRules>) => {
      const v = pageVerdict(p, new Set(), sync(over), flags, facts);
      return v.send ? `send ${short(v.body)}${v.labels.length ? ` ${v.labels.join(",")}` : ""}` : `${v.status}: ${v.detail}`;
    };
    return {
      path: new URL(p.url).pathname,
      flags,
      // A live deployment on the selection from before key pages.
      flagsBefore: pageFlags(facts, { served: ["en", "de"], today: TODAY, keyPages: false }),
      leaveOut: ruleLeaveOut(facts, flags, all, TODAY) ?? null,
      keep: keepRule(facts, flags, all, TODAY) ?? null,
      synced: verdict({}),
      byHand: verdict({ pinned: true }),
      kept: verdict({ pinned: true, kept: true }),
      asKeyPage: verdict({ intent: "price" }),
    };
  });
  const lines = Object.fromEntries(
    ["en", "de", "es", "fr", "nl", "pt", "it"].map((lang) => [lang, KEY_INTENTS.map((i) => intentLine(i, lang))]),
  );
  return {
    plan: plan(all, 40),
    planUnticked: plan([], 40),
    smallBudget: plan(all, 16).keyPages,
    bigBudget: plan(all, 400).keyPages,
    // The selection a live deployment signed off under older checks keeps (takesKeyPages).
    before: plan(all, 400, false).pages,
    loaded,
    lines,
  };
}

// What the sync does to a page's text before sending it (EXTRACTOR_VERSION): the chrome a set of
// pages shares, and each page without it.
const CHROME_PAGES = [
  ...["products/wpf", "aspnet-core-ui", "kendo-react-ui", "blazor-ui", "reporting"].flatMap((section) =>
    Array.from({ length: 4 }, (_, i) => ({
      url: `https://www.example.com/${section}/page-${i}`,
      text: `# ${section} ${i}\n\n> Summary ${i}\n\nWhat page ${i} of ${section} says.\n\nKnowledge Base\n\n- Button\n- Window\n\n$ 849\n\nper developer, per year\n\nContact Support\n\n\u0060\u0060\u0060\nContact Support\n\u0060\u0060\u0060`,
    })),
  ),
  ...Array.from({ length: 6 }, (_, i) => ({
    url: `https://www.example.com/stain-tips/tip-${i}`,
    text: `# Tip ${i}\n\n## Steps\n\nBlot with a paper towel.\n\nRinse with warm water.\n\nContact Support`,
  })),
];

// Dates written without a year (placeDates) and what a page states (statedFacts), from extractor 3.
const DATED: [string, string][] = [
  [
    "en",
    "Upcoming Live Webinar: Thursday, November 5 at 11:00 AM. Then Nov. 12th, and December 3, 2026. Saturday, November 5: no. Released on March 3.",
  ],
  ["de", "Donnerstag, 5. November um 11 Uhr; Do., 12. Nov. online; 5. Dezember 2026"],
  ["fr", "jeudi 5 novembre à 11h, le 1er décembre"],
  ["es", "jueves, 5 de noviembre a las 11; 3 de diciembre de 2026"],
];
const ANCHOR = { date: new Date("2026-10-28T00:00:00Z"), from: "sitemap" as const };
const STATED =
  "Basics $9 .99 | & 24.99 | 1 250 € | 50 % off\n\nCall +353 21 2128700sales@example.com\n\nThe subsidy ends on 31 December 2027.\n\n# How to buy\n\n## Business\n\n$ 59\n\nper node, per year\n\n## Enterprise\n\n$ 189\n\nCall +1 (800) 555-1234 or email sales@example.com.\n\nAb 1.229 $ pro Jahr | 2.205 US-Dollar | USD 2,205 | 2 205 $\n\n##### Premium\n\nEnd-to-end workflows\n\n$ 28.59\n\n$ 26.00\n\nPer user/month\n\n### Business\n\nBusiness includes:\n\n- One installation\n\n- Email support\n\nstarting from\n\n$ 1,229 *\n\nfor 50 devices, per year";

function extractorOutput() {
  const chrome = chromeLines(CHROME_PAGES);
  return {
    chrome: [...chrome].sort(),
    pages: CHROME_PAGES.slice(0, 2)
      .concat(CHROME_PAGES.slice(-1))
      .map((p) => [p.url, dropChrome(p.text, chrome), dropChrome(p.text, chrome, "support"), dropChrome(p.text, chrome, "price")]),
    dates: DATED.map(([lang, text]) => {
      const placed = placeDates(text, ANCHOR, lang);
      return [placed.text, placed.dates.map((d) => `${d.date} ${d.readAs}`), placed.unplaced.map((u) => u.readAs)];
    }),
    joined: joinFigures(STATED),
    stated: statedFacts(
      {
        url: "https://www.example.com/how-to-buy",
        title: "How to buy",
        text: joinFigures(STATED),
        links: ["https://www.example.com/request-a-quote", "https://www.example.com/start-free-trial"],
      },
      "price",
      placeDates(STATED, ANCHOR),
      TODAY,
    ),
  };
}

// The record for a version of one kind ("rules": RULES_VERSION, "extractor": EXTRACTOR_VERSION),
// checked or, with RECORD_RULES=1, written.
function guard(kind: "rules" | "extractor", version: number, output: unknown) {
  const records = JSON.parse(readFileSync(RECORD, "utf8")) as Record<string, unknown>;
  const key = (v: number) => (kind === "rules" ? String(v) : `extractor-${v}`);
  const name = kind === "rules" ? "RULES_VERSION" : "EXTRACTOR_VERSION";
  const what = kind === "rules" ? "page rules" : "text the sync builds from a page";
  const versions = Object.keys(records)
    .filter((k) => (kind === "rules" ? /^\d+$/.test(k) : k.startsWith("extractor-")))
    .map((k) => Number(k.replace("extractor-", "")));
  const newest = Math.max(0, ...versions);
  const actual = JSON.parse(JSON.stringify(output));
  if (process.env.RECORD_RULES === "1" && !records[key(version)]) {
    assert.ok(version > newest, `${name} ${version} is below the newest recorded (${newest}): bump it instead.`);
    writeFileSync(RECORD, `${JSON.stringify({ ...records, [key(version)]: actual }, null, 2)}\n`);
    return;
  }
  assert.ok(version >= newest, `${name} is ${version}, below the newest recorded (${newest}): the bump was reverted. Put it back.`);
  assert.ok(
    records[key(version)],
    `No record of ${name} ${version}. Record it: RECORD_RULES=1 node --test apps/console/test/rules-version.test.ts`,
  );
  assert.deepEqual(
    actual,
    records[key(version)],
    `The ${what} changed but ${name} is still ${version}. Bump it in src/lib/content-plan.ts (existing deployments' pages are then read again), and record the new version: RECORD_RULES=1 node --test apps/console/test/rules-version.test.ts`,
  );
}

describe("RULES_VERSION and EXTRACTOR_VERSION", () => {
  it("RULES_VERSION is bumped whenever the page rules, the key pages or the text sent change", () => {
    guard("rules", RULES_VERSION, rulesOutput());
  });

  it("EXTRACTOR_VERSION is bumped whenever the text the sync builds from a page changes", () => {
    guard("extractor", EXTRACTOR_VERSION, extractorOutput());
  });
});
