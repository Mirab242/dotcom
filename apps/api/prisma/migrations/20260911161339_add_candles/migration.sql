-- CreateTable
CREATE TABLE "candles" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "symbol" TEXT NOT NULL,
    "timeframe" TEXT NOT NULL,
    "ts" INTEGER NOT NULL,
    "open" DECIMAL NOT NULL,
    "high" DECIMAL NOT NULL,
    "low" DECIMAL NOT NULL,
    "close" DECIMAL NOT NULL,
    "volume" DECIMAL NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "candles_symbol_timeframe_ts_key" ON "candles"("symbol", "timeframe", "ts");
