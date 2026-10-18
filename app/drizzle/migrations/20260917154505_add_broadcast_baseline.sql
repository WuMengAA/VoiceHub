ALTER TABLE "SystemSettings" ADD COLUMN "broadcastEnabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "SystemSettings" ADD COLUMN "broadcastBaselineUserId" integer;