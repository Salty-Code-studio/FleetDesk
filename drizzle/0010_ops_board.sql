CREATE TYPE "public"."block_type" AS ENUM('maintenance', 'carwash', 'cleaning', 'out_of_service', 'other');--> statement-breakpoint
CREATE TYPE "public"."booking_source" AS ENUM('online', 'manual');--> statement-breakpoint
ALTER TABLE "availability_blocks" ADD COLUMN "type" "block_type" DEFAULT 'other' NOT NULL;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "source" "booking_source" DEFAULT 'online' NOT NULL;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "notes" text;--> statement-breakpoint
-- plate: add nullable, backfill existing rows with a unique placeholder (the
-- owner edits real plates in Fleet), then enforce NOT NULL + UNIQUE.
ALTER TABLE "vehicles" ADD COLUMN "plate" text;--> statement-breakpoint
UPDATE "vehicles" SET "plate" = 'TMP-' || substr(id::text, 1, 8) WHERE "plate" IS NULL;--> statement-breakpoint
ALTER TABLE "vehicles" ALTER COLUMN "plate" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "vehicles" ADD CONSTRAINT "vehicles_plate_unique" UNIQUE("plate");
