/**
 * Test d'intégration du module Challenge — s'exécute sur une VRAIE base Postgres (les verrous
 * FOR UPDATE, les transactions et les contraintes ne se simulent pas). Désactivé par défaut pour ne
 * jamais toucher une base par accident : il faut fournir TEST_DATABASE_URL, pointant vers une base
 * JETABLE dont le schéma est déjà migré (`prisma migrate deploy`).
 *
 *   TEST_DATABASE_URL=postgresql://user:pw@localhost:5432/test npm test --workspace=apps/api
 *
 * Les prix sont simulés (aucun appel à Binance) pour rendre chaque scénario déterministe.
 */
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';

// ExchangeService charge ccxt (modules ESM que Jest ne sait pas transformer). Les prix sont simulés
// ici de toute façon : on remplace le module par une coquille vide (hissé avant les imports par Jest).
jest.mock('../exchange/exchange.service', () => ({ ExchangeService: class {} }));

import { PrismaService } from '../prisma/prisma.service';
import { WalletService } from '../wallet/wallet.service';
import { ChallengeService } from './challenge.service';
import { PAYMENTS_CONFIRM_PHRASE } from './dto/set-payments-enabled.dto';

const DB_URL = process.env.TEST_DATABASE_URL;
const describeDb = DB_URL ? describe : describe.skip;

