CREATE TYPE "public"."page_status" AS ENUM('queued', 'processing', 'indexed', 'skipped', 'failed', 'removed');--> statement-breakpoint
CREATE TABLE "content_pages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"deployment_id" uuid NOT NULL,
	"url" text NOT NULL,
	"title" text,
	"slug" text NOT NULL,
	"resource_id" text,
	"content_hash" text,
	"words" integer DEFAULT 0 NOT NULL,
	"status" "page_status" DEFAULT 'queued' NOT NULL,
	"detail" text,
	"sent_at" timestamp with time zone,
	"indexed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sync_sources" ADD COLUMN "started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sync_sources" ADD COLUMN "last_error" text;--> statement-breakpoint
ALTER TABLE "sync_sources" ADD COLUMN "pages_found" integer;--> statement-breakpoint
ALTER TABLE "sync_sources" ADD COLUMN "discovery" text;--> statement-breakpoint
ALTER TABLE "sync_sources" ADD COLUMN "resync_hours" integer DEFAULT 168;--> statement-breakpoint
ALTER TABLE "content_pages" ADD CONSTRAINT "content_pages_deployment_id_deployments_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."deployments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "content_pages_url_idx" ON "content_pages" USING btree ("deployment_id","url");--> statement-breakpoint
CREATE INDEX "content_pages_status_idx" ON "content_pages" USING btree ("deployment_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "sync_sources_kind_idx" ON "sync_sources" USING btree ("deployment_id","kind");