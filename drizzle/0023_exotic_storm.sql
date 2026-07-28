ALTER TABLE "admin_users" ADD COLUMN "name" text;--> statement-breakpoint
ALTER TABLE "admin_users" ADD COLUMN "login_code_hash" text;--> statement-breakpoint
ALTER TABLE "admin_users" ADD COLUMN "code_failed_attempts" smallint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "admin_users" ADD COLUMN "code_locked_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "admin_users" ADD COLUMN "active" boolean DEFAULT true NOT NULL;