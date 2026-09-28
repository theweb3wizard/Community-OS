CREATE TABLE "community_link_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"community_id" uuid NOT NULL,
	"code" text NOT NULL,
	"purpose" text DEFAULT 'connect' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "community_link_codes_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "processed_updates" (
	"update_id" bigint PRIMARY KEY NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "sent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "telegram_connections" ADD COLUMN "chat_title" text;--> statement-breakpoint
ALTER TABLE "telegram_connections" ADD COLUMN "chat_type" text;--> statement-breakpoint
ALTER TABLE "community_link_codes" ADD CONSTRAINT "community_link_codes_community_id_communities_id_fk" FOREIGN KEY ("community_id") REFERENCES "public"."communities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "members" ADD CONSTRAINT "members_community_user_unique" UNIQUE("community_id","telegram_user_id");--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_community_tgid_unique" UNIQUE("community_id","telegram_message_id");--> statement-breakpoint
ALTER TABLE "telegram_connections" ADD CONSTRAINT "telegram_connections_chat_unique" UNIQUE("telegram_chat_id");