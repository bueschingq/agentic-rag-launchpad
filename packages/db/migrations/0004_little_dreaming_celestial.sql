CREATE TABLE "alerts_sent" (
	"key" text PRIMARY KEY NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "asked_questions" (
	"deployment_id" uuid NOT NULL,
	"log_id" text NOT NULL,
	"asked_at" timestamp with time zone NOT NULL,
	"question" text NOT NULL,
	"answered" boolean NOT NULL,
	"feedback" text,
	"partner_test" boolean DEFAULT false NOT NULL,
	"cited_urls" text[] DEFAULT '{}'::text[] NOT NULL,
	CONSTRAINT "asked_questions_deployment_id_log_id_pk" PRIMARY KEY("deployment_id","log_id")
);
--> statement-breakpoint
CREATE TABLE "leads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"deployment_id" uuid NOT NULL,
	"payload" jsonb NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "prompt_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"deployment_id" uuid NOT NULL,
	"prompt" text NOT NULL,
	"language" text NOT NULL,
	"actor_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "refused_origins" (
	"deployment_id" uuid NOT NULL,
	"origin" text NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "refused_origins_deployment_id_origin_pk" PRIMARY KEY("deployment_id","origin")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sessions_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "share_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"tenant_id" uuid NOT NULL,
	"deployment_id" uuid,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"actor_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "share_links_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "widget_events_daily" (
	"deployment_id" uuid NOT NULL,
	"day" date NOT NULL,
	"name" text NOT NULL,
	"dimension" text DEFAULT '' NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "widget_events_daily_deployment_id_day_name_dimension_pk" PRIMARY KEY("deployment_id","day","name","dimension")
);
--> statement-breakpoint
ALTER TABLE "content_pages" ADD COLUMN "text" text;--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN "validation" jsonb;--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN "preflight" jsonb;--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN "ready_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN "first_seen_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN "first_seen_origin" text;--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN "lead_delivery" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "alert_webhook_url" text;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "alert_emails" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "budget_mode" text DEFAULT 'alert' NOT NULL;--> statement-breakpoint
ALTER TABLE "asked_questions" ADD CONSTRAINT "asked_questions_deployment_id_deployments_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."deployments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_deployment_id_deployments_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."deployments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prompt_versions" ADD CONSTRAINT "prompt_versions_deployment_id_deployments_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."deployments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refused_origins" ADD CONSTRAINT "refused_origins_deployment_id_deployments_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."deployments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_links" ADD CONSTRAINT "share_links_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_links" ADD CONSTRAINT "share_links_deployment_id_deployments_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."deployments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "widget_events_daily" ADD CONSTRAINT "widget_events_daily_deployment_id_deployments_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."deployments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "asked_questions_time_idx" ON "asked_questions" USING btree ("deployment_id","asked_at");--> statement-breakpoint
CREATE INDEX "prompt_versions_deployment_idx" ON "prompt_versions" USING btree ("deployment_id","created_at");