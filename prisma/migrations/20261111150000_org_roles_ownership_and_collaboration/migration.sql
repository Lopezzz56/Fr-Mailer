-- CreateEnum
CREATE TYPE "CampaignAccessRole" AS ENUM ('OWNER', 'EDITOR', 'VIEWER');

-- CreateEnum
CREATE TYPE "TemplateScope" AS ENUM ('ORGANIZATION', 'PERSONAL', 'SHARED', 'CAMPAIGN');

-- AlterEnum
ALTER TYPE "UserRole" ADD VALUE 'FOUNDER_OFFICE';

-- AlterTable
ALTER TABLE "campaigns" ADD COLUMN "approvalRole" "UserRole";

-- AlterTable
ALTER TABLE "contact_lists" ADD COLUMN "createdById" TEXT;

-- AlterTable
ALTER TABLE "contacts" ADD COLUMN "createdById" TEXT;

-- AlterTable
ALTER TABLE "templates" ADD COLUMN "createdById" TEXT,
ADD COLUMN "scope" "TemplateScope" NOT NULL DEFAULT 'ORGANIZATION';

-- AlterTable
ALTER TABLE "users" ADD COLUMN "canSendWithoutApproval" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "campaign_collaborators" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "CampaignAccessRole" NOT NULL DEFAULT 'EDITOR',
    "addedById" TEXT,
    "addedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "campaign_collaborators_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "campaign_collaborators_userId_idx" ON "campaign_collaborators"("userId");

-- CreateIndex
CREATE INDEX "campaign_collaborators_campaignId_idx" ON "campaign_collaborators"("campaignId");

-- CreateIndex
CREATE UNIQUE INDEX "campaign_collaborators_campaignId_userId_key" ON "campaign_collaborators"("campaignId", "userId");

-- CreateIndex
CREATE INDEX "campaigns_createdById_idx" ON "campaigns"("createdById");

-- CreateIndex
CREATE INDEX "contact_lists_createdById_idx" ON "contact_lists"("createdById");

-- CreateIndex
CREATE INDEX "contacts_createdById_idx" ON "contacts"("createdById");

-- CreateIndex
CREATE INDEX "templates_scope_idx" ON "templates"("scope");

-- CreateIndex
CREATE INDEX "templates_createdById_idx" ON "templates"("createdById");

-- AddForeignKey
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contact_lists" ADD CONSTRAINT "contact_lists_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "templates" ADD CONSTRAINT "templates_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_collaborators" ADD CONSTRAINT "campaign_collaborators_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_collaborators" ADD CONSTRAINT "campaign_collaborators_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_collaborators" ADD CONSTRAINT "campaign_collaborators_addedById_fkey" FOREIGN KEY ("addedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