describeDb('ChallengeService (base réelle)', () => {
  let prisma: PrismaService;
  let wallet: WalletService;
  let service: ChallengeService;
  let seq = 0;
  const prices: Record<string, number> = {};

  const exchange = {
    getConnector: () => ({ getCandles: async (symbol: string) => [{ close: prices[symbol] }] }),
  };

  /** Change le prix simulé ET vide le cache de 5 s du service, pour que le changement soit vu tout de suite. */
  function setPrice(symbol: string, price: number) {
    prices[symbol] = price;
    (service as any).priceCache.clear();
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = DB_URL;
    prisma = new PrismaService();
    await prisma.$connect();
    wallet = new WalletService(prisma);
    service = new ChallengeService(prisma, exchange as any, wallet);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    setPrice('DOT/USDT', 5);
    await prisma.systemSetting.upsert({
      where: { id: 'global' },
      update: { killSwitchEnabled: false, killSwitchReason: null, challengePaymentsEnabled: false },
      create: { id: 'global' },
    });
  });

  async function makeUser(opts: { kyc?: string; role?: string; usdt?: number } = {}) {
    seq += 1;
    const user = await prisma.user.create({
      data: {
        email: `t${seq}-${Date.now()}@test.io`,
        passwordHash: 'x',
        role: opts.role ?? 'user',
        referralCode: `T${seq}${Date.now()}`,
        kycStatus: opts.kyc ?? 'none',
      },
    });
    if (opts.usdt) await wallet.credit(user.id, 'USDT', opts.usdt, 'adjustment', user.id);
    return user;
  }

  async function makePlan(over: Record<string, unknown> = {}) {
    return prisma.challengePlan.create({
      data: {
        name: 'Test',
        accountSize: 10000,
        feeAmount: 100,
        minTradingDays: 1,
        phase1MaxDays: null,
        phase2MaxDays: null,
        ...over,
      },
    });
  }

  async function setPayments(enabled: boolean) {
    await prisma.systemSetting.update({ where: { id: 'global' }, data: { challengePaymentsEnabled: enabled } });
  }

  async function newAccount(userId: string, planOver: Record<string, unknown> = {}) {
    const plan = await makePlan(planOver);
    return service.createAccount(userId, { planId: plan.id });
  }

  /** Achète 1000 DOT à 5, le prix monte à `exitPrice`, la position est fermée à la main. */
  async function winTrade(userId: string, accountId: string, exitPrice: number) {
    setPrice('DOT/USDT', 5);
    const pos = await service.openPosition(userId, accountId, { symbol: 'DOT/USDT', qty: 1000, stopLoss: 4.9 });
    setPrice('DOT/USDT', exitPrice);
    return service.closePosition(userId, accountId, pos.id);
  }

  const dbAccount = (id: string) => prisma.challengeAccount.findUniqueOrThrow({ where: { id } });

  // ------------------------------------------------------------------------------------------

  describe('création de compte et argent réel', () => {
    it('crée un compte de DÉMO gratuit quand l\'interrupteur argent réel est éteint', async () => {
      const user = await makeUser({ usdt: 500 });
      const acc = await newAccount(user.id);
      expect(acc.isDemo).toBe(true);
      expect(acc.feePaid).toBe(0);
      expect(acc.balance).toBe(10000);
      expect(acc.phase).toBe('phase1');
      expect(await wallet.getBalance(user.id, 'USDT')).toBe(500); // wallet intact
    });

    it('débite les frais du wallet quand l\'argent réel est activé', async () => {
      await setPayments(true);
      const user = await makeUser({ usdt: 500 });
      const acc = await newAccount(user.id);
      expect(acc.isDemo).toBe(false);
      expect(acc.feePaid).toBe(100);
      expect(await wallet.getBalance(user.id, 'USDT')).toBe(400);
      const entry = await prisma.ledgerEntry.findFirst({ where: { type: 'challenge_fee', refId: acc.id } });
      expect(Number(entry!.amount)).toBe(-100);
    });

    it('ne crée AUCUN compte si le solde wallet est insuffisant (atomicité)', async () => {
      await setPayments(true);
      const user = await makeUser({ usdt: 50 });
      const plan = await makePlan();
      await expect(service.createAccount(user.id, { planId: plan.id })).rejects.toThrow(BadRequestException);
      expect(await prisma.challengeAccount.count({ where: { userId: user.id } })).toBe(0);
      expect(await wallet.getBalance(user.id, 'USDT')).toBe(50);
    });

    it('fige les règles à l\'achat : modifier le plan ensuite ne change pas un compte existant', async () => {
      const user = await makeUser();
      const plan = await makePlan({ phase1TargetPct: 8 });
      const acc = await service.createAccount(user.id, { planId: plan.id });
      await prisma.challengePlan.update({ where: { id: plan.id }, data: { phase1TargetPct: 50 } });
      const fresh = await service.getAccount(user.id, acc.id);
      expect(fresh.rules.profitTargetPct).toBe(8);
    });
  });

  describe('interrupteur argent réel', () => {
    it('exige la phrase de confirmation pour ACTIVER, pas pour désactiver', async () => {
      const admin = await makeUser({ role: 'admin' });
      await expect(service.setPaymentsEnabled(admin.id, { enabled: true })).rejects.toThrow(BadRequestException);
      await expect(service.setPaymentsEnabled(admin.id, { enabled: true, confirm: 'oui' })).rejects.toThrow(BadRequestException);
      expect((await service.getPaymentsStatus()).paymentsEnabled).toBe(false);

      await service.setPaymentsEnabled(admin.id, { enabled: true, confirm: PAYMENTS_CONFIRM_PHRASE });
      expect((await service.getPaymentsStatus()).paymentsEnabled).toBe(true);

      await service.setPaymentsEnabled(admin.id, { enabled: false });
      expect((await service.getPaymentsStatus()).paymentsEnabled).toBe(false);

      const logs = await prisma.auditLog.findMany({ where: { actorId: admin.id, action: { startsWith: 'challenge.payments' } } });
      expect(logs.map((l) => l.action).sort()).toEqual(['challenge.payments.disabled', 'challenge.payments.enabled']);
    });
  });

  describe('ordres simulés', () => {
    it('refuse un ordre sans stop-loss valide et un achat supérieur au cash', async () => {
      const user = await makeUser();
      const acc = await newAccount(user.id);
      await expect(
        service.openPosition(user.id, acc.id, { symbol: 'DOT/USDT', qty: 100, stopLoss: 5.5 }),
      ).rejects.toThrow(/sous le prix d'entrée/);
      await expect(
        service.openPosition(user.id, acc.id, { symbol: 'DOT/USDT', qty: 5000, stopLoss: 4.99 }),
      ).rejects.toThrow(/Liquidités insuffisantes/);
    });

    it('CONCURRENCE : deux ordres parallèles qui dépassent le cash ensemble — un seul passe', async () => {
      const user = await makeUser();
      const acc = await newAccount(user.id);
      // 1500 × 5 = 7500 : chacun passe seul (cash 10000), pas les deux (15000).
      const order = () => service.openPosition(user.id, acc.id, { symbol: 'DOT/USDT', qty: 1500, stopLoss: 4.95 });
      const results = await Promise.allSettled([order(), order()]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(await prisma.challengePosition.count({ where: { accountId: acc.id, status: 'open' } })).toBe(1);
    });

    it('un compte ne peut pas être manipulé par un autre utilisateur (404)', async () => {
      const owner = await makeUser();
      const intruder = await makeUser();
      const acc = await newAccount(owner.id);
      await expect(service.getAccount(intruder.id, acc.id)).rejects.toThrow(NotFoundException);
      await expect(
        service.openPosition(intruder.id, acc.id, { symbol: 'DOT/USDT', qty: 10, stopLoss: 4.9 }),
      ).rejects.toThrow(NotFoundException);
    });

    it('le kill switch global bloque l\'ouverture de nouvelles positions', async () => {
      const user = await makeUser();
      const acc = await newAccount(user.id);
      await prisma.systemSetting.update({ where: { id: 'global' }, data: { killSwitchEnabled: true, killSwitchReason: 'test' } });
      await expect(
        service.openPosition(user.id, acc.id, { symbol: 'DOT/USDT', qty: 10, stopLoss: 4.9 }),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('surveillance (stop-loss, jour, échec)', () => {
    it('ferme une position au stop-loss sans faire échouer le compte', async () => {
      const user = await makeUser();
      const acc = await newAccount(user.id);
      const pos = await service.openPosition(user.id, acc.id, { symbol: 'DOT/USDT', qty: 1000, stopLoss: 4.9 });
      setPrice('DOT/USDT', 4.85);
      await service.monitorAccounts();

      const closed = await prisma.challengePosition.findUniqueOrThrow({ where: { id: pos.id } });
      expect(closed.status).toBe('closed');
      expect(closed.exitReason).toBe('sl');
      const a = await dbAccount(acc.id);
      expect(a.status).toBe('active');
      expect(Number(a.balance)).toBeLessThan(9850); // -150 de perte + frais
      expect(Number(a.balance)).toBeGreaterThan(9800);
    });

    it('un gap au-delà du stop se règle au prix du marché et fait échouer le compte (perte journalière)', async () => {
      const user = await makeUser();
      const acc = await newAccount(user.id);
      await service.openPosition(user.id, acc.id, { symbol: 'DOT/USDT', qty: 1900, stopLoss: 4.9 });
      setPrice('DOT/USDT', 3); // gap : -38 % sur le capital
      await service.monitorAccounts();

      const a = await dbAccount(acc.id);
      expect(a.status).toBe('failed');
      expect(a.failReason).toBe('max_daily_loss');
      expect(a.endedAt).not.toBeNull();
      expect(await prisma.challengePosition.count({ where: { accountId: acc.id, status: 'open' } })).toBe(0);
    });

    it('à minuit UTC, le repère de perte journalière est remis à l\'équité actuelle (pas de faux échec)', async () => {
      const user = await makeUser();
      const acc = await newAccount(user.id);
      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
      // Sans rollover, 12000 → 10000 serait une "perte du jour" de 16,7 % et ferait échouer le compte.
      await prisma.challengeAccount.update({ where: { id: acc.id }, data: { dayStartDate: yesterday, dayStartEquity: 12000 } });
      await service.monitorAccounts();

      const a = await dbAccount(acc.id);
      expect(a.status).toBe('active');
      expect(Number(a.dayStartEquity)).toBe(10000);
    });

    it('échoue sur la limite de temps si l\'objectif n\'est pas atteint', async () => {
      const user = await makeUser();
      const acc = await newAccount(user.id, { phase1MaxDays: 5 });
      await prisma.challengeAccount.update({
        where: { id: acc.id },
        data: { phaseStartedAt: new Date(Date.now() - 6 * 24 * 60 * 60 * 1000) },
      });
      await service.monitorAccounts();
      const a = await dbAccount(acc.id);
      expect(a.status).toBe('failed');
      expect(a.failReason).toBe('time_limit');
    });
  });

  describe('progression des phases', () => {
    it('phase1 → phase2 → financé, le compte repartant de sa taille initiale à chaque phase', async () => {
      const user = await makeUser();
      const acc = await newAccount(user.id);

      await winTrade(user.id, acc.id, 5.9); // ≈ +889 → objectif 8 % (800) atteint
      let a = await dbAccount(acc.id);
      expect(a.phase).toBe('phase2');
      expect(Number(a.balance)).toBe(10000); // remis à la taille initiale
      expect(a.phase1PassedAt).not.toBeNull();

      await winTrade(user.id, acc.id, 5.6); // ≈ +589 → objectif 5 % (500) atteint
      a = await dbAccount(acc.id);
      expect(a.phase).toBe('funded');
      expect(a.fundedAt).not.toBeNull();
      expect(a.status).toBe('active');
    });

    it('n\'valide pas la phase avant le nombre minimal de jours de trading', async () => {
      const user = await makeUser();
      const acc = await newAccount(user.id, { minTradingDays: 3 });
      await winTrade(user.id, acc.id, 5.9); // objectif de profit atteint, mais 1 seul jour de trading sur 3
      const a = await dbAccount(acc.id);
      expect(a.phase).toBe('phase1');
      expect(a.status).toBe('active');
    });
  });

  describe('retraits (compte financé)', () => {
    /** Amène un compte au statut "financé" avec un profit réalisé, cooldown de 14 jours écoulé. */
    async function fundedAccountWithProfit(userId: string) {
      const acc = await newAccount(userId);
      await winTrade(userId, acc.id, 5.9);
      await winTrade(userId, acc.id, 5.6);
      await winTrade(userId, acc.id, 5.9); // profit réalisé sur le compte financé (≈ +889)
      await prisma.challengeAccount.update({
        where: { id: acc.id },
        data: { fundedAt: new Date(Date.now() - 20 * 24 * 60 * 60 * 1000) },
      });
      return acc;
    }

    it('refuse un retrait sur un compte de démo, ou tant que l\'argent réel est éteint', async () => {
      const user = await makeUser({ kyc: 'verified' });
      const acc = await fundedAccountWithProfit(user.id); // créé en démo (argent réel éteint)
      await expect(service.requestPayout(user.id, acc.id, { amount: 100 })).rejects.toThrow(/démo/);
    });

    it('refuse un retrait sans KYC vérifié', async () => {
      await setPayments(true);
      const user = await makeUser({ kyc: 'none', usdt: 1000 });
      const acc = await fundedAccountWithProfit(user.id);
      await expect(service.requestPayout(user.id, acc.id, { amount: 100 })).rejects.toThrow(/KYC/);
    });

    it('cycle complet : demande → réservation du profit → approbation → wallet crédité, sans double paiement', async () => {
      await setPayments(true);
      const user = await makeUser({ kyc: 'verified', usdt: 1000 });
      const admin = await makeUser({ role: 'admin' });
      const acc = await fundedAccountWithProfit(user.id);

      const before = Number((await dbAccount(acc.id)).balance);
      const walletBefore = await wallet.getBalance(user.id, 'USDT');

      const payout = await service.requestPayout(user.id, acc.id, { amount: 400 });
      expect(payout.status).toBe('pending');
      expect(payout.grossAmount).toBeCloseTo(500, 6); // 400 / 80 %

      // Le profit brut est réservé (retiré du solde simulé) et le repère du jour baisse d'autant.
      const reserved = await dbAccount(acc.id);
      expect(Number(reserved.balance)).toBeCloseTo(before - 500, 6);
      // Sans l'ajustement de dayStartEquity, la sortie du profit serait vue comme une perte du jour.
      await service.monitorAccounts();
      expect((await dbAccount(acc.id)).status).toBe('active');

      // Une seule demande en cours à la fois.
      await expect(service.requestPayout(user.id, acc.id, { amount: 50 })).rejects.toThrow(/déjà en cours/);

      await service.approvePayout(admin.id, payout.id);
      expect(await wallet.getBalance(user.id, 'USDT')).toBeCloseTo(walletBefore + 400, 6);
      const entry = await prisma.ledgerEntry.findFirst({ where: { type: 'challenge_payout', refId: payout.id } });
      expect(Number(entry!.amount)).toBe(400);

      // Double clic admin : refusé, wallet crédité une seule fois.
      await expect(service.approvePayout(admin.id, payout.id)).rejects.toThrow(/déjà traité/);
      expect(await wallet.getBalance(user.id, 'USDT')).toBeCloseTo(walletBefore + 400, 6);

      // Cooldown de 14 jours avant le retrait suivant.
      await expect(service.requestPayout(user.id, acc.id, { amount: 50 })).rejects.toThrow(/Prochain retrait/);
    });

    it('un retrait rejeté rend le profit réservé au compte', async () => {
      await setPayments(true);
      const user = await makeUser({ kyc: 'verified', usdt: 1000 });
      const admin = await makeUser({ role: 'admin' });
      const acc = await fundedAccountWithProfit(user.id);
      const before = Number((await dbAccount(acc.id)).balance);

      const payout = await service.requestPayout(user.id, acc.id, { amount: 300 });
      await service.rejectPayout(admin.id, payout.id, 'vérification en cours');

      const after = await dbAccount(acc.id);
      expect(Number(after.balance)).toBeCloseTo(before, 6);
      expect(Number(after.totalPaidOut)).toBeCloseTo(0, 6);
      await expect(service.approvePayout(admin.id, payout.id)).rejects.toThrow(/déjà traité/);
    });

    it('refuse un montant supérieur à la part disponible', async () => {
      await setPayments(true);
      const user = await makeUser({ kyc: 'verified', usdt: 1000 });
      const acc = await fundedAccountWithProfit(user.id);
      await expect(service.requestPayout(user.id, acc.id, { amount: 5000 })).rejects.toThrow(/supérieur à votre part/);
    });

    it('l\'approbation est impossible si l\'argent réel a été coupé entre-temps', async () => {
      await setPayments(true);
      const user = await makeUser({ kyc: 'verified', usdt: 1000 });
      const admin = await makeUser({ role: 'admin' });
      const acc = await fundedAccountWithProfit(user.id);
      const payout = await service.requestPayout(user.id, acc.id, { amount: 200 });
      await setPayments(false);
      await expect(service.approvePayout(admin.id, payout.id)).rejects.toThrow(ForbiddenException);
    });
  });

  describe('admin', () => {
    it('clôture forcée : positions soldées, compte marqué failed/admin, action tracée', async () => {
      const user = await makeUser();
      const admin = await makeUser({ role: 'admin' });
      const acc = await newAccount(user.id);
      await service.openPosition(user.id, acc.id, { symbol: 'DOT/USDT', qty: 500, stopLoss: 4.9 });

      await service.closeAccountAdmin(admin.id, acc.id, 'violation des règles');
      const a = await dbAccount(acc.id);
      expect(a.status).toBe('failed');
      expect(a.failReason).toBe('admin');
      expect(await prisma.challengePosition.count({ where: { accountId: acc.id, status: 'open' } })).toBe(0);
      await expect(service.closeAccountAdmin(admin.id, acc.id, 'encore')).rejects.toThrow(/déjà terminé/);
      const log = await prisma.auditLog.findFirst({ where: { action: 'challenge.account.closed_by_admin', target: acc.id } });
      expect(log).not.toBeNull();
    });

    it('un plan modifié à null retire la limite de durée', async () => {
      const admin = await makeUser({ role: 'admin' });
      const plan = await makePlan({ phase1MaxDays: 30 });
      const updated = await service.updatePlan(admin.id, plan.id, { phase1MaxDays: null });
      expect(updated.phase1MaxDays).toBeNull();
    });
  });
});
