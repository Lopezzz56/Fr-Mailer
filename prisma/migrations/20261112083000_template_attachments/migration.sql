ALTER TABLE "templates"
ADD COLUMN "attachments" JSONB NOT NULL DEFAULT '[]';

ALTER TABLE "sends"
ADD COLUMN "attachments" JSONB NOT NULL DEFAULT '[]';
