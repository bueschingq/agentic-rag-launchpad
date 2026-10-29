// Fills an empty database with a demo partner: five customers, seven deployments, and 60 days
// of the usage and quality rollups the worker would write. CI's console preview runs on it.
// It refuses a database that already has customers, so it can't mix into real data.
//
//   DATABASE_URL=… node packages/db/src/seed-demo.ts

import { count } from "drizzle-orm";
import { createDb } from "./client.ts";
import { deployments, qualityDaily, settings, syncSources, tenants, usageDaily } from "./schema.ts";

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
        quality: [4.3, 3.5],
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
          })
          .returning({ id: deployments.id });
        const deploymentId = deployment!.id;

        if (d.sync) {
          const syncedAt = new Date(now.getTime() - d.sync.daysAgo * DAY_MS - 3 * 3_600_000);
          await tx.insert(syncSources).values({ deploymentId, kind: d.sync.kind, lastJobStatus: d.sync.status, lastSyncedAt: syncedAt });
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
