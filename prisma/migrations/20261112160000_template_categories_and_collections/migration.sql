-- AlterTable
ALTER TABLE "templates" ADD COLUMN IF NOT EXISTS "category" TEXT;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "templates_category_idx" ON "templates"("category");

-- Backfill / migrate existing sequence step templates into campaign_templates
-- Ensures every template used in a campaign sequence is safely part of that campaign's collection
INSERT INTO "campaign_templates" ("id", "campaignId", "templateId", "isFallback", "priority", "createdAt", "updatedAt")
SELECT
  'migrated-ct-' || substr(md5(random()::text || clock_timestamp()::text), 1, 20),
  s."campaignId",
  s."templateId",
  false,
  0,
  NOW(),
  NOW()
FROM "campaign_sequence_steps" s
LEFT JOIN "campaign_templates" ct
  ON ct."campaignId" = s."campaignId" AND ct."templateId" = s."templateId"
WHERE ct.id IS NULL
GROUP BY s."campaignId", s."templateId";

