/*
  Warnings:

  - Added the required column `referralCode` to the `users` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "positions" ADD COLUMN "commissionCharged" DECIMAL;

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_deposits" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "network" TEXT,
    "amount" DECIMAL NOT NULL,
    "method" TEXT NOT NULL,
    "reference" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "creditedByAdminId" TEXT,
    "txHash" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "creditedAt" DATETIME,
    CONSTRAINT "deposits_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_deposits" ("amount", "createdAt", "creditedAt", "creditedByAdminId", "currency", "id", "method", "network", "reference", "status", "txHash", "userId") SELECT "amount", "createdAt", "creditedAt", "creditedByAdminId", "currency", "id", "method", "network", "reference", "status", "txHash", "userId" FROM "deposits";
DROP TABLE "deposits";
ALTER TABLE "new_deposits" RENAME TO "deposits";
CREATE TABLE "new_users" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'user',
    "status" TEXT NOT NULL DEFAULT 'active',
    "twoFaSecret" TEXT,
    "twoFaEnabled" BOOLEAN NOT NULL DEFAULT false,
    "subscriptionTier" TEXT NOT NULL DEFAULT 'free',
    "referralCode" TEXT NOT NULL,
    "referredByCode" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_users" ("createdAt", "email", "id", "passwordHash", "role", "status", "twoFaEnabled", "twoFaSecret", "updatedAt", "referralCode") SELECT "createdAt", "email", "id", "passwordHash", "role", "status", "twoFaEnabled", "twoFaSecret", "updatedAt", upper(substr("id", 1, 8)) FROM "users";
DROP TABLE "users";
ALTER TABLE "new_users" RENAME TO "users";
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");
CREATE UNIQUE INDEX "users_referralCode_key" ON "users"("referralCode");
CREATE TABLE "new_withdrawals" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "amount" DECIMAL NOT NULL,
    "destination" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "approvedByAdminId" TEXT,
    "txHash" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" DATETIME,
    CONSTRAINT "withdrawals_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_withdrawals" ("amount", "approvedByAdminId", "createdAt", "currency", "destination", "id", "processedAt", "status", "txHash", "userId") SELECT "amount", "approvedByAdminId", "createdAt", "currency", "destination", "id", "processedAt", "status", "txHash", "userId" FROM "withdrawals";
DROP TABLE "withdrawals";
ALTER TABLE "new_withdrawals" RENAME TO "withdrawals";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
