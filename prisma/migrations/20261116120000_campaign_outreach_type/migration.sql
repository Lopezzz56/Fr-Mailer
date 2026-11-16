-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "CampaignOutreachType" AS ENUM ('CUSTOMER_OUTREACH', 'PARTNERSHIPS', 'ADVISORS', 'HIRING_TALENT', 'PRESS_MEDIA', 'OTHER');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- AlterTable
ALTER TABLE "campaigns" ADD COLUMN IF NOT EXISTS "outreachType" "CampaignOutreachType" NOT NULL DEFAULT 'CUSTOMER_OUTREACH';

-- CreateIndex
CREATE INDEX IF NOT EXISTS "campaigns_outreach_type_idx" ON "campaigns"("outreachType");

-- Backfill existing campaigns based on existing naming context:
UPDATE "campaigns" SET "outreachType" = 'ADVISORS' WHERE lower("name") LIKE '%advis%';
UPDATE "campaigns" SET "outreachType" = 'PARTNERSHIPS' WHERE lower("name") LIKE '%comrkt%' OR lower("name") LIKE '%partner%';

