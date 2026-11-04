// Which intents the widget routes, and how (PublicWidgetConfig.intentConfigs and intentPages): an
// intent of ROUTE_INTENTS gets its saved configuration (prompt.ts intentConfigs: saved beside the
// deployment's own from answering rules INTENT_CONFIGS_SINCE) once the KB holds pages for it. Those
// are pages read by the extractor that labels them (content-plan.ts pageLabels: a key page's intent,
// and "events" for a page stating a date still to come), and key pages sent before labels existed,
// named by resource id until they're read again, as content-plan.ts labelFilter does. An intent
// with no pages isn't routed: its ask would find nothing and only add a second one. Served in the
// public config, and to the configurator's preview, so it asks as visitors' chats do. (Relative
// imports: the tests import this file.)

import { contentPages, type PageFacts } from "@launchpad/db";
import { ROUTE_INTENTS } from "@launchpad/theme";
import { and, eq, isNotNull, or, sql } from "drizzle-orm";
import { labelsFor, pageLabels, publicationStamp } from "../../../../../../lib/content-plan.ts";
import { db } from "../../../../../../lib/db.ts";
import { eventPagePaths, intentConfigs } from "../../../../../../lib/prompt.ts";

// The extractor version that sends each page with its labels (content-plan.ts EXTRACTOR_VERSION 3).
export const LABELLED_SINCE = 3;

export interface IntentPageRow {
  url?: string;
  resourceId: string | null;
  keyIntent: string | null;
  extractorVersion: number;
  facts: PageFacts | null;
}

export interface IntentRouting {
  intentConfigs?: Record<string, string>;
  intentPages?: Record<string, string[]>;
  eventPages?: string[];
}

// The deployment's intent configurations kept to the intents its answerable pages serve. Pure.
export function intentRoutes(rows: readonly IntentPageRow[], configs: Readonly<Record<string, string>>, today: Date): IntentRouting {
  const routed: Record<string, string> = {};
  const intentPages: Record<string, string[]> = {};
  for (const intent of ROUTE_INTENTS) {
    if (!configs[intent]) continue;
    const labels: readonly string[] = labelsFor(intent);
    let labelled = false;
    const unlabelled: string[] = [];
    for (const r of rows) {
      if (!r.resourceId) continue;
      if (r.extractorVersion >= LABELLED_SINCE) {
        const own = pageLabels(r.keyIntent as Parameters<typeof pageLabels>[0], r.facts?.events, today);
        if (own.some((l) => labels.includes(l))) labelled = true;
      } else if (r.keyIntent && labels.includes(r.keyIntent)) unlabelled.push(r.resourceId);
    }
    if (!labelled && !unlabelled.length) continue;
    routed[intent] = configs[intent];
    if (unlabelled.length) intentPages[intent] = unlabelled;
  }
  // The pages stating events still to come, for the chat's check on a reply with no date (prompt.ts).
  const day = today.toISOString().slice(0, 10);
  const eventPages = routed.events
    ? eventPagePaths(
        rows.flatMap((r) =>
          (r.facts?.events ?? [])
            .filter((e) => r.url && e.date >= day && !publicationStamp(e.line))
            .map((e) => ({ url: r.url!, line: e.line })),
        ),
      )
    : [];
  return {
    ...(eventPages.length && { eventPages }),
    ...(Object.keys(routed).length && { intentConfigs: routed }),
    ...(Object.keys(intentPages).length && { intentPages }),
  };
}

// The deployment's routing, from its answerable pages: none before its answering rules saved the
// intent configurations, nor for an imported deployment with no prompt.
export async function intentRouting(
  deployment: { id: string; systemPrompt: string; searchConfig: string; answeringRules: number },
  today = new Date(),
): Promise<IntentRouting> {
  const configs = intentConfigs(deployment);
  if (!configs) return {};
  const rows = await db()
    .select({
      url: contentPages.url,
      resourceId: contentPages.resourceId,
      keyIntent: contentPages.keyIntent,
      extractorVersion: contentPages.extractorVersion,
      facts: contentPages.facts,
    })
    .from(contentPages)
    .where(
      and(
        eq(contentPages.deploymentId, deployment.id),
        eq(contentPages.status, "indexed"),
        isNotNull(contentPages.resourceId),
        or(isNotNull(contentPages.keyIntent), sql`${contentPages.facts}->'events' is not null`),
      ),
    );
  return intentRoutes(rows, configs, today);
}
