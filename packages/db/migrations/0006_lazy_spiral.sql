ALTER TABLE "answer_events" ADD COLUMN "attempts" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "answer_events" ADD COLUMN "origin" text;--> statement-breakpoint
ALTER TABLE "asked_questions" ADD COLUMN "attempts" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "asked_questions" ADD COLUMN "origin" text;--> statement-breakpoint
ALTER TABLE "content_pages" ADD COLUMN "published_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "content_pages" ADD COLUMN "page_modified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "content_pages" ADD COLUMN "sitemap_lastmod" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "content_pages" ADD COLUMN "extractor_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "content_pages" ADD COLUMN "rules_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN "staging_domains" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "sync_sources" ADD COLUMN "pinned" text[] DEFAULT '{}'::text[] NOT NULL;