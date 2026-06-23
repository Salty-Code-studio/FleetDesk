ALTER TABLE "admin_users" ADD COLUMN "totp_last_used_step" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "admin_users" ADD COLUMN "lockout_count" integer DEFAULT 0 NOT NULL;