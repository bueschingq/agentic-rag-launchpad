// Fills an empty database with a demo partner: five customers, eight deployments, and 60 days
// of the usage and quality rollups the worker would write. CI's console preview runs on it.
// It refuses a database that already has customers, so it can't mix into real data.
//
//   DATABASE_URL=… node packages/db/src/seed-demo.ts

import { count, eq } from "drizzle-orm";
import { createDb } from "./client.ts";
import {
  contentPages,
  deployments,
  type ProvisioningStep,
  qualityDaily,
  settings,
  syncSources,
  tenants,
  usageDaily,
  type ValidationResult,
} from "./schema.ts";
import { visitorSettingsHash } from "./sign-off.ts";

// Contract price per nuclia token, made up for the demo. Answers cost 0.14–0.23 tokens (M0).
const RATE = 0.25;
const DAYS = 60;
const DAY_MS = 86_400_000;

interface DemoDeployment {
  name: string;
  slug: string;
  site: string;
  status: "live" | "paused" | "draft" | "failed";
  content: "sitefinity_connector" | "sitemap" | "manual";
  // Weekday questions at the start of the period; traffic grows about 15% over it.
  perDay?: number;
  pausedDaysAgo?: number;
  // Answer relevance 60 days ago and yesterday; the change happens over the last two weeks.
  quality?: [number, number];
  sync?: { kind: "sitefinity_connector" | "sitemap"; status: string; daysAgo: number };
  theme?: Record<string, Record<string, string>>;
  widget?: Record<string, unknown>;
}

interface DemoTenant {
  slug: string;
  name: string;
  status: "active" | "paused";
  budget?: number;
  deployments: DemoDeployment[];
}

const DEMO: DemoTenant[] = [
  {
    slug: "harbor-view-dental",
    name: "Harbor View Dental",
    status: "active",
    budget: 50,
    deployments: [
      {
        name: "Main site",
        slug: "hvd-www",
        site: "https://www.harborviewdental.example",
        status: "live",
        content: "sitefinity_connector",
        perDay: 25,
        quality: [4.4, 4.5],
        sync: { kind: "sitefinity_connector", status: "ok", daysAgo: 0 },
        theme: { color: { primary: "#0e7490" }, shape: { radius: "16px", buttonRadius: "999px" }, finish: { style: "flat" } },
        widget: {
          nickname: "Harbor View Dental",
          welcome: "Hi! Ask me about appointments, treatments, insurance or finding us.",
          starters: ["Do you take new patients?", "Which insurance plans do you accept?", "What are your opening hours?"],
          handoff: {
            contacts: [
              { kind: "link", url: "tel:+15550102030" },
              { kind: "link", url: "https://www.harborviewdental.example/contact", label: "Contact the front desk" },
            ],
            show: ["no-answer", "header"],
          },
          ctas: [
            {
              label: "Book an appointment",
              url: "https://www.harborviewdental.example/book",
              keywords: ["appointment", "book", "booking", "visit"],
            },
          ],
        },
      },
    ],
  },
  {
    slug: "lakeside-credit-union",
    name: "Lakeside Credit Union",
    status: "active",
    budget: 150,
    deployments: [
      {
        name: "Member site",
        slug: "lcu-www",
        site: "https://www.lakesidecu.example",
        status: "live",
        content: "sitefinity_connector",
        perDay: 60,
        quality: [4.1, 4.2],
        sync: { kind: "sitefinity_connector", status: "ok", daysAgo: 0 },
      },
      {
        name: "Help center",
        slug: "lcu-help",
        site: "https://help.lakesidecu.example",
        status: "live",
        content: "sitemap",
        perDay: 35,
        quality: [4.3, 4.2],
        sync: { kind: "sitemap", status: "failed", daysAgo: 2 },
      },
    ],
  },
  {
    slug: "summit-outdoor",
    name: "Summit Outdoor Gear",
    status: "active",
    budget: 90,
    deployments: [
      {
        name: "Store",
        slug: "sog-shop",
        site: "https://shop.summitoutdoor.example",
        status: "live",
        content: "sitemap",
        perDay: 80,
        quality: [3.9, 4.0],
        sync: { kind: "sitemap", status: "ok", daysAgo: 0 },
      },
      {
        name: "Careers",
        slug: "sog-careers",
        site: "https://careers.summitoutdoor.example",
        status: "paused",
        content: "manual",
        perDay: 15,
        pausedDaysAgo: 20,
        quality: [4.0, 4.0],
      },
    ],
  },
  {
    slug: "riverside-clinic",
    name: "Riverside Health Clinic",
    status: "active",
    budget: 60,
    deployments: [
      {
        name: "Patient site",
        slug: "rhc-www",
        site: "https://www.riversideclinic.example",
        status: "live",
        content: "sitefinity_connector",
        perDay: 40,
        quality: [4.3, 3.3],
        sync: { kind: "sitefinity_connector", status: "ok", daysAgo: 5 },
      },
      {
        name: "Patient portal FAQ",
        slug: "rhc-portal",
        site: "https://portal.riversideclinic.example",
        status: "failed",
        content: "sitemap",
      },
    ],
  },
  {
    slug: "oak-pine-realty",
    name: "Oak & Pine Realty",
    status: "active",
    deployments: [
      {
        name: "Listings site",
        slug: "opr-www",
        site: "https://www.oakpinerealty.example",
        status: "draft",
        content: "sitemap",
      },
    ],
  },
];

// Pages a sitemap sync found on a demo site: path, title, words.
const PAGES: [string, string, number][] = [
  ["/", "Home", 420],
  ["/about", "About us", 610],
  ["/contact", "Contact", 180],
  ["/faq", "Frequently asked questions", 1540],
  ["/services", "Services", 880],
  ["/locations", "Locations and opening hours", 360],
  ["/privacy", "Privacy notice", 2100],
  ["/search", "Search", 12],
];

const ago = (days: number) => new Date(Date.now() - days * DAY_MS);

// What a deployment's history looks like for its status, so no page contradicts itself: live
// and paused ones were provisioned, validated, domain-locked and in use; the failed one stopped
// at its keys; drafts have no history.
function history(d: DemoDeployment, t: DemoTenant) {
  const at = (days: number) => ago(days).toISOString();
  const ok = (step: string, days: number, detail?: string): ProvisioningStep => ({
    step,
    status: "ok",
    at: at(days),
    ...(detail && { detail }),
  });
  if (d.status === "failed") {
    return {
      provisioningLog: [
        ok("kb", 3, "Created"),
        {
          step: "keys",
          status: "failed",
          at: at(3),
          detail: "Agentic RAG refused the key request (403): the account key needs KB management.",
        },
      ] as ProvisioningStep[],
    };
  }
  if (d.status !== "live" && d.status !== "paused") return {};
  const validation: ValidationResult = {
    at: at(DAYS + 1),
    passed: true,
    questions: ["What are your opening hours?", "Where are you?", "How do I get in touch?", "What services do you offer?"].map(
      (question, i) => ({
        question,
        answer: `Demo answer from ${t.name}'s site.`,
        sources: [{ title: PAGES[i]![1], url: new URL(PAGES[i]![0], d.site).href }],
        answered: true,
      }),
    ),
  };
  return {
    provisioningLog: [ok("kb", DAYS + 1, "Created"), ok("keys", DAYS + 1), ok("prompt", DAYS + 1), ok("live", DAYS + 1)],
    validation,
    preflight: { at: at(DAYS + 1), origins: [{ origin: new URL(d.site).origin, ok: true, status: 200 }] },
    readyAt: ago(DAYS + 1),
    firstSeenAt: ago(DAYS),
    firstSeenOrigin: new URL(d.site).origin,
    systemPrompt: `You are the website assistant for ${t.name}. Answer only from the provided context, and suggest contacting ${t.name} when it doesn't say.`,
    ...(d.theme && { theme: d.theme }),
    ...(d.widget && { widgetSettings: d.widget }),
  };
}

