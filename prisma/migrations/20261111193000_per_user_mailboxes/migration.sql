CREATE TABLE "user_mailboxes" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "email" CITEXT NOT NULL,
    "fromName" TEXT NOT NULL,
    "encryptedPassword" TEXT NOT NULL,
    "lastVerifiedAt" TIMESTAMPTZ NOT NULL,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "user_mailboxes_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "user_mailboxes_userId_key" ON "user_mailboxes"("userId");
CREATE UNIQUE INDEX "user_mailboxes_email_key" ON "user_mailboxes"("email");

ALTER TABLE "user_mailboxes"
ADD CONSTRAINT "user_mailboxes_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
