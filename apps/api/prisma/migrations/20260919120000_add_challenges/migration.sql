-- AlterTable
ALTER TABLE "system_settings" ADD COLUMN     "challengePaymentsEnabled" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "challenge_plans" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "accountSize" DECIMAL(65,30) NOT NULL,
    "feeAmount" DECIMAL(65,30) NOT NULL,
    "phase1TargetPct" DECIMAL(65,30) NOT NULL DEFAULT 8,
    "phase2TargetPct" DECIMAL(65,30) NOT NULL DEFAULT 5,
    "maxDailyLossPct" DECIMAL(65,30) NOT NULL DEFAULT 5,
    "maxTotalDrawdownPct" DECIMAL(65,30) NOT NULL DEFAULT 10,
    "minTradingDays" INTEGER NOT NULL DEFAULT 4,
    "phase1MaxDays" INTEGER,
    "phase2MaxDays" INTEGER,
    "profitSplitPct" DECIMAL(65,30) NOT NULL DEFAULT 80,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "challenge_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "challenge_accounts" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "planName" TEXT NOT NULL,
    "isDemo" BOOLEAN NOT NULL DEFAULT false,
    "accountSize" DECIMAL(65,30) NOT NULL,
    "feePaid" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "phase1TargetPct" DECIMAL(65,30) NOT NULL,
    "phase2TargetPct" DECIMAL(65,30) NOT NULL,
    "maxDailyLossPct" DECIMAL(65,30) NOT NULL,
    "maxTotalDrawdownPct" DECIMAL(65,30) NOT NULL,
    "minTradingDays" INTEGER NOT NULL,
    "phase1MaxDays" INTEGER,
    "phase2MaxDays" INTEGER,
    "profitSplitPct" DECIMAL(65,30) NOT NULL,
    "phase" TEXT NOT NULL DEFAULT 'phase1',
    "status" TEXT NOT NULL DEFAULT 'active',
    "failReason" TEXT,
    "balance" DECIMAL(65,30) NOT NULL,
    "dayStartEquity" DECIMAL(65,30) NOT NULL,
    "dayStartDate" TIMESTAMP(3) NOT NULL,
    "phaseStartedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "phase1PassedAt" TIMESTAMP(3),
    "phase2PassedAt" TIMESTAMP(3),
    "fundedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "totalPaidOut" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "challenge_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "challenge_positions" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "qty" DECIMAL(65,30) NOT NULL,
    "entryPrice" DECIMAL(65,30) NOT NULL,
    "stopLoss" DECIMAL(65,30) NOT NULL,
    "takeProfit" DECIMAL(65,30),
    "phase" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "exitPrice" DECIMAL(65,30),
    "realizedPnl" DECIMAL(65,30),
    "exitReason" TEXT,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),

    CONSTRAINT "challenge_positions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "challenge_payouts" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "traderAmount" DECIMAL(65,30) NOT NULL,
    "grossAmount" DECIMAL(65,30) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "rejectionReason" TEXT,
    "reviewedByAdminId" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "challenge_payouts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "challenge_accounts_userId_status_idx" ON "challenge_accounts"("userId", "status");

-- CreateIndex
CREATE INDEX "challenge_positions_accountId_status_idx" ON "challenge_positions"("accountId", "status");

-- CreateIndex
CREATE INDEX "challenge_payouts_userId_status_idx" ON "challenge_payouts"("userId", "status");

-- AddForeignKey
ALTER TABLE "challenge_accounts" ADD CONSTRAINT "challenge_accounts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "challenge_accounts" ADD CONSTRAINT "challenge_accounts_planId_fkey" FOREIGN KEY ("planId") REFERENCES "challenge_plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "challenge_positions" ADD CONSTRAINT "challenge_positions_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "challenge_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "challenge_payouts" ADD CONSTRAINT "challenge_payouts_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "challenge_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "challenge_payouts" ADD CONSTRAINT "challenge_payouts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
