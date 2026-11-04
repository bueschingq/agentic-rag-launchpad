CREATE TABLE "site_scans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"deployment_id" uuid NOT NULL,
	"url" text NOT NULL,
	"final_url" text NOT NULL,
	"platform" jsonb NOT NULL,
	"sitemap_pages" integer DEFAULT 0 NOT NULL,
	"result" jsonb NOT NULL,
	"screenshot" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "site_scans_deployment_id_unique" UNIQUE("deployment_id")
);
--> statement-breakpoint
ALTER TABLE "site_scans" ADD CONSTRAINT "site_scans_deployment_id_deployments_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."deployments"("id") ON DELETE cascade ON UPDATE no action;