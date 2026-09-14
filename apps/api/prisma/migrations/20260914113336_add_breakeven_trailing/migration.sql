/*
  Warnings:

  - Added the required column `initialStopLoss` to the `positions` table without a default value. This is not possible if the table is not empty.

*/
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_positions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "side" TEXT NOT NULL DEFAULT 'long',
    "qty" DECIMAL NOT NULL,
    "entryPrice" DECIMAL NOT NULL,
    "stopLoss" DECIMAL NOT NULL,
    "initialStopLoss" DECIMAL NOT NULL,
    "takeProfit" DECIMAL,
    "breakEvenActivated" BOOLEAN NOT NULL DEFAULT false,
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
INSERT INTO "new_positions" ("closedAt", "entryOrderId", "entryPrice", "exitOrderId", "exitPrice", "exitReason", "id", "openedAt", "qty", "realizedPnl", "side", "status", "stopLoss", "initialStopLoss", "symbol", "takeProfit", "userId") SELECT "closedAt", "entryOrderId", "entryPrice", "exitOrderId", "exitPrice", "exitReason", "id", "openedAt", "qty", "realizedPnl", "side", "status", "stopLoss", "stopLoss", "symbol", "takeProfit", "userId" FROM "positions";
DROP TABLE "positions";
ALTER TABLE "new_positions" RENAME TO "positions";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
