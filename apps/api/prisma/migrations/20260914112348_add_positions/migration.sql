-- CreateTable
CREATE TABLE "positions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "side" TEXT NOT NULL DEFAULT 'long',
    "qty" DECIMAL NOT NULL,
    "entryPrice" DECIMAL NOT NULL,
    "stopLoss" DECIMAL NOT NULL,
    "takeProfit" DECIMAL,
    "entryOrderId" TEXT NOT NULL,
    "exitOrderId" TEXT,
    "exitPrice" DECIMAL,
    "realizedPnl" DECIMAL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "exitReason" TEXT,
    "openedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" DATETIME,
    CONSTRAINT "positions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
