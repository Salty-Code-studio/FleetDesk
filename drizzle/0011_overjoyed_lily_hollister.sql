ALTER TABLE "admin_users" ADD COLUMN "mfa_failed_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "admin_users" ADD COLUMN "mfa_locked_until" timestamp with time zone;--> statement-breakpoint
-- Collapse any pre-existing duplicate live payments (keep the most recent per
-- booking) so the one-live-payment unique index can build on existing data.
-- No-op on a fresh database.
UPDATE "payments" SET "status" = 'failed', "updated_at" = now() WHERE "id" IN (
  SELECT "id" FROM (
    SELECT "id", row_number() OVER (PARTITION BY "booking_id" ORDER BY "created_at" DESC, "id" DESC) AS rn
    FROM "payments" WHERE "status" IN ('pending','succeeded')
  ) ranked WHERE rn > 1
);--> statement-breakpoint
CREATE UNIQUE INDEX "payments_one_live_per_booking" ON "payments" USING btree ("booking_id") WHERE "payments"."status" in ('pending','succeeded');