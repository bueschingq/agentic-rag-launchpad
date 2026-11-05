// The synced pages a model-written link may open, as the public config carries them
// (PublicWidgetConfig.pagePaths): indexed pages' paths, key pages first, then the shortest
// addresses, capped (compactPagePaths). Beyond the cap the widget allows any page on the
// deployment's own sites. (Relative imports, as intents.ts.)

import { contentPages } from "@launchpad/db";
import { compactPagePaths } from "@launchpad/theme";
import { and, eq, inArray, isNotNull, or, sql } from "drizzle-orm";
import { db } from "../../../../../../lib/db.ts";

export async function pagePaths(deploymentId: string): Promise<{ pagePaths: string[]; pagePathsCapped?: true }> {
  const rows = await db()
    .select({ url: contentPages.url })
    .from(contentPages)
    .where(and(eq(contentPages.deploymentId, deploymentId), eq(contentPages.status, "indexed")))
    .orderBy(sql`${contentPages.keyIntent} is null`, sql`length(${contentPages.url})`, contentPages.url);
  const { paths, capped } = compactPagePaths(rows.map((r) => r.url));
  return { pagePaths: paths, ...(capped && { pagePathsCapped: true as const }) };
}

// A key page in the chat, its shortest address: indexed, or waiting to be read again with its copy in
// the chat. A page that failed or was left out can't be where visitors are sent.
async function keyPageInChat(deploymentId: string, intent: "contact" | "support"): Promise<string | null> {
  const [row] = await db()
    .select({ url: contentPages.url })
    .from(contentPages)
    .where(
      and(
        eq(contentPages.deploymentId, deploymentId),
        eq(contentPages.keyIntent, intent),
        or(
          eq(contentPages.status, "indexed"),
          and(inArray(contentPages.status, ["queued", "processing"]), isNotNull(contentPages.indexedAt)),
        ),
      ),
    )
    .orderBy(sql`length(${contentPages.url})`)
    .limit(1);
  return row?.url ?? null;
}

// The deployment's contact key page, for the configurator's first handoff suggestion.
export const contactKeyPage = (deploymentId: string) => keyPageInChat(deploymentId, "contact");
// Its support key page, suggested first when it has no contact key page.
export const supportKeyPage = (deploymentId: string) => keyPageInChat(deploymentId, "support");
