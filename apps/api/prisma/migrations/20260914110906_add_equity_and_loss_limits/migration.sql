-- AlterTable
ALTER TABLE "orders" ADD COLUMN "equityAfter" DECIMAL;

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_system_settings" (
    "id" TEXT NOT NULL PRIMARY KEY DEFAULT 'global',
    "killSwitchEnabled" BOOLEAN NOT NULL DEFAULT false,
    "killSwitchReason" TEXT,
    "maxDailyLossPercent" DECIMAL NOT NULL DEFAULT 5,
    "maxDrawdownPercent" DECIMAL NOT NULL DEFAULT 20,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_system_settings" ("id", "killSwitchEnabled", "killSwitchReason", "updatedAt") SELECT "id", "killSwitchEnabled", "killSwitchReason", "updatedAt" FROM "system_settings";
DROP TABLE "system_settings";
ALTER TABLE "new_system_settings" RENAME TO "system_settings";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
