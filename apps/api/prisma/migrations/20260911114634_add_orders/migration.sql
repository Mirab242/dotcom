-- CreateTable
CREATE TABLE "orders" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "qty" DECIMAL NOT NULL,
    "price" DECIMAL,
    "mode" TEXT NOT NULL DEFAULT 'manual',
    "exchangeOrderId" TEXT,
    "exchangeStatus" TEXT,
    "filledQty" DECIMAL,
    "avgPrice" DECIMAL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "errorMessage" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "orders_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
