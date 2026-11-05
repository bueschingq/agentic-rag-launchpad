CREATE TABLE "question_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"deployment_id" uuid NOT NULL,
	"conversation_id" text NOT NULL,
	"question_hash" text NOT NULL,
	"origin" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "content_pages" ADD COLUMN "key_intent" text;--> statement-breakpoint
ALTER TABLE "sync_sources" ADD COLUMN "kept" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "question_events" ADD CONSTRAINT "question_events_deployment_id_deployments_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."deployments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "question_events_question_idx" ON "question_events" USING btree ("deployment_id","conversation_id","question_hash");--> statement-breakpoint
CREATE INDEX "question_events_time_idx" ON "question_events" USING btree ("deployment_id","at");