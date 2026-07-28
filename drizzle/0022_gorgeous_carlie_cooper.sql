CREATE TYPE "public"."inspection_kind" AS ENUM('pickup', 'return');--> statement-breakpoint
ALTER TYPE "public"."payment_type" ADD VALUE 'balance';--> statement-breakpoint
CREATE TABLE "inspections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"booking_id" uuid NOT NULL,
	"kind" "inspection_kind" NOT NULL,
	"odometer" integer,
	"fuel_level" smallint,
	"notes" text DEFAULT '' NOT NULL,
	"photos" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"license_photo_key" text,
	"signature_key" text,
	"contract_pdf_key" text,
	"damage_flags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"accepted_policy_version" integer,
	"agreement_signed" boolean DEFAULT false NOT NULL,
	"rules_signed" boolean DEFAULT false NOT NULL,
	"license_copy_received" boolean DEFAULT false NOT NULL,
	"borg_received_cents" integer,
	"borg_method" text,
	"borg_returned_cents" integer,
	"borg_withheld_cents" integer,
	"borg_withheld_reason" text,
	"keys_returned" boolean DEFAULT false NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inspections_fuel_level" CHECK ("inspections"."fuel_level" IS NULL OR ("inspections"."fuel_level" >= 0 AND "inspections"."fuel_level" <= 8))
);
--> statement-breakpoint
ALTER TABLE "inspections" ADD CONSTRAINT "inspections_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inspections" ADD CONSTRAINT "inspections_created_by_admin_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."admin_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "inspections_booking_kind" ON "inspections" USING btree ("booking_id","kind");