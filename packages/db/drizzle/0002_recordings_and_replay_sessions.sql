CREATE TYPE "public"."call_mode" AS ENUM('live', 'replay');--> statement-breakpoint
CREATE TYPE "public"."timing" AS ENUM('real', 'estimated');--> statement-breakpoint
CREATE TABLE "datasets" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"url" text NOT NULL,
	"license" text NOT NULL,
	"revision" text,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recording_audio" (
	"recording_id" uuid PRIMARY KEY NOT NULL,
	"storage_key" text NOT NULL,
	"content_type" text NOT NULL,
	"bytes" bigint NOT NULL,
	"sample_rate" integer,
	"channels" integer,
	"duration_ms" integer,
	"sha256" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recording_utterances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"recording_id" uuid NOT NULL,
	"idx" integer NOT NULL,
	"speaker" "speaker" NOT NULL,
	"text" text NOT NULL,
	"started_ms" integer NOT NULL,
	"ended_ms" integer NOT NULL,
	CONSTRAINT "recording_utterances_recording_idx_key" UNIQUE("recording_id","idx"),
	CONSTRAINT "recording_utterances_started_nonnegative" CHECK ("recording_utterances"."started_ms" >= 0),
	CONSTRAINT "recording_utterances_ended_after_started" CHECK ("recording_utterances"."ended_ms" >= "recording_utterances"."started_ms")
);
--> statement-breakpoint
CREATE TABLE "recordings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"dataset_id" text NOT NULL,
	"external_id" text NOT NULL,
	"title" text NOT NULL,
	"duration_ms" integer NOT NULL,
	"timing" "timing" NOT NULL,
	"has_audio" boolean DEFAULT false NOT NULL,
	"language" text DEFAULT 'en' NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recordings_dataset_external_key" UNIQUE("dataset_id","external_id"),
	CONSTRAINT "recordings_duration_nonnegative" CHECK ("recordings"."duration_ms" >= 0)
);
--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "mode" "call_mode" DEFAULT 'live' NOT NULL;--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "recording_id" uuid;--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "position_ms" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "last_activity_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "recording_audio" ADD CONSTRAINT "recording_audio_recording_id_recordings_id_fk" FOREIGN KEY ("recording_id") REFERENCES "public"."recordings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recording_utterances" ADD CONSTRAINT "recording_utterances_recording_id_recordings_id_fk" FOREIGN KEY ("recording_id") REFERENCES "public"."recordings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recordings" ADD CONSTRAINT "recordings_dataset_id_datasets_id_fk" FOREIGN KEY ("dataset_id") REFERENCES "public"."datasets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "recordings_dataset_id_idx" ON "recordings" USING btree ("dataset_id");--> statement-breakpoint
CREATE INDEX "recordings_duration_ms_idx" ON "recordings" USING btree ("duration_ms");--> statement-breakpoint
CREATE INDEX "recordings_has_audio_idx" ON "recordings" USING btree ("has_audio");--> statement-breakpoint
ALTER TABLE "calls" ADD CONSTRAINT "calls_recording_id_recordings_id_fk" FOREIGN KEY ("recording_id") REFERENCES "public"."recordings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "calls_recording_id_idx" ON "calls" USING btree ("recording_id");--> statement-breakpoint
CREATE INDEX "calls_live_last_activity_idx" ON "calls" USING btree ("last_activity_at") WHERE "calls"."status" = 'live';--> statement-breakpoint
ALTER TABLE "calls" ADD CONSTRAINT "calls_position_nonnegative" CHECK ("calls"."position_ms" >= 0);