-- Add 'picked_up' to booking_status BEFORE 'cancelled'.
--
-- NOT `ALTER TYPE ... ADD VALUE`: drizzle runs every pending migration in ONE
-- transaction, and 0016 references 'picked_up' in the exclusion-constraint
-- predicate in that same transaction. On an already-deployed tenant (type
-- committed at <=0014) Postgres rejects that with 55P04 "unsafe use of new
-- value". Fresh installs dodge it only because the type is CREATEd in the same
-- transaction. Instead we build a v2 type inside this transaction and swap the
-- column onto it (the proven in-transaction pattern used for payment_option in
-- 0017), which is safe on BOTH fresh and populated databases.
CREATE TYPE "public"."booking_status_v2" AS ENUM('pending', 'confirmed', 'picked_up', 'cancelled', 'completed');--> statement-breakpoint
-- The overlap exclusion constraint's predicate references "status", so the
-- column type cannot be swapped while it exists. Drop it here; 0016 recreates
-- it (on the new timestamptz columns, with 'picked_up' in the predicate). All
-- of this is one transaction, so the committed schema is never left unguarded.
ALTER TABLE "bookings" DROP CONSTRAINT IF EXISTS "bookings_no_overlap";--> statement-breakpoint
ALTER TABLE "bookings" ALTER COLUMN "status" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "bookings" ALTER COLUMN "status" TYPE "public"."booking_status_v2" USING "status"::text::"public"."booking_status_v2";--> statement-breakpoint
ALTER TABLE "bookings" ALTER COLUMN "status" SET DEFAULT 'pending';--> statement-breakpoint
DROP TYPE "public"."booking_status";--> statement-breakpoint
ALTER TYPE "public"."booking_status_v2" RENAME TO "booking_status";
