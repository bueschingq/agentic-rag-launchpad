// Database side of the widget configurator: the latest site scan, the saved theme and
// settings, a person's confirmation of the brand and the starter questions, and the key the
// live preview answers with. Every change is audited: a save records only the fields whose value
// visitors get changed (widget-diff.ts), and on a live chat the worker posts it to the partner's
// channel (apps/worker/src/jobs/alerts.ts).

import {
  auditLog,
  type Confirmation,
  contentPages,
  credentials,
  type DeploymentConfirmations,
  deployments,
  type KeyRoleName,
  loadKey,
  siteScans,
  tenantContacts,
  tenants,
} from "@launchpad/db";
import { resolveTheme, type SiteScan, type ThemeInput, type WidgetSettings } from "@launchpad/theme";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "./db.ts";
import { env } from "./env.ts";
import { brandStatus } from "./review.ts";
import { withSetupName } from "./setup-name.ts";
import { widgetDiff } from "./widget-diff.ts";
import { handoffSuggestions, type WidgetValue } from "./widget-form.ts";

// Imported deployments only have a manager key; anything that can ask will do for a preview.
const PREVIEW_ROLES: KeyRoleName[] = ["reader", "manager"];

export type ScanSummary = Omit<typeof siteScans.$inferSelect, "screenshot" | "deploymentId">;

const scanColumns = {
  id: siteScans.id,
  url: siteScans.url,
  finalUrl: siteScans.finalUrl,
  platform: siteScans.platform,
  sitemapPages: siteScans.sitemapPages,
  result: siteScans.result,
  createdAt: siteScans.createdAt,
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function loadWidgetPage(tenantId: string, deploymentId: string) {
  if (!UUID.test(tenantId) || !UUID.test(deploymentId)) return undefined;
  const [row] = await db()
    .select({ deployment: deployments, tenantName: tenants.name, displayName: tenants.displayName })
    .from(deployments)
    .innerJoin(tenants, eq(tenants.id, deployments.tenantId))
    .where(and(eq(deployments.id, deploymentId), eq(deployments.tenantId, tenantId)));
  if (!row) return undefined;
  const [scan] = await db().select(scanColumns).from(siteScans).where(eq(siteScans.deploymentId, deploymentId));
  const [key] = await db()
    .select({ role: credentials.role })
    .from(credentials)
    .where(and(eq(credentials.deploymentId, deploymentId), inArray(credentials.role, PREVIEW_ROLES), isNull(credentials.revokedAt)))
    .limit(1);
  const pages = await db().select({ url: contentPages.url }).from(contentPages).where(eq(contentPages.deploymentId, deploymentId));
  const [primary] = await db()
    .select({ name: tenantContacts.name, email: tenantContacts.email, phone: tenantContacts.phone })
    .from(tenantContacts)
    .where(and(eq(tenantContacts.tenantId, tenantId), eq(tenantContacts.isPrimary, true)));
  return {
    ...row,
    scan: scan as ScanSummary | undefined,
    canAsk: Boolean(row.deployment.kbId && key),
    suggestions: handoffSuggestions(pages, primary),
  };
}

// One scan per deployment: a rescan replaces it.
export async function saveScan(deploymentId: string, scan: SiteScan, actor: string | null): Promise<ScanSummary> {
  const values = {
    deploymentId,
    url: scan.url,
    finalUrl: scan.finalUrl,
    platform: scan.platform,
    sitemapPages: scan.sitemapPages,
    result: {
      theme: scan.theme,
      confidence: scan.confidence,
      sources: scan.sources,
      warnings: scan.warnings,
      sitemaps: scan.sitemaps,
      sitemapTruncated: scan.sitemapTruncated,
      status: scan.status,
      icons: scan.icons,
      ...(scan.logo && { logo: scan.logo }),
      ...(scan.siteName && { siteName: scan.siteName }),
      ...(scan.pageLanguage && { pageLanguage: scan.pageLanguage }),
      languages: scan.languages ?? [],
      fonts: scan.fonts ?? [],
      logoCandidates: scan.logoCandidates ?? [],
      nameSources: scan.nameSources ?? [],
      ...(scan.nameCheck !== undefined && { nameCheck: scan.nameCheck }),
      ...(scan.privacyUrl && { privacyUrl: scan.privacyUrl }),
      ...(scan.contactUrl && { contactUrl: scan.contactUrl }),
      ...(scan.bottomBar && { bottomBar: scan.bottomBar }),
    },
    screenshot: scan.screenshot.replace(/^data:image\/jpeg;base64,/, ""),
    createdAt: new Date(),
  };
  return db().transaction(async (tx) => {
    const [saved] = await tx
      .insert(siteScans)
      .values(values)
      .onConflictDoUpdate({ target: siteScans.deploymentId, set: values })
      .returning(scanColumns);
    await tx.insert(auditLog).values(
      await withSetupName({
        actorUserId: actor,
        action: "deployment.scan",
        targetType: "deployment",
        targetId: deploymentId,
        detail: { url: scan.finalUrl, platform: scan.platform.platform, sitemapPages: scan.sitemapPages },
      }),
    );
    return saved as ScanSummary;
  });
}

export async function lastScanAt(deploymentId: string): Promise<Date | undefined> {
  const [row] = await db().select({ at: siteScans.createdAt }).from(siteScans).where(eq(siteScans.deploymentId, deploymentId));
  return row?.at;
}

export async function loadScreenshot(tenantId: string, deploymentId: string): Promise<Buffer | undefined> {
  if (!UUID.test(tenantId) || !UUID.test(deploymentId)) return undefined;
  const [row] = await db()
    .select({ screenshot: siteScans.screenshot })
    .from(siteScans)
    .innerJoin(deployments, eq(deployments.id, siteScans.deploymentId))
    .where(and(eq(siteScans.deploymentId, deploymentId), eq(deployments.tenantId, tenantId)));
  return row && Buffer.from(row.screenshot, "base64");
}

// Returns false if the deployment isn't this customer's.
export async function saveWidget(tenantId: string, deploymentId: string, value: WidgetValue, actor: string | null): Promise<boolean> {
  return db().transaction(async (tx) => {
    const [before] = await tx
      .select({ theme: deployments.theme, settings: deployments.widgetSettings, language: deployments.language })
      .from(deployments)
      .where(and(eq(deployments.id, deploymentId), eq(deployments.tenantId, tenantId)));
    if (!before) return false;
    // The language stays the deployment's (see draftFor); it's kept in the settings for older rows.
    const settings = { ...value.settings, ...(before.settings.language && { language: before.settings.language }) };
    await tx.update(deployments).set({ theme: value.theme, widgetSettings: settings }).where(eq(deployments.id, deploymentId));
    // A save that changes nothing visitors get isn't a change: Review and the channel stay quiet.
    const diff = widgetDiff({ theme: before.theme, settings: before.settings }, value);
    if (diff.changed.length)
      await tx.insert(auditLog).values(
        await withSetupName({
          actorUserId: actor,
          action: "deployment.widget",
          targetType: "deployment",
          targetId: deploymentId,
          detail: { changed: diff.changed, hashes: diff.hashes },
        }),
      );
    return true;
  });
}

// A confirmation that didn't make it into the row: nothing was recorded, and the person must
// hear so rather than see the gate stay shut.
export class ConfirmationNotRecorded extends Error {}

// A person's confirmation of part of what visitors see: the brand (the chat name, avatar and
// primary color, as saved now) or the starter questions. Merged into the deployment's
// confirmations, which other screens write too, and audited. A stored value that isn't a JSON
// object (a row written by hand, double-encoded) is replaced rather than merged into, since jsonb
// `||` would turn it into an array that holds no confirmation. Returns the deployment's saved
// theme, settings and confirmations afterwards, or undefined if it isn't this customer's; throws
// ConfirmationNotRecorded, recording nothing, if the confirmation isn't there after all.
export async function saveConfirmation(
  tenantId: string,
  deploymentId: string,
  part: "brand" | "starters",
  confirmation: Confirmation,
  actor: string | null,
) {
  return db().transaction(async (tx) => {
    const [row] = await tx
      .select({ theme: deployments.theme, settings: deployments.widgetSettings })
      .from(deployments)
      .where(and(eq(deployments.id, deploymentId), eq(deployments.tenantId, tenantId)));
    if (!row) return undefined;
    const value =
      part === "brand"
        ? {
            ...confirmation,
            values: {
              ...(row.settings.nickname && { nickname: row.settings.nickname }),
              ...(row.settings.avatar && { avatar: row.settings.avatar }),
              primary: resolveTheme(row.theme).theme.color.primary,
            },
          }
        : confirmation;
    const [saved] = await tx
      .update(deployments)
      .set({
        confirmations: sql`(case when jsonb_typeof(${deployments.confirmations}) = 'object' then ${deployments.confirmations} else '{}'::jsonb end) || ${JSON.stringify({ [part]: value })}::jsonb`,
      })
      .where(eq(deployments.id, deploymentId))
      .returning({ theme: deployments.theme, settings: deployments.widgetSettings, confirmations: deployments.confirmations });
    const stored = saved?.confirmations as Record<string, { at?: unknown } | undefined> | undefined;
    if (!saved || typeof stored !== "object" || Array.isArray(stored) || stored[part]?.at !== confirmation.at) {
      throw new ConfirmationNotRecorded(`The ${part} confirmation wasn't recorded.`);
    }
    await tx.insert(auditLog).values(
      await withSetupName({
        actorUserId: actor,
        action: "deployment.confirm",
        targetType: "deployment",
        targetId: deploymentId,
        detail: { part, name: confirmation.name, verified: confirmation.verified },
      }),
    );
    return saved;
  });
}

// Who confirmed what, for the page to show.
export interface Confirmed {
  brand: "confirmed" | "changed" | "unconfirmed";
  brandBy?: Pick<Confirmation, "name" | "at">;
  startersBy?: Pick<Confirmation, "name" | "at">;
}

export function confirmedOf(saved: { theme: ThemeInput; settings: WidgetSettings; confirmations: DeploymentConfirmations }): Confirmed {
  const { brand, starters } = saved.confirmations;
  return {
    brand: brandStatus(saved.settings, saved.theme, saved.confirmations),
    ...(brand && { brandBy: { name: brand.name, at: brand.at } }),
    ...(starters && { startersBy: { name: starters.name, at: starters.at } }),
  };
}

// "theme.color.primary", "settings.ctas"…: what the audit log records about a save, without the
// values. Only what visitors get differently (widget-diff.ts).
export function changedKeys(theme: ThemeInput, settings: WidgetSettings, value: WidgetValue): string[] {
  return widgetDiff({ theme, settings }, value).changed;
}

// The key the configurator's live preview asks with: the reader key, else the manager key.
export async function previewKey(deploymentId: string): Promise<string | undefined> {
  const rows = await db()
    .select({ role: credentials.role })
    .from(credentials)
    .where(and(eq(credentials.deploymentId, deploymentId), inArray(credentials.role, PREVIEW_ROLES), isNull(credentials.revokedAt)))
    .orderBy(desc(credentials.createdAt));
  const role = PREVIEW_ROLES.find((r) => rows.some((row) => row.role === r));
  return role && loadKey(db(), env().masterKey, deploymentId, role);
}
