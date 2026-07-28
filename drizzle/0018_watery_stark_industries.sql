ALTER TABLE "vehicles" ADD COLUMN "insurance_expires_on" date;--> statement-breakpoint
ALTER TABLE "vehicles" ADD COLUMN "inspection_due_on" date;--> statement-breakpoint
ALTER TABLE "vehicles" ADD COLUMN "insurance_alert_stage" smallint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "vehicles" ADD COLUMN "inspection_alert_stage" smallint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "compliance_alert_days" integer DEFAULT 30 NOT NULL;