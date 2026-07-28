ALTER TABLE "settings" ALTER COLUMN "min_driver_age" SET DEFAULT 18;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "young_driver_age" integer DEFAULT 21 NOT NULL;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "young_driver_fee_cents_per_day" integer DEFAULT 1000 NOT NULL;