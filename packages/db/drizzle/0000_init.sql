CREATE TYPE "public"."call_status" AS ENUM('live', 'ended', 'failed');--> statement-breakpoint
CREATE TYPE "public"."feedback_signal" AS ENUM('thumbs_up', 'thumbs_down', 'used', 'ignored');--> statement-breakpoint
CREATE TYPE "public"."speaker" AS ENUM('rep', 'prospect');--> statement-breakpoint
CREATE TYPE "public"."suggestion_status" AS ENUM('streaming', 'complete', 'failed');--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "playbooks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"product_description" text NOT NULL,
	"ideal_customer" text NOT NULL,
	"objections" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"tone_notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"playbook_id" uuid,
	"title" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"status" "call_status" DEFAULT 'live' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "calls_ended_after_started" CHECK ("calls"."ended_at" IS NULL OR "calls"."ended_at" >= "calls"."started_at")
);
--> statement-breakpoint
CREATE TABLE "utterances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"call_id" uuid NOT NULL,
	"speaker" "speaker" NOT NULL,
	"text" text NOT NULL,
	"started_ms" integer NOT NULL,
	"ended_ms" integer NOT NULL,
	"is_final" boolean DEFAULT true NOT NULL,
	"confidence" real,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "utterances_id_call_id_key" UNIQUE("id","call_id"),
	CONSTRAINT "utterances_started_ms_nonnegative" CHECK ("utterances"."started_ms" >= 0),
	CONSTRAINT "utterances_ended_after_started" CHECK ("utterances"."ended_ms" >= "utterances"."started_ms"),
	CONSTRAINT "utterances_confidence_range" CHECK ("utterances"."confidence" IS NULL OR ("utterances"."confidence" >= 0 AND "utterances"."confidence" <= 1))
);
--> statement-breakpoint
CREATE TABLE "suggestions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"call_id" uuid NOT NULL,
	"utterance_id" uuid NOT NULL,
	"text" text DEFAULT '' NOT NULL,
	"model" text NOT NULL,
	"prompt_version" text NOT NULL,
	"status" "suggestion_status" DEFAULT 'streaming' NOT NULL,
	"utterance_end_at" timestamp with time zone,
	"request_sent_at" timestamp with time zone,
	"first_token_at" timestamp with time zone,
	"last_token_at" timestamp with time zone,
	"client_rendered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "suggestion_feedback" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"suggestion_id" uuid NOT NULL,
	"signal" "feedback_signal" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "suggestion_feedback_suggestion_signal_key" UNIQUE("suggestion_id","signal")
);
--> statement-breakpoint
CREATE TABLE "call_summaries" (
	"call_id" uuid PRIMARY KEY NOT NULL,
	"summary" text NOT NULL,
	"objections_raised" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"next_steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"coaching_notes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "playbooks" ADD CONSTRAINT "playbooks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calls" ADD CONSTRAINT "calls_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calls" ADD CONSTRAINT "calls_playbook_id_playbooks_id_fk" FOREIGN KEY ("playbook_id") REFERENCES "public"."playbooks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "utterances" ADD CONSTRAINT "utterances_call_id_calls_id_fk" FOREIGN KEY ("call_id") REFERENCES "public"."calls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suggestions" ADD CONSTRAINT "suggestions_call_id_calls_id_fk" FOREIGN KEY ("call_id") REFERENCES "public"."calls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suggestions" ADD CONSTRAINT "suggestions_utterance_same_call_fk" FOREIGN KEY ("utterance_id","call_id") REFERENCES "public"."utterances"("id","call_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suggestion_feedback" ADD CONSTRAINT "suggestion_feedback_suggestion_id_suggestions_id_fk" FOREIGN KEY ("suggestion_id") REFERENCES "public"."suggestions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_summaries" ADD CONSTRAINT "call_summaries_call_id_calls_id_fk" FOREIGN KEY ("call_id") REFERENCES "public"."calls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_lower_key" ON "users" USING btree (lower("email"));--> statement-breakpoint
CREATE INDEX "playbooks_user_id_idx" ON "playbooks" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "calls_user_id_started_at_idx" ON "calls" USING btree ("user_id","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "calls_playbook_id_idx" ON "calls" USING btree ("playbook_id");--> statement-breakpoint
CREATE INDEX "utterances_call_id_started_ms_idx" ON "utterances" USING btree ("call_id","started_ms");--> statement-breakpoint
CREATE INDEX "suggestions_call_id_created_at_idx" ON "suggestions" USING btree ("call_id","created_at");--> statement-breakpoint
CREATE INDEX "suggestions_utterance_id_idx" ON "suggestions" USING btree ("utterance_id");--> statement-breakpoint
CREATE INDEX "suggestions_prompt_version_idx" ON "suggestions" USING btree ("prompt_version");