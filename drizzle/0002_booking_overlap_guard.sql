-- Booking integrity, enforced by the database itself (spec §7):
-- two bookings for the same vehicle with overlapping [start, end) ranges are
-- physically impossible, even under a concurrent race. Cancelled/completed
-- bookings fall outside the partial constraint, so they free their range.
CREATE EXTENSION IF NOT EXISTS btree_gist;
--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_no_overlap"
  EXCLUDE USING gist (
    "vehicle_id" WITH =,
    daterange("start_date", "end_date", '[)') WITH &&
  ) WHERE (status IN ('pending', 'confirmed'));
