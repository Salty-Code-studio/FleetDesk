-- Enforce the turnaround (cleaning) buffer in the DATABASE, not just the
-- advisory pre-check. Each booking stores buffer_end_date = end_date + the
-- turnaround buffer at booking time, and the exclusion constraint runs over
-- [start_date, buffer_end_date) so two bookings can't share the cleaning gap
-- even under a concurrent race.

-- Add nullable, backfill existing rows (buffer 0), then enforce NOT NULL.
ALTER TABLE "bookings" ADD COLUMN "buffer_end_date" date;--> statement-breakpoint
UPDATE "bookings" SET "buffer_end_date" = "end_date" WHERE "buffer_end_date" IS NULL;--> statement-breakpoint
ALTER TABLE "bookings" ALTER COLUMN "buffer_end_date" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_buffer" CHECK ("bookings"."buffer_end_date" >= "bookings"."end_date");--> statement-breakpoint

-- Swap the exclusion constraint to span the buffered range.
ALTER TABLE "bookings" DROP CONSTRAINT "bookings_no_overlap";--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_no_overlap"
  EXCLUDE USING gist (
    "vehicle_id" WITH =,
    daterange("start_date", "buffer_end_date", '[)') WITH &&
  ) WHERE (status IN ('pending', 'confirmed'));
