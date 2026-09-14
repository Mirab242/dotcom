-- CreateTable
CREATE TABLE "bot_instances" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "symbol" TEXT NOT NULL DEFAULT 'DOT/USDT',
    "timeframe" TEXT NOT NULL DEFAULT '15m',
    "higherTimeframe" TEXT NOT NULL DEFAULT '4h',
    "minConfidence" INTEGER NOT NULL DEFAULT 70,
    "riskPercent" DECIMAL NOT NULL DEFAULT 1,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "lastRunAt" DATETIME,
    "lastSignalAt" DATETIME,
    "lastSignalSide" TEXT,
    "lastError" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "bot_instances_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "bot_instances_userId_symbol_key" ON "bot_instances"("userId", "symbol");