// Seeded, so every run draws the same shapes (mulberry32).
function randomFrom(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set.");

const random = randomFrom(20261028);
const now = new Date();
const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
const isoDay = (daysAgo: number) => new Date(today - daysAgo * DAY_MS).toISOString().slice(0, 10);
const round = (n: number, digits: number) => Number(n.toFixed(digits));

const { db, close } = createDb(url, { max: 1 });
try {
  const [existing] = await db.select({ n: count() }).from(tenants);
  if (existing && existing.n > 0) throw new Error("This database already has customers; the demo seed only fills an empty one.");

  await db.transaction(async (tx) => {
    await tx
      .insert(settings)
      .values({ id: 1, partnerName: "Northwind Digital", zone: "europe-1", contractRates: { nuclia_tokens: RATE }, markupPercent: 35 })
      .onConflictDoNothing();

    for (const t of DEMO) {
      const [tenant] = await tx
        .insert(tenants)
        .values({ slug: t.slug, name: t.name, status: t.status, monthlyBudgetCents: t.budget ? t.budget * 100 : null })
        .returning({ id: tenants.id });

      for (const d of t.deployments) {
        const hasKb = d.status === "live" || d.status === "paused";
        const [deployment] = await tx
          .insert(deployments)
          .values({
            tenantId: tenant!.id,
            name: d.name,
            siteUrl: d.site,
            domains: [new URL(d.site).origin],
            contentPath: d.content,
            zone: "europe-1",
            kbId: hasKb ? `demo-${d.slug}` : null,
            kbSlug: `northwind-${t.slug}-${d.slug}`,
            status: d.status,
            // Live and paused ones were serving before sign-off existed, like real ones migrated.
            published: d.status === "live" || d.status === "paused",
            ...history(d, t),
          })
          .returning();
        const deploymentId = deployment!.id;
        // Signed off when they were onboarded, except one, to show a deployment serving without a
        // review. No audit entry, so the fleet's onboarding clock leaves demo data out.
        if (deployment!.published && d.slug !== "lcu-help") {
          const at = new Date(deployment!.readyAt ?? now).toISOString();
          await tx
            .update(deployments)
            .set({ signOff: { by: null, name: "Morgan Lee", at, verified: true, settingsHash: visitorSettingsHash(deployment!) } })
            .where(eq(deployments.id, deploymentId));
        }

        if (d.sync) {
          const syncedAt = new Date(now.getTime() - d.sync.daysAgo * DAY_MS - 3 * 3_600_000);
          await tx.insert(syncSources).values({
            deploymentId,
            kind: d.sync.kind,
            lastJobStatus: d.sync.status,
            lastSyncedAt: syncedAt,
            ...(d.sync.kind === "sitemap" && {
              pageBudget: 200,
              pagesFound: PAGES.length,
              discovery: "sitemap",
              ...(d.sync.status === "failed" && {
                lastError: "The site answered 503 while its sitemap was being read: it may have been down. Sync again to retry.",
              }),
            }),
          });
          if (d.sync.kind === "sitemap") {
            await tx.insert(contentPages).values(
              PAGES.map(([path, title, words], i) => ({
                deploymentId,
                url: new URL(path, d.site).href,
                title,
                slug: `page-demo-${d.slug}-${i}`,
                words,
                status: words < 40 ? ("skipped" as const) : ("indexed" as const),
                detail: words < 40 ? `Too little text to answer from (${words} words).` : null,
                text: words < 40 ? null : `# ${title}\n\nDemo content for ${title.toLowerCase()}.`,
                sentAt: syncedAt,
                indexedAt: words < 40 ? null : syncedAt,
              })),
            );
          }
        }
        if (!d.perDay || !d.quality) continue;

        const usage: (typeof usageDaily.$inferInsert)[] = [];
        const quality: (typeof qualityDaily.$inferInsert)[] = [];
        const [from, to] = d.quality;
        for (let daysAgo = DAYS; daysAgo >= 1; daysAgo--) {
          if (d.pausedDaysAgo && daysAgo < d.pausedDaysAgo) continue;
          const weekday = new Date(today - daysAgo * DAY_MS).getUTCDay();
          const weekend = weekday === 0 ? 0.55 : weekday === 6 ? 0.65 : 1;
          const growth = 1 + 0.15 * ((DAYS - daysAgo) / DAYS);
          const questions = Math.round(d.perDay * weekend * growth * (0.8 + 0.4 * random()));
          const tokens = questions * (0.14 + 0.09 * random());
          usage.push({
            deploymentId,
            day: isoDay(daysAgo),
            questions,
            searches: Math.round(questions * (0.3 + 0.2 * random())),
            queryTokens: tokens.toFixed(6),
            costCents: Math.round(tokens * RATE * 100),
          });
          if (questions === 0) continue;
          const answer = daysAgo > 14 ? from : to + (from - to) * ((daysAgo - 1) / 13);
          const answerRelevance = Math.min(5, round(answer + (random() - 0.5) * 0.3, 2));
          quality.push({
            deploymentId,
            day: isoDay(daysAgo),
            answerRelevance,
            contextRelevance: round(answerRelevance - 0.3 + (random() - 0.5) * 0.2, 2),
            groundedness: round(4.2 + (random() - 0.5) * 0.4, 2),
          });
        }
        await tx.insert(usageDaily).values(usage);
        if (quality.length) await tx.insert(qualityDaily).values(quality);
      }
    }
  });
  console.log(`Seeded ${DEMO.length} demo customers with ${DAYS} days of usage up to ${isoDay(1)}.`);
} finally {
  await close();
}
