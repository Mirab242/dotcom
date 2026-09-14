-- AlterTable
ALTER TABLE "orders" ADD COLUMN "riskPercent" DECIMAL;
ALTER TABLE "orders" ADD COLUMN "stopLoss" DECIMAL;
ALTER TABLE "orders" ADD COLUMN "takeProfit" DECIMAL;

-- CreateTable
CREATE TABLE "system_settings" (
    "id" TEXT NOT NULL PRIMARY KEY DEFAULT 'global',
    "killSwitchEnabled" BOOLEAN NOT NULL DEFAULT false,
    "killSwitchReason" TEXT,
    "updatedAt" DATETIME NOT NULL
);
