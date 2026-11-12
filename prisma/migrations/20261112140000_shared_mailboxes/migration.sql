-- CreateTable: mailbox_accounts
CREATE TABLE "mailbox_accounts" (
    "id" TEXT NOT NULL,
    "email" CITEXT NOT NULL,
    "fromName" TEXT NOT NULL,
    "encryptedPassword" TEXT NOT NULL,
    "lastVerifiedAt" TIMESTAMPTZ NOT NULL,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "mailbox_accounts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "mailbox_accounts_email_key" ON "mailbox_accounts"("email");

-- CreateTable: mailbox_access
CREATE TABLE "mailbox_access" (
    "id" TEXT NOT NULL,
    "mailboxId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "senderName" TEXT,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "mailbox_access_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "mailbox_access_mailboxId_userId_key" ON "mailbox_access"("mailboxId", "userId");
CREATE INDEX "mailbox_access_userId_idx" ON "mailbox_access"("userId");
CREATE INDEX "mailbox_access_mailboxId_idx" ON "mailbox_access"("mailboxId");

-- Migrate existing data from user_mailboxes safely without deleting anything
INSERT INTO "mailbox_accounts" ("id", "email", "fromName", "encryptedPassword", "lastVerifiedAt", "createdAt", "updatedAt")
SELECT "id", "email", "fromName", "encryptedPassword", "lastVerifiedAt", "createdAt", "updatedAt"
FROM "user_mailboxes"
ON CONFLICT ("email") DO NOTHING;

INSERT INTO "mailbox_access" ("id", "mailboxId", "userId", "senderName", "isDefault", "createdAt", "updatedAt")
SELECT 'acc_' || substr(md5(random()::text || clock_timestamp()::text), 1, 20), "id", "userId", "fromName", true, "createdAt", "updatedAt"
FROM "user_mailboxes"
ON CONFLICT ("mailboxId", "userId") DO NOTHING;

-- Add mailboxId to campaigns
ALTER TABLE "campaigns" ADD COLUMN IF NOT EXISTS "mailboxId" TEXT;
CREATE INDEX IF NOT EXISTS "campaigns_mailboxId_idx" ON "campaigns"("mailboxId");

-- Backfill campaign.mailboxId where fromEmail matches a mailbox account
UPDATE "campaigns" c
SET "mailboxId" = m."id"
FROM "mailbox_accounts" m
WHERE c."fromEmail" = m."email" AND c."mailboxId" IS NULL;

-- Add mailboxId and sentByUserId to sends
ALTER TABLE "sends" ADD COLUMN IF NOT EXISTS "mailboxId" TEXT;
ALTER TABLE "sends" ADD COLUMN IF NOT EXISTS "sentByUserId" TEXT;
CREATE INDEX IF NOT EXISTS "sends_mailboxId_idx" ON "sends"("mailboxId");
CREATE INDEX IF NOT EXISTS "sends_sentByUserId_idx" ON "sends"("sentByUserId");

-- Foreign key constraints
ALTER TABLE "mailbox_access" ADD CONSTRAINT "mailbox_access_mailboxId_fkey" FOREIGN KEY ("mailboxId") REFERENCES "mailbox_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "mailbox_access" ADD CONSTRAINT "mailbox_access_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_mailboxId_fkey" FOREIGN KEY ("mailboxId") REFERENCES "mailbox_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "sends" ADD CONSTRAINT "sends_mailboxId_fkey" FOREIGN KEY ("mailboxId") REFERENCES "mailbox_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "sends" ADD CONSTRAINT "sends_sentByUserId_fkey" FOREIGN KEY ("sentByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

