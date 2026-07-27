-- Wave 02 money model: deposit-or-full payment options, amount-paid tracking,
-- desk/extension payment types, refund tracking, deposit settings.
ALTER TABLE "settings" RENAME COLUMN "reservation_fee_cents" TO "deposit_min_cents";--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "deposit_percent" integer DEFAULT 25 NOT NULL;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "cancellation_window_hours" integer DEFAULT 48 NOT NULL;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "amount_paid_cents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE "bookings" b SET "amount_paid_cents" = COALESCE((SELECT SUM(p."amount_cents") FROM "payments" p WHERE p."booking_id" = b."id" AND p."status" = 'succeeded'), 0);--> statement-breakpoint
CREATE TYPE "public"."payment_option_v2" AS ENUM('deposit', 'full');--> statement-breakpoint
ALTER TABLE "bookings" ALTER COLUMN "payment_option" TYPE "public"."payment_option_v2" USING (CASE "payment_option"::text WHEN 'reservation_fee' THEN 'deposit' WHEN 'full_deposit' THEN 'deposit' WHEN 'cash_deposit' THEN 'deposit' ELSE 'deposit' END)::"public"."payment_option_v2";--> statement-breakpoint
DROP TYPE "public"."payment_option";--> statement-breakpoint
ALTER TYPE "public"."payment_option_v2" RENAME TO "payment_option";--> statement-breakpoint
CREATE TYPE "public"."payment_method" AS ENUM('stripe', 'desk');--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "method" "payment_method" DEFAULT 'stripe' NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "refunded_cents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TYPE "public"."payment_type" ADD VALUE 'rental_deposit';--> statement-breakpoint
ALTER TYPE "public"."payment_type" ADD VALUE 'rental_full';--> statement-breakpoint
ALTER TYPE "public"."payment_type" ADD VALUE 'extension';
