// Backfill ponctuel : crédite le solde de départ testnet aux comptes créés avant
// l'introduction du WalletService (11/09/2026). Pas destiné à être relancé en prod.
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const users = await prisma.user.findMany();
  for (const user of users) {
    const existing = await prisma.wallet.findUnique({
      where: { userId_currency: { userId: user.id, currency: 'USDT' } },
    });
    if (existing) {
      console.log(`skip ${user.email} — wallet USDT déjà présent (${existing.availableBalance})`);
      continue;
    }
    const wallet = await prisma.wallet.create({
      data: { userId: user.id, currency: 'USDT', availableBalance: 1000 },
    });
    await prisma.ledgerEntry.create({
      data: { walletId: wallet.id, type: 'adjustment', amount: 1000, refId: user.id, refTable: 'adjustment' },
    });
    console.log(`seeded ${user.email} -> 1000 USDT`);
  }
  await prisma.$disconnect();
}
main();
