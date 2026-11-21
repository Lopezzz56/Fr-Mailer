-- CreateEnum ConversationStatus
DO $$ BEGIN
  CREATE TYPE "ConversationStatus" AS ENUM (
    'NEEDS_REPLY',
    'WAITING_FOR_CONTACT',
    'MEETING_COORDINATION',
    'MEETING_SCHEDULED',
    'INTERESTED',
    'NOT_INTERESTED',
    'CLOSED'
  );
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- CreateEnum MessageDirection
DO $$ BEGIN
  CREATE TYPE "MessageDirection" AS ENUM ('INBOUND', 'OUTBOUND');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- CreateTable conversations
CREATE TABLE IF NOT EXISTS "conversations" (
  "id" TEXT NOT NULL,
  "campaignId" TEXT NOT NULL,
  "contactId" TEXT,
  "recipientEmail" CITEXT NOT NULL,
  "ownerId" TEXT,
  "initialSendId" TEXT,
  "status" "ConversationStatus" NOT NULL DEFAULT 'NEEDS_REPLY',
  "subject" TEXT NOT NULL,
  "sentiment" TEXT,
  "snippet" TEXT,
  "nextAction" TEXT,
  "nextActionDueAt" TIMESTAMPTZ,
  "meetingAt" TIMESTAMPTZ,
  "meetingNotes" TEXT,
  "outcome" TEXT,
  "lastMessageAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable conversation_messages
CREATE TABLE IF NOT EXISTS "conversation_messages" (
  "id" TEXT NOT NULL,
  "conversationId" TEXT NOT NULL,
  "direction" "MessageDirection" NOT NULL,
  "senderEmail" TEXT NOT NULL,
  "senderName" TEXT,
  "recipientEmail" TEXT NOT NULL,
  "recipientName" TEXT,
  "subject" TEXT NOT NULL,
  "bodyText" TEXT NOT NULL DEFAULT '',
  "bodyHtml" TEXT,
  "snippet" TEXT,
  "messageId" TEXT,
  "inReplyTo" TEXT,
  "references" TEXT,
  "sentAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "sendId" TEXT,
  "attachments" JSONB NOT NULL DEFAULT '[]',
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "conversation_messages_pkey" PRIMARY KEY ("id")
);

-- Unique constraints
CREATE UNIQUE INDEX IF NOT EXISTS "conversations_campaignId_recipientEmail_key" ON "conversations"("campaignId", "recipientEmail");
CREATE UNIQUE INDEX IF NOT EXISTS "conversations_initialSendId_key" ON "conversations"("initialSendId");
CREATE UNIQUE INDEX IF NOT EXISTS "conversation_messages_messageId_key" ON "conversation_messages"("messageId");

-- Indexes
CREATE INDEX IF NOT EXISTS "conversations_campaignId_status_idx" ON "conversations"("campaignId", "status");
CREATE INDEX IF NOT EXISTS "conversations_ownerId_status_idx" ON "conversations"("ownerId", "status");
CREATE INDEX IF NOT EXISTS "conversations_recipientEmail_idx" ON "conversations"("recipientEmail");
CREATE INDEX IF NOT EXISTS "conversations_status_lastMessageAt_idx" ON "conversations"("status", "lastMessageAt");
CREATE INDEX IF NOT EXISTS "conversations_nextActionDueAt_idx" ON "conversations"("nextActionDueAt");

CREATE INDEX IF NOT EXISTS "conversation_messages_conversationId_sentAt_idx" ON "conversation_messages"("conversationId", "sentAt");
CREATE INDEX IF NOT EXISTS "conversation_messages_inReplyTo_idx" ON "conversation_messages"("inReplyTo");
CREATE INDEX IF NOT EXISTS "conversation_messages_sendId_idx" ON "conversation_messages"("sendId");

-- Foreign keys
DO $$ BEGIN
  ALTER TABLE "conversations" ADD CONSTRAINT "conversations_campaignId_fkey"
    FOREIGN KEY ("campaignId") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  ALTER TABLE "conversations" ADD CONSTRAINT "conversations_contactId_fkey"
    FOREIGN KEY ("contactId") REFERENCES "contacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  ALTER TABLE "conversations" ADD CONSTRAINT "conversations_ownerId_fkey"
    FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  ALTER TABLE "conversations" ADD CONSTRAINT "conversations_initialSendId_fkey"
    FOREIGN KEY ("initialSendId") REFERENCES "sends"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  ALTER TABLE "conversation_messages" ADD CONSTRAINT "conversation_messages_conversationId_fkey"
    FOREIGN KEY ("conversationId") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  ALTER TABLE "conversation_messages" ADD CONSTRAINT "conversation_messages_sendId_fkey"
    FOREIGN KEY ("sendId") REFERENCES "sends"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- Data Backfill: Populate conversations and messages from existing replied sends
DO $$
DECLARE
  r RECORD;
  conv_id TEXT;
  outbound_msg_id TEXT;
  inbound_msg_id TEXT;
  reply_event RECORD;
  event_snippet TEXT;
  event_cls TEXT;
BEGIN
  FOR r IN
    SELECT s.*, c."createdById" AS campaign_owner_id
    FROM "sends" s
    JOIN "campaigns" c ON s."campaignId" = c."id"
    WHERE s."repliedAt" IS NOT NULL
  LOOP
    conv_id := 'conv_' || substr(md5(random()::text || clock_timestamp()::text), 1, 24);
    outbound_msg_id := 'cmsg_out_' || substr(md5(random()::text || clock_timestamp()::text), 1, 20);
    inbound_msg_id := 'cmsg_in_' || substr(md5(random()::text || clock_timestamp()::text), 1, 20);

    -- Find latest reply event detail
    SELECT * INTO reply_event
    FROM "send_events"
    WHERE "sendId" = r."id" AND "type" = 'REPLY'
    ORDER BY "occurredAt" DESC
    LIMIT 1;

    event_snippet := reply_event."detail"->>'snippet';
    event_cls := reply_event."detail"->>'classification';

    -- Insert conversation
    INSERT INTO "conversations" (
      "id",
      "campaignId",
      "contactId",
      "recipientEmail",
      "ownerId",
      "initialSendId",
      "status",
      "subject",
      "sentiment",
      "snippet",
      "lastMessageAt",
      "createdAt",
      "updatedAt"
    ) VALUES (
      conv_id,
      r."campaignId",
      r."contactId",
      r."email",
      coalesce(r."sentByUserId", r.campaign_owner_id),
      r."id",
      'NEEDS_REPLY',
      r."subject",
      coalesce(event_cls, 'POSITIVE'),
      coalesce(event_snippet, 'Inbound reply received'),
      coalesce(r."repliedAt", clock_timestamp()),
      coalesce(r."sentAt", clock_timestamp()),
      clock_timestamp()
    ) ON CONFLICT ("campaignId", "recipientEmail") DO NOTHING;

    -- Insert Initial Outbound Message
    INSERT INTO "conversation_messages" (
      "id",
      "conversationId",
      "direction",
      "senderEmail",
      "senderName",
      "recipientEmail",
      "subject",
      "bodyText",
      "bodyHtml",
      "snippet",
      "messageId",
      "sentAt",
      "sendId",
      "createdAt"
    ) VALUES (
      outbound_msg_id,
      conv_id,
      'OUTBOUND',
      'founderoffice@focusrealm.org',
      'Frank Lopes',
      r."email",
      r."subject",
      r."text",
      r."html",
      substr(r."text", 1, 200),
      r."messageId",
      coalesce(r."sentAt", clock_timestamp()),
      r."id",
      coalesce(r."sentAt", clock_timestamp())
    ) ON CONFLICT ("messageId") DO NOTHING;

    -- Insert Inbound Reply Message
    INSERT INTO "conversation_messages" (
      "id",
      "conversationId",
      "direction",
      "senderEmail",
      "senderName",
      "recipientEmail",
      "subject",
      "bodyText",
      "bodyHtml",
      "snippet",
      "inReplyTo",
      "sentAt",
      "sendId",
      "createdAt"
    ) VALUES (
      inbound_msg_id,
      conv_id,
      'INBOUND',
      r."email",
      reply_event."detail"->>'from',
      'founderoffice@focusrealm.org',
      coalesce(reply_event."detail"->>'subject', 'Re: ' || r."subject"),
      coalesce(event_snippet, ''),
      NULL,
      event_snippet,
      r."messageId",
      coalesce(r."repliedAt", clock_timestamp()),
      r."id",
      coalesce(r."repliedAt", clock_timestamp())
    );
  END LOOP;
END $$;
