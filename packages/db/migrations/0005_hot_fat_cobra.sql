CREATE TABLE "answer_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"deployment_id" uuid NOT NULL,
	"conversation_id" text NOT NULL,
	"question_hash" text NOT NULL,
	"answered" boolean NOT NULL,
	"language" text,
	"feedback" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "asked_questions" ADD COLUMN "verdict_source" text;--> statement-breakpoint
ALTER TABLE "asked_questions" ADD COLUMN "hidden" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "content_pages" ADD COLUMN "last_modified" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "content_pages" ADD COLUMN "lang" text;--> statement-breakpoint
ALTER TABLE "content_pages" ADD COLUMN "flags" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN "published" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN "sign_off" jsonb;--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN "confirmations" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "kb_limit" integer;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "kb_limit_source" text;--> statement-breakpoint
ALTER TABLE "sync_sources" ADD COLUMN "languages" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "sync_sources" ADD COLUMN "plan" jsonb;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "display_name" text;--> statement-breakpoint
ALTER TABLE "answer_events" ADD CONSTRAINT "answer_events_deployment_id_deployments_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."deployments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "answer_events_question_idx" ON "answer_events" USING btree ("deployment_id","conversation_id","question_hash");--> statement-breakpoint
CREATE INDEX "answer_events_time_idx" ON "answer_events" USING btree ("deployment_id","at");--> statement-breakpoint
-- Deployments provisioned before sign-off existed keep serving, shown as "Not signed off".
UPDATE "deployments" SET "published" = true WHERE "status" IN ('live', 'paused');
