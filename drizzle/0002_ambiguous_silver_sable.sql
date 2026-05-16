ALTER TYPE "public"."conversation_mode" ADD VALUE 'imagine';--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "attachments" jsonb DEFAULT '[]'::jsonb NOT NULL;