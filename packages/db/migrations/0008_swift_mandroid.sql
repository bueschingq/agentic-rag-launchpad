CREATE TABLE "judgements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"deployment_id" uuid NOT NULL,
	"question_hash" text NOT NULL,
	"answer_hash" text NOT NULL,
	"verdict" text NOT NULL,
	"reason" text NOT NULL,
	"model" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "content_pages" ADD COLUMN "facts" jsonb;--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN "answering_rules" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN "augmentation" jsonb;--> statement-breakpoint
ALTER TABLE "judgements" ADD CONSTRAINT "judgements_deployment_id_deployments_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."deployments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "judgements_pair_idx" ON "judgements" USING btree ("deployment_id","question_hash","answer_hash");