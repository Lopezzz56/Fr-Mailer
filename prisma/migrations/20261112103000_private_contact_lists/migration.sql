ALTER TABLE "contact_lists"
ADD COLUMN "isShared" BOOLEAN NOT NULL DEFAULT false;

UPDATE "contact_lists"
SET "isShared" = true
WHERE "createdById" IS NULL;
