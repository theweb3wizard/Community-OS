CREATE TABLE "community_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"community_id" uuid NOT NULL,
	"retrieval_threshold" real DEFAULT 0.35 NOT NULL,
	"retrieval_limit" integer DEFAULT 4 NOT NULL,
	"notify_approvals" boolean DEFAULT true NOT NULL,
	"notify_failures" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "community_settings_community_id_unique" UNIQUE("community_id")
);
--> statement-breakpoint
ALTER TABLE "community_settings" ADD CONSTRAINT "community_settings_community_id_communities_id_fk" FOREIGN KEY ("community_id") REFERENCES "public"."communities"("id") ON DELETE no action ON UPDATE no action;