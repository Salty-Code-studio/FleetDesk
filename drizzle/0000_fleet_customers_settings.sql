CREATE TYPE "public"."vehicle_status" AS ENUM('active', 'maintenance', 'retired');--> statement-breakpoint
CREATE TABLE "availability_blocks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"vehicle_id" uuid NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "availability_blocks_dates" CHECK ("availability_blocks"."end_date" > "availability_blocks"."start_date")
);
--> statement-breakpoint
CREATE TABLE "vehicles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"class" text NOT NULL,
	"name" text NOT NULL,
	"seats" integer NOT NULL,
	"transmission" text NOT NULL,
	"ac" boolean DEFAULT true NOT NULL,
	"doors" integer NOT NULL,
	"photos" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"price_day_cents" integer NOT NULL,
	"price_week_cents" integer NOT NULL,
	"price_month_cents" integer NOT NULL,
	"deposit_cents" integer,
	"status" "vehicle_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vehicles_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "customers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"name" text DEFAULT '' NOT NULL,
	"phone" text DEFAULT '' NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customers_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "blackout_dates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	CONSTRAINT "blackout_dates_dates" CHECK ("blackout_dates"."end_date" > "blackout_dates"."start_date")
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"reservation_fee_cents" integer DEFAULT 3000 NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"min_driver_age" integer DEFAULT 21 NOT NULL,
	"turnaround_buffer_days" integer DEFAULT 1 NOT NULL,
	"min_rental_days" integer DEFAULT 1 NOT NULL,
	"max_rental_days" integer DEFAULT 90 NOT NULL,
	"max_advance_days" integer DEFAULT 365 NOT NULL,
	"admin_alert_recipients" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "settings_singleton" CHECK ("settings"."id" = 1)
);
--> statement-breakpoint
ALTER TABLE "availability_blocks" ADD CONSTRAINT "availability_blocks_vehicle_id_vehicles_id_fk" FOREIGN KEY ("vehicle_id") REFERENCES "public"."vehicles"("id") ON DELETE cascade ON UPDATE no action;