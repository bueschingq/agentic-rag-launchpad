// One Launchpad instance = one partner. Tenants are the partner's customers; each deployment
// is one site with its own Agentic RAG Knowledge Box and keys.

import type { ThemeInput, WidgetSettings } from "@launchpad/theme";
import { sql } from "drizzle-orm";
import {
  bigserial,
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

export const tenantStatus = pgEnum("tenant_status", ["active", "paused", "archived"]);
export const deploymentStatus = pgEnum("deployment_status", ["draft", "provisioning", "live", "paused", "failed"]);
export const contentPath = pgEnum("content_path", ["sitefinity_connector", "sitemap", "manual"]);
export const widgetMode = pgEnum("widget_mode", ["embed", "sitefinity_native"]);
export const keyRole = pgEnum("key_role", ["reader", "writer", "manager"]);
export const syncKind = pgEnum("sync_kind", ["sitefinity_connector", "sitemap", "sharepoint", "s3"]);
export const userRole = pgEnum("user_role", ["partner_admin", "partner_member", "customer_viewer"]);

export interface ProvisioningStep {
  step: string;
  status: "ok" | "failed" | "skipped";
  at: string;
  detail?: string;
}

// Single row (id = 1): the partner's Agentic RAG account and contract terms.
export const settings = pgTable("settings", {
  id: integer("id").primaryKey().default(1),
  partnerName: text("partner_name").notNull().default(""),
  accountId: text("account_id"),
  zone: text("zone"),
  accountType: text("account_type"),
  // Price per usage metric in the contract currency, e.g. { "nuclia_tokens": 0.008 }.
  contractRates: jsonb("contract_rates").$type<Record<string, number>>().notNull().default({}),
  markupPercent: real("markup_percent").notNull().default(0),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const tenants = pgTable("tenants", {
  id: uuid("id").primaryKey().defaultRandom(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  status: tenantStatus("status").notNull().default("active"),
  monthlyBudgetCents: integer("monthly_budget_cents"),
  tags: text("tags").array().notNull().default(sql`'{}'::text[]`),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const deployments = pgTable(
  "deployments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    siteUrl: text("site_url").notNull(),
    // Origins allowed to embed the widget. Mirrored into the KB's allowed_origins.
    domains: text("domains").array().notNull(),
    sitefinityVersion: text("sitefinity_version"),
    contentPath: contentPath("content_path").notNull(),
    widgetMode: widgetMode("widget_mode").notNull().default("embed"),
    zone: text("zone").notNull(),
    kbId: text("kb_id").unique(),
    kbSlug: text("kb_slug").notNull().unique(),
    searchConfig: text("search_config").notNull().default("launchpad-default"),
    theme: jsonb("theme").$type<ThemeInput>().notNull().default({}),
    widgetSettings: jsonb("widget_settings").$type<WidgetSettings>().notNull().default({}),
    status: deploymentStatus("status").notNull().default("draft"),
    // Step-by-step record of provisioning, so a failed run can resume where it stopped.
    provisioningLog: jsonb("provisioning_log").$type<ProvisioningStep[]>().notNull().default([]),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("deployments_tenant_idx").on(t.tenantId)],
);

export const credentials = pgTable(
  "credentials",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    deploymentId: uuid("deployment_id")
      .notNull()
      .references(() => deployments.id, { onDelete: "cascade" }),
    role: keyRole("role").notNull(),
    serviceAccountId: text("service_account_id").notNull(),
    keyId: text("key_id").notNull(),
    // sealSecret(token, masterKey, credentialContext(deploymentId, role))
    secret: text("secret").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: createdAt(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [index("credentials_deployment_role_idx").on(t.deploymentId, t.role)],
);

export const syncSources = pgTable("sync_sources", {
  id: uuid("id").primaryKey().defaultRandom(),
  deploymentId: uuid("deployment_id")
    .notNull()
    .references(() => deployments.id, { onDelete: "cascade" }),
  kind: syncKind("kind").notNull(),
  externalConnectionId: text("external_connection_id"),
  syncConfigId: text("sync_config_id"),
  sitemapUrl: text("sitemap_url"),
  pageBudget: integer("page_budget"),
  includePatterns: text("include_patterns").array().notNull().default(sql`'{}'::text[]`),
  excludePatterns: text("exclude_patterns").array().notNull().default(sql`'{}'::text[]`),
  lastJobStatus: text("last_job_status"),
  lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const usageDaily = pgTable(
  "usage_daily",
  {
    deploymentId: uuid("deployment_id")
      .notNull()
      .references(() => deployments.id, { onDelete: "cascade" }),
    day: date("day").notNull(),
    questions: integer("questions").notNull().default(0),
    searches: integer("searches").notNull().default(0),
    // Sum of nuclia_tokens from the ask log (manager key; no PAT needed).
    queryTokens: numeric("query_tokens", { precision: 14, scale: 6 }).notNull().default("0"),
    // Processing/storage metrics from the Account API usage endpoint (needs a PAT).
    accountMetrics: jsonb("account_metrics").$type<Record<string, number>>(),
    costCents: integer("cost_cents"),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.deploymentId, t.day] })],
);

export const qualityDaily = pgTable(
  "quality_daily",
  {
    deploymentId: uuid("deployment_id")
      .notNull()
      .references(() => deployments.id, { onDelete: "cascade" }),
    day: date("day").notNull(),
    answerRelevance: real("answer_relevance"),
    contextRelevance: real("context_relevance"),
    groundedness: real("groundedness"),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.deploymentId, t.day] })],
);

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull().unique(),
    name: text("name"),
    role: userRole("role").notNull(),
    // Required for customer viewers: the only tenant they can see.
    tenantId: uuid("tenant_id").references(() => tenants.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
  },
  (t) => [check("users_customer_viewer_has_tenant", sql`${t.role} <> 'customer_viewer' OR ${t.tenantId} IS NOT NULL`)],
);

export const auditLog = pgTable(
  "audit_log",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    actorUserId: uuid("actor_user_id"),
    action: text("action").notNull(),
    targetType: text("target_type"),
    targetId: text("target_id"),
    detail: jsonb("detail").$type<Record<string, unknown>>(),
  },
  (t) => [index("audit_log_target_idx").on(t.targetType, t.targetId)],
);
