CREATE TABLE "early_access_leads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"company" text DEFAULT '' NOT NULL,
	"country" text DEFAULT '' NOT NULL,
	"fleet_size" text DEFAULT '' NOT NULL,
	"message" text DEFAULT '' NOT NULL,
	"source" text DEFAULT 'early-access' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
