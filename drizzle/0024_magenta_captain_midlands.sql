CREATE TYPE "public"."approval_status" AS ENUM('open', 'confirmed', 'declined', 'closed');--> statement-breakpoint
CREATE TABLE "approval_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"booking_id" uuid NOT NULL,
	"status" "approval_status" DEFAULT 'open' NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"sent_to" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"reminder_count" integer DEFAULT 0 NOT NULL,
	"reminded_at" timestamp with time zone,
	"decided_by" text,
	"decided_channel" text,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "approval_managers" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "approval_reminder_hours" integer DEFAULT 4 NOT NULL;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "approval_max_reminders" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "approval_requests_open_booking_uq" ON "approval_requests" USING btree ("booking_id") WHERE "approval_requests"."status" = 'open';--> statement-breakpoint
CREATE INDEX "approval_requests_status_idx" ON "approval_requests" USING btree ("status");