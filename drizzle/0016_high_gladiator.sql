-- Time foundation: date -> timestamptz (Aruba wall time), hours buffer,
-- exclusion constraint over tstzrange incl. picked_up. Data-preserving.

-- bookings ----------------------------------------------------------------
ALTER TABLE "bookings" ADD COLUMN "start_at" timestamptz;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "end_at" timestamptz;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "buffer_end_at" timestamptz;--> statement-breakpoint
UPDATE "bookings" SET
  "start_at" = ("start_date" + time '09:00')::timestamp AT TIME ZONE 'America/Aruba',
  "end_at" = ("end_date" + time '09:00')::timestamp AT TIME ZONE 'America/Aruba',
  "buffer_end_at" = ("buffer_end_date" + time '09:00')::timestamp AT TIME ZONE 'America/Aruba';--> statement-breakpoint
ALTER TABLE "bookings" ALTER COLUMN "start_at" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "bookings" ALTER COLUMN "end_at" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "bookings" ALTER COLUMN "buffer_end_at" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "bookings" DROP CONSTRAINT IF EXISTS "bookings_no_overlap";--> statement-breakpoint
ALTER TABLE "bookings" DROP CONSTRAINT IF EXISTS "bookings_dates";--> statement-breakpoint
ALTER TABLE "bookings" DROP CONSTRAINT IF EXISTS "bookings_buffer";--> statement-breakpoint
ALTER TABLE "bookings" DROP COLUMN "start_date";--> statement-breakpoint
ALTER TABLE "bookings" DROP COLUMN "end_date";--> statement-breakpoint
ALTER TABLE "bookings" DROP COLUMN "buffer_end_date";--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_dates" CHECK ("end_at" > "start_at");--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_buffer" CHECK ("buffer_end_at" >= "end_at");--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_no_overlap"
  EXCLUDE USING gist (
    "vehicle_id" WITH =,
    tstzrange("start_at", "buffer_end_at", '[)') WITH &&
  ) WHERE (status IN ('pending', 'confirmed', 'picked_up'));--> statement-breakpoint

-- availability_blocks ------------------------------------------------------
ALTER TABLE "availability_blocks" ADD COLUMN "start_at" timestamptz;--> statement-breakpoint
ALTER TABLE "availability_blocks" ADD COLUMN "end_at" timestamptz;--> statement-breakpoint
UPDATE "availability_blocks" SET
  "start_at" = ("start_date")::timestamp AT TIME ZONE 'America/Aruba',
  "end_at" = ("end_date")::timestamp AT TIME ZONE 'America/Aruba';--> statement-breakpoint
ALTER TABLE "availability_blocks" ALTER COLUMN "start_at" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "availability_blocks" ALTER COLUMN "end_at" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "availability_blocks" DROP CONSTRAINT IF EXISTS "availability_blocks_dates";--> statement-breakpoint
ALTER TABLE "availability_blocks" DROP COLUMN "start_date";--> statement-breakpoint
ALTER TABLE "availability_blocks" DROP COLUMN "end_date";--> statement-breakpoint
ALTER TABLE "availability_blocks" ADD CONSTRAINT "availability_blocks_dates" CHECK ("end_at" > "start_at");--> statement-breakpoint

-- settings -----------------------------------------------------------------
ALTER TABLE "settings" ADD COLUMN "turnaround_buffer_hours" integer NOT NULL DEFAULT 24;--> statement-breakpoint
UPDATE "settings" SET "turnaround_buffer_hours" = "turnaround_buffer_days" * 24;--> statement-breakpoint
ALTER TABLE "settings" DROP COLUMN "turnaround_buffer_days";--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "opening_time" text NOT NULL DEFAULT '08:00';--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "closing_time" text NOT NULL DEFAULT '18:00';
