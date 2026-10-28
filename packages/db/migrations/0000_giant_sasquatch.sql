CREATE TYPE "public"."content_path" AS ENUM('sitefinity_connector', 'sitemap', 'manual');--> statement-breakpoint
CREATE TYPE "public"."deployment_status" AS ENUM('draft', 'provisioning', 'live', 'paused', 'failed');--> statement-breakpoint
CREATE TYPE "public"."key_role" AS ENUM('reader', 'writer', 'manager');--> statement-breakpoint
CREATE TYPE "public"."sync_kind" AS ENUM('sitefinity_connector', 'sitemap', 'sharepoint', 's3');--> statement-breakpoint
CREATE TYPE "public"."tenant_status" AS ENUM('active', 'paused', 'archived');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('partner_admin', 'partner_member', 'customer_viewer');--> statement-breakpoint
CREATE TYPE "public"."widget_mode" AS ENUM('embed', 'sitefinity_native');--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_user_id" uuid,
	"action" text NOT NULL,
	"target_type" text,
	"target_id" text,
	"detail" jsonb
);
--> statement-breakpoint
CREATE TABLE "credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"deployment_id" uuid NOT NULL,
	"role" "key_role" NOT NULL,
	"service_account_id" text NOT NULL,
	"key_id" text NOT NULL,
	"secret" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "deployments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"site_url" text NOT NULL,
	"domains" text[] NOT NULL,
	"sitefinity_version" text,
	"content_path" "content_path" NOT NULL,
	"widget_mode" "widget_mode" DEFAULT 'embed' NOT NULL,
	"zone" text NOT NULL,
	"kb_id" text,
	"kb_slug" text NOT NULL,
	"search_config" text DEFAULT 'launchpad-default' NOT NULL,
	"theme" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"widget_settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "deployment_status" DEFAULT 'draft' NOT NULL,
	"provisioning_log" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deployments_kb_id_unique" UNIQUE("kb_id"),
	CONSTRAINT "deployments_kb_slug_unique" UNIQUE("kb_slug")
);
--> statement-breakpoint
CREATE TABLE "quality_daily" (
	"deployment_id" uuid NOT NULL,
	"day" date NOT NULL,
	"answer_relevance" real,
	"context_relevance" real,
	"groundedness" real,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "quality_daily_deployment_id_day_pk" PRIMARY KEY("deployment_id","day")
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"partner_name" text DEFAULT '' NOT NULL,
	"account_id" text,
	"zone" text,
	"account_type" text,
	"contract_rates" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"markup_percent" real DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sync_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"deployment_id" uuid NOT NULL,
	"kind" "sync_kind" NOT NULL,
	"external_connection_id" text,
	"sync_config_id" text,
	"sitemap_url" text,
	"page_budget" integer,
	"include_patterns" text[] DEFAULT '{}'::text[] NOT NULL,
	"exclude_patterns" text[] DEFAULT '{}'::text[] NOT NULL,
	"last_job_status" text,
	"last_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"status" "tenant_status" DEFAULT 'active' NOT NULL,
	"monthly_budget_cents" integer,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenants_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "usage_daily" (
	"deployment_id" uuid NOT NULL,
	"day" date NOT NULL,
	"questions" integer DEFAULT 0 NOT NULL,
	"searches" integer DEFAULT 0 NOT NULL,
	"query_tokens" numeric(14, 6) DEFAULT '0' NOT NULL,
	"account_metrics" jsonb,
	"cost_cents" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "usage_daily_deployment_id_day_pk" PRIMARY KEY("deployment_id","day")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"name" text,
	"role" "user_role" NOT NULL,
	"tenant_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_login_at" timestamp with time zone,
	CONSTRAINT "users_email_unique" UNIQUE("email"),
	CONSTRAINT "users_customer_viewer_has_tenant" CHECK ("users"."role" <> 'customer_viewer' OR "users"."tenant_id" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "credentials" ADD CONSTRAINT "credentials_deployment_id_deployments_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."deployments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quality_daily" ADD CONSTRAINT "quality_daily_deployment_id_deployments_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."deployments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_sources" ADD CONSTRAINT "sync_sources_deployment_id_deployments_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."deployments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_daily" ADD CONSTRAINT "usage_daily_deployment_id_deployments_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."deployments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_log_target_idx" ON "audit_log" USING btree ("target_type","target_id");--> statement-breakpoint
CREATE INDEX "credentials_deployment_role_idx" ON "credentials" USING btree ("deployment_id","role");--> statement-breakpoint
CREATE INDEX "deployments_tenant_idx" ON "deployments" USING btree ("tenant_id");