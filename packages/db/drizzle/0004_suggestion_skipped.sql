CREATE TYPE "public"."suggestion_skip_reason" AS ENUM('prospect_backchannel');--> statement-breakpoint
ALTER TYPE "public"."suggestion_status" ADD VALUE 'skipped';--> statement-breakpoint
ALTER TABLE "suggestions" ADD COLUMN "skip_reason" "suggestion_skip_reason";