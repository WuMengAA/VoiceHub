CREATE TABLE "BroadcastPlayLog" (
	"id" serial PRIMARY KEY NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	"songId" integer NOT NULL,
	"songTitle" text,
	"songArtist" text,
	"cover" text,
	"scheduleId" integer,
	"sequence" integer,
	"playDate" varchar(10),
	"broadcasterId" integer,
	"broadcasterName" text,
	"startedAt" timestamp DEFAULT now() NOT NULL,
	"endedAt" timestamp,
	"playedSeconds" integer DEFAULT 0 NOT NULL,
	"listenerPeak" integer DEFAULT 0 NOT NULL,
	"endReason" varchar(24)
);
--> statement-breakpoint
ALTER TABLE "SystemSettings" ADD COLUMN "broadcastAutoAdvance" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "SystemSettings" ADD COLUMN "broadcastIdleReleaseSec" integer DEFAULT 180 NOT NULL;--> statement-breakpoint
ALTER TABLE "SystemSettings" ADD COLUMN "broadcastListenersEnabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
CREATE INDEX "broadcast_log_started_at_idx" ON "BroadcastPlayLog" USING btree ("startedAt");--> statement-breakpoint
CREATE INDEX "broadcast_log_song_idx" ON "BroadcastPlayLog" USING btree ("songId","startedAt");--> statement-breakpoint
CREATE INDEX "broadcast_log_broadcaster_idx" ON "BroadcastPlayLog" USING btree ("broadcasterId","startedAt");--> statement-breakpoint
CREATE INDEX "broadcast_log_schedule_idx" ON "BroadcastPlayLog" USING btree ("scheduleId");