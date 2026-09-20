import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { randomUUID } from 'crypto';
import { ChallengeAccount, ChallengePosition, Prisma } from '@prisma/client';
import {
  ChallengePhase,
  ChallengeRules,
  computeClosedPnl,
  computeMetrics,
  computePayoutCapacity,
  computeUnrealizedPnl,
  evaluateChallenge,
  grossForTraderAmount,
  nextPhase,
  startOfUtcDay,
  validateChallengeOrder,
} from '@dot-trader/risk-engine';
import { PrismaService } from '../prisma/prisma.service';
import { ExchangeService } from '../exchange/exchange.service';
import { WalletService } from '../wallet/wallet.service';
import { CreateChallengeAccountDto } from './dto/create-challenge-account.dto';
import { PlaceChallengeOrderDto } from './dto/place-challenge-order.dto';
import { RequestChallengePayoutDto } from './dto/request-challenge-payout.dto';
import { CreateChallengePlanDto, UpdateChallengePlanDto } from './dto/upsert-challenge-plan.dto';
import { PAYMENTS_CONFIRM_PHRASE, SetPaymentsEnabledDto } from './dto/set-payments-enabled.dto';

type Tx = Prisma.TransactionClient;

const SETTINGS_ID = 'global';
const MAX_ACTIVE_ACCOUNTS_PER_USER = 5;
const MAX_OPEN_POSITIONS_PER_ACCOUNT = 10;
const MIN_PAYOUT_USDT = 50;
const PAYOUT_COOLDOWN_DAYS = 14;
const PRICE_TTL_MS = 5_000;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

const num = (v: unknown): number => Number(v);
const round2 = (v: number): number => Math.round(v * 100) / 100;

// Plans proposés par défaut tant que l'admin n'en a créé aucun — les valeurs sont un point de
// départ, entièrement modifiables depuis l'admin. Sans effet financier tant que l'interrupteur
// "argent réel" est désactivé (les comptes sont alors des démos gratuites).
const DEFAULT_PLANS = [
  { name: 'Starter', accountSize: 5000, feeAmount: 49 },
  { name: 'Standard', accountSize: 10000, feeAmount: 89 },
  { name: 'Pro', accountSize: 25000, feeAmount: 199 },
  { name: 'Elite', accountSize: 50000, feeAmount: 349 },
];

/**
 * Challenges "prop firm" : comptes de trading SIMULÉS — aucun ordre n'est envoyé à l'exchange et
 * aucun fonds de tiers n'est détenu pour trader (§4.6bis). Les prix viennent du marché réel
 * (mêmes bougies que le reste de la plateforme), l'exécution est fictive.
 *
 * L'argent réel n'intervient qu'à deux endroits, tous deux derrière l'interrupteur
 * `challengePaymentsEnabled` (désactivé par défaut, §8.3) : les frais d'inscription (débités du
 * wallet USDT) et les retraits de gains (crédités sur le wallet USDT après validation admin).
 *
 * Concurrence : toute opération qui modifie l'état d'un compte passe par `withAccountLock`
 * (SELECT ... FOR UPDATE sur la ligne du compte). Sans ça, le job de surveillance et une action
 * utilisateur pourraient lire le même solde en parallèle et l'écraser mutuellement.
 */
@Injectable()
export class ChallengeService implements OnModuleInit {
  private readonly logger = new Logger(ChallengeService.name);
  private priceCache = new Map<string, { price: number; at: number }>();
  private monitoring = false;

  constructor(
    private prisma: PrismaService,
    private exchangeService: ExchangeService,
    private walletService: WalletService,
  ) {}

  async onModuleInit() {
    try {
      if ((await this.prisma.challengePlan.count()) === 0) {
        await this.prisma.challengePlan.createMany({
          data: DEFAULT_PLANS.map((p) => ({ ...p, phase1MaxDays: 30, phase2MaxDays: 60 })),
        });
        this.logger.log('Plans de challenge par défaut créés (Starter, Standard, Pro, Elite).');
      }
    } catch (err) {
      // Table absente tant que la migration n'a pas été appliquée : ne doit pas empêcher l'API de démarrer.
      this.logger.warn(`Plans par défaut non créés : ${err instanceof Error ? err.message : err}`);
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Utilitaires
  // ---------------------------------------------------------------------------------------------

  private async paymentsEnabled(): Promise<boolean> {
    const settings = await this.prisma.systemSetting.findUnique({ where: { id: SETTINGS_ID } });
    return settings?.challengePaymentsEnabled === true;
  }

  /** Dernier prix connu (bougie 1m), avec un cache de quelques secondes pour ne pas marteler l'exchange. */
  private async getPrice(symbol: string): Promise<number> {
    const hit = this.priceCache.get(symbol);
    if (hit && Date.now() - hit.at < PRICE_TTL_MS) return hit.price;
    const [candle] = await this.exchangeService.getConnector().getCandles(symbol, '1m', 1);
    const price = candle?.close;
    if (!price || !isFinite(price) || price <= 0) {
      throw new ServiceUnavailableException(`Prix indisponible pour ${symbol}`);
    }
    this.priceCache.set(symbol, { price, at: Date.now() });
    return price;
  }

  private async withAccountLock<T>(accountId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(
      async (tx) => {
        const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM challenge_accounts WHERE id = ${accountId} FOR UPDATE`;
        if (rows.length === 0) throw new NotFoundException('Compte de challenge introuvable');
        return fn(tx);
      },
      { timeout: 20_000 },
    );
  }

  private async audit(tx: Tx, actorId: string | null, action: string, target: string, metadata: unknown) {
    await tx.auditLog.create({ data: { actorId, action, target, metadata: JSON.stringify(metadata) } });
  }

  private rulesOf(a: ChallengeAccount): ChallengeRules {
    const phase = a.phase as ChallengePhase;
    return {
      accountSize: num(a.accountSize),
      profitTargetPct: phase === 'phase1' ? num(a.phase1TargetPct) : phase === 'phase2' ? num(a.phase2TargetPct) : 0,
      maxDailyLossPct: num(a.maxDailyLossPct),
      maxTotalDrawdownPct: num(a.maxTotalDrawdownPct),
      minTradingDays: a.minTradingDays,
      maxDays: phase === 'phase1' ? a.phase1MaxDays : phase === 'phase2' ? a.phase2MaxDays : null,
    };
  }

  /** Jours UTC distincts où au moins une position a été ouverte dans la phase courante. */
  private async countTradingDays(db: Pick<Tx, 'challengePosition'>, a: ChallengeAccount): Promise<number> {
    const rows = await db.challengePosition.findMany({
      where: { accountId: a.id, phase: a.phase, openedAt: { gte: a.phaseStartedAt } },
      select: { openedAt: true },
    });
    return new Set(rows.map((r) => r.openedAt.toISOString().slice(0, 10))).size;
  }

  private async loadOwned(tx: Pick<Tx, 'challengeAccount'>, userId: string, accountId: string): Promise<ChallengeAccount> {
    const account = await tx.challengeAccount.findUnique({ where: { id: accountId } });
    // 404 (pas 403) : ne pas révéler l'existence d'un compte appartenant à quelqu'un d'autre.
    if (!account || account.userId !== userId) throw new NotFoundException('Compte de challenge introuvable');
    return account;
  }

  /** Ferme une position au prix donné et retourne son résultat net (frais inclus). */
  private async closeRow(tx: Tx, p: ChallengePosition, price: number, reason: string, now: Date): Promise<number> {
    const pnl = computeClosedPnl(num(p.entryPrice), price, num(p.qty));
    await tx.challengePosition.update({
      where: { id: p.id },
      data: { status: 'closed', exitPrice: price, realizedPnl: pnl, exitReason: reason, closedAt: now },
    });
    return pnl;
  }

  // ---------------------------------------------------------------------------------------------
  // Cœur du moteur — à appeler UNIQUEMENT dans withAccountLock
  // ---------------------------------------------------------------------------------------------

  /**
   * Met un compte à jour au dernier prix : ferme les positions dont le SL/TP est touché, bascule
   * le repère de perte journalière à minuit UTC, puis applique le verdict des règles (échec ou
   * passage de phase). Idempotent : peut être appelé autant de fois que nécessaire.
   */
  private async settle(tx: Tx, accountId: string, now = new Date()): Promise<ChallengeAccount> {
    let account = await tx.challengeAccount.findUniqueOrThrow({ where: { id: accountId } });
    if (account.status !== 'active') return account;

    const open = await tx.challengePosition.findMany({ where: { accountId, status: 'open' } });
    const prices = new Map<string, number>();
    for (const symbol of new Set(open.map((p) => p.symbol))) prices.set(symbol, await this.getPrice(symbol));

    let balance = num(account.balance);
    const stillOpen: ChallengePosition[] = [];
    for (const p of open) {
      const price = prices.get(p.symbol)!;
      const hitSl = price <= num(p.stopLoss);
      const hitTp = p.takeProfit != null && price >= num(p.takeProfit);
      if (hitSl || hitTp) balance += await this.closeRow(tx, p, price, hitSl ? 'sl' : 'tp', now);
      else stillOpen.push(p);
    }

    const unrealized = stillOpen.reduce(
      (sum, p) => sum + computeUnrealizedPnl(num(p.entryPrice), prices.get(p.symbol)!, num(p.qty)),
      0,
    );
    const equity = balance + unrealized;

    // Nouveau jour UTC : la perte journalière repart de l'équité actuelle.
    const today = startOfUtcDay(now);
    let dayStartEquity = num(account.dayStartEquity);
    let dayStartDate = account.dayStartDate;
    if (dayStartDate < today) {
      dayStartEquity = equity;
      dayStartDate = today;
    }

    const verdict = evaluateChallenge(this.rulesOf(account), {
      phase: account.phase as ChallengePhase,
      balance,
      equity,
      dayStartEquity,
      tradingDays: await this.countTradingDays(tx, account),
      openPositions: stillOpen.length,
      phaseStartedAt: account.phaseStartedAt,
      now,
    });

    const data: Prisma.ChallengeAccountUpdateInput = { balance, dayStartEquity, dayStartDate };

    if (verdict.status === 'failed') {
      // Compte perdu : tout ce qui reste ouvert est soldé au marché.
      for (const p of stillOpen) balance += await this.closeRow(tx, p, prices.get(p.symbol)!, 'account_failed', now);
      data.balance = balance;
      data.status = 'failed';
      data.failReason = verdict.reason;
      data.endedAt = now;
      await this.audit(tx, account.userId, 'challenge.account.failed', account.id, {
        reason: verdict.reason,
        phase: account.phase,
        metrics: verdict.metrics,
      });
    } else if (verdict.status === 'target_reached') {
      const next = nextPhase(account.phase as ChallengePhase)!;
      const size = num(account.accountSize);
      // À chaque changement de phase le compte repart de sa taille initiale (standard des prop firms).
      data.phase = next;
      data.balance = size;
      data.dayStartEquity = size;
      data.dayStartDate = today;
      data.phaseStartedAt = now;
      if (account.phase === 'phase1') data.phase1PassedAt = now;
      if (account.phase === 'phase2') {
        data.phase2PassedAt = now;
        data.fundedAt = now;
      }
      await this.audit(tx, account.userId, 'challenge.account.phase_passed', account.id, {
        from: account.phase,
        to: next,
        metrics: verdict.metrics,
      });
    }

    account = await tx.challengeAccount.update({ where: { id: accountId }, data });
    return account;
  }

  /** Job de surveillance : SL/TP, minuit UTC, échéances — au même rythme que PositionService. */
  @Cron(CronExpression.EVERY_MINUTE)
  async monitorAccounts() {
    if (this.monitoring) return; // un cycle plus long qu'une minute ne doit pas se chevaucher
    this.monitoring = true;
    try {
      const accounts = await this.prisma.challengeAccount.findMany({ where: { status: 'active' }, select: { id: true } });
      for (const { id } of accounts) {
        try {
          await this.withAccountLock(id, (tx) => this.settle(tx, id));
        } catch (err) {
          this.logger.warn(`Compte ${id} — surveillance échouée : ${err instanceof Error ? err.message : err}`);
        }
      }
    } finally {
      this.monitoring = false;
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Présentation
  // ---------------------------------------------------------------------------------------------

  private presentPosition(p: ChallengePosition, lastPrice: number | null) {
    const entry = num(p.entryPrice);
    const qty = num(p.qty);
    return {
      id: p.id,
      symbol: p.symbol,
      qty,
      entryPrice: entry,
      stopLoss: num(p.stopLoss),
      takeProfit: p.takeProfit != null ? num(p.takeProfit) : null,
      status: p.status,
      exitPrice: p.exitPrice != null ? num(p.exitPrice) : null,
      realizedPnl: p.realizedPnl != null ? num(p.realizedPnl) : null,
      exitReason: p.exitReason,
      openedAt: p.openedAt,
      closedAt: p.closedAt,
      lastPrice,
      unrealizedPnl: p.status === 'open' && lastPrice ? computeUnrealizedPnl(entry, lastPrice, qty) : null,
    };
  }

  private payoutBlockReason(
    a: ChallengeAccount,
    ctx: { paymentsEnabled: boolean; kycStatus: string },
    capacity: { traderShare: number },
    hasPending: boolean,
    lastPayoutAt: Date | null,
    now = new Date(),
  ): string | null {
    if (a.isDemo) return 'Les comptes de démo ne donnent pas droit à des retraits';
    if (!ctx.paymentsEnabled) return 'Les retraits ne sont pas encore activés sur la plateforme';
    if (a.phase !== 'funded' || a.status !== 'active') return 'Un retrait n\'est possible que sur un compte financé actif';
    if (ctx.kycStatus !== 'verified') return 'Vérification d\'identité (KYC) requise avant un premier retrait';
    if (hasPending) return 'Une demande de retrait est déjà en cours de traitement';
    const refDate = [a.fundedAt, lastPayoutAt].filter((d): d is Date => !!d).sort((x, y) => y.getTime() - x.getTime())[0];
    if (refDate) {
      const availableAt = new Date(refDate.getTime() + PAYOUT_COOLDOWN_DAYS * MS_PER_DAY);
      if (availableAt > now) return `Prochain retrait possible à partir du ${availableAt.toISOString().slice(0, 10)}`;
    }
    if (capacity.traderShare < MIN_PAYOUT_USDT) {
      return `Montant minimum de retrait : ${MIN_PAYOUT_USDT} USDT (disponible : ${round2(capacity.traderShare)} USDT)`;
    }
    return null;
  }

  /** Vue complète d'un compte, calculée au dernier prix (lecture seule). */
  private async buildView(
    account: ChallengeAccount,
    ctx: { paymentsEnabled: boolean; kycStatus: string },
    opts: { detail: boolean },
  ) {
    const openRows = await this.prisma.challengePosition.findMany({
      where: { accountId: account.id, status: 'open' },
      orderBy: { openedAt: 'asc' },
    });
    const openView = [];
    let unrealized = 0;
    for (const p of openRows) {
      let price: number | null = null;
      try {
        price = await this.getPrice(p.symbol);
      } catch {
        price = null; // prix indisponible : la position s'affiche sans latent plutôt que de casser la vue
      }
      const view = this.presentPosition(p, price);
      unrealized += view.unrealizedPnl ?? 0;
      openView.push(view);
    }

    const balance = num(account.balance);
    const equity = balance + unrealized;
    const rules = this.rulesOf(account);
    const tradingDays = await this.countTradingDays(this.prisma, account);
    const metrics = computeMetrics(rules, {
      phase: account.phase as ChallengePhase,
      balance,
      equity,
      dayStartEquity: num(account.dayStartEquity),
      tradingDays,
      openPositions: openRows.length,
      phaseStartedAt: account.phaseStartedAt,
      now: new Date(),
    });

    const capacity = computePayoutCapacity({
      accountSize: num(account.accountSize),
      balance,
      openPositions: openRows.length,
      profitSplitPct: num(account.profitSplitPct),
    });
    const [pending, last] = await Promise.all([
      this.prisma.challengePayout.findFirst({ where: { accountId: account.id, status: 'pending' } }),
      this.prisma.challengePayout.findFirst({
        where: { accountId: account.id, status: { not: 'rejected' } },
        orderBy: { createdAt: 'desc' },
      }),
    ]);
    const blockReason = this.payoutBlockReason(account, ctx, capacity, !!pending, last?.createdAt ?? null);

    const base = {
      id: account.id,
      planName: account.planName,
      isDemo: account.isDemo,
      phase: account.phase,
      status: account.status,
      failReason: account.failReason,
      accountSize: num(account.accountSize),
      feePaid: num(account.feePaid),
      balance,
      equity,
      dayStartEquity: num(account.dayStartEquity),
      rules: {
        profitTargetPct: rules.profitTargetPct,
        maxDailyLossPct: rules.maxDailyLossPct,
        maxTotalDrawdownPct: rules.maxTotalDrawdownPct,
        minTradingDays: rules.minTradingDays,
        maxDays: rules.maxDays,
        profitSplitPct: num(account.profitSplitPct),
      },
      metrics: { ...metrics, tradingDays },
      payout: {
        grossProfit: capacity.grossProfit,
        traderShare: round2(capacity.traderShare),
        canRequest: blockReason === null,
        blockReason,
        minAmount: MIN_PAYOUT_USDT,
      },
      totalPaidOut: num(account.totalPaidOut),
      phaseStartedAt: account.phaseStartedAt,
      phase1PassedAt: account.phase1PassedAt,
      phase2PassedAt: account.phase2PassedAt,
      fundedAt: account.fundedAt,
      endedAt: account.endedAt,
      createdAt: account.createdAt,
      openPositions: openView,
    };
    if (!opts.detail) return base;

    const [closed, payouts] = await Promise.all([
      this.prisma.challengePosition.findMany({
        where: { accountId: account.id, status: 'closed' },
        orderBy: { closedAt: 'desc' },
        take: 50,
      }),
      this.prisma.challengePayout.findMany({ where: { accountId: account.id }, orderBy: { createdAt: 'desc' } }),
    ]);
    return {
      ...base,
      closedPositions: closed.map((p) => this.presentPosition(p, null)),
      payouts: payouts.map((p) => this.presentPayout(p)),
    };
  }

  private presentPayout(p: { id: string; accountId: string; traderAmount: unknown; grossAmount: unknown; status: string; rejectionReason: string | null; createdAt: Date; reviewedAt: Date | null }) {
    return {
      id: p.id,
      accountId: p.accountId,
      traderAmount: num(p.traderAmount),
      grossAmount: num(p.grossAmount),
      status: p.status,
      rejectionReason: p.rejectionReason,
      createdAt: p.createdAt,
      reviewedAt: p.reviewedAt,
    };
  }

  private presentPlan(p: { id: string; name: string; accountSize: unknown; feeAmount: unknown; phase1TargetPct: unknown; phase2TargetPct: unknown; maxDailyLossPct: unknown; maxTotalDrawdownPct: unknown; minTradingDays: number; phase1MaxDays: number | null; phase2MaxDays: number | null; profitSplitPct: unknown; active: boolean }) {
    return {
      id: p.id,
      name: p.name,
      accountSize: num(p.accountSize),
      feeAmount: num(p.feeAmount),
      phase1TargetPct: num(p.phase1TargetPct),
      phase2TargetPct: num(p.phase2TargetPct),
      maxDailyLossPct: num(p.maxDailyLossPct),
      maxTotalDrawdownPct: num(p.maxTotalDrawdownPct),
      minTradingDays: p.minTradingDays,
      phase1MaxDays: p.phase1MaxDays,
      phase2MaxDays: p.phase2MaxDays,
      profitSplitPct: num(p.profitSplitPct),
      active: p.active,
    };
  }

  private async userContext(userId: string) {
    const [paymentsEnabled, user] = await Promise.all([
      this.paymentsEnabled(),
      this.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { kycStatus: true } }),
    ]);
    return { paymentsEnabled, kycStatus: user.kycStatus };
  }

  // ---------------------------------------------------------------------------------------------
  // Utilisateur
  // ---------------------------------------------------------------------------------------------

  async listPlans() {
    const [plans, paymentsEnabled] = await Promise.all([
      this.prisma.challengePlan.findMany({ where: { active: true }, orderBy: { accountSize: 'asc' } }),
      this.paymentsEnabled(),
    ]);
    return { paymentsEnabled, plans: plans.map((p) => this.presentPlan(p)) };
  }

  async createAccount(userId: string, dto: CreateChallengeAccountDto) {
    const plan = await this.prisma.challengePlan.findUnique({ where: { id: dto.planId } });
    if (!plan || !plan.active) throw new NotFoundException('Plan introuvable ou indisponible');

    const activeCount = await this.prisma.challengeAccount.count({ where: { userId, status: 'active' } });
    if (activeCount >= MAX_ACTIVE_ACCOUNTS_PER_USER) {
      throw new BadRequestException(`Maximum ${MAX_ACTIVE_ACCOUNTS_PER_USER} comptes de challenge actifs à la fois`);
    }

    const paymentsEnabled = await this.paymentsEnabled();
    const fee = paymentsEnabled ? num(plan.feeAmount) : 0; // démo : jamais de frais
    const id = randomUUID();
    const now = new Date();

    const account = await this.prisma.$transaction(async (tx) => {
      // Le débit (atomique, refuse un solde insuffisant) et la création du compte réussissent ou
      // échouent ensemble : pas de frais prélevés sans compte, ni de compte sans frais.
      if (fee > 0) await this.walletService.debit(userId, 'USDT', fee, 'challenge_fee', id, tx);
      const created = await tx.challengeAccount.create({
        data: {
          id,
          userId,
          planId: plan.id,
          planName: plan.name,
          isDemo: !paymentsEnabled,
          accountSize: plan.accountSize,
          feePaid: fee,
          phase1TargetPct: plan.phase1TargetPct,
          phase2TargetPct: plan.phase2TargetPct,
          maxDailyLossPct: plan.maxDailyLossPct,
          maxTotalDrawdownPct: plan.maxTotalDrawdownPct,
          minTradingDays: plan.minTradingDays,
          phase1MaxDays: plan.phase1MaxDays,
          phase2MaxDays: plan.phase2MaxDays,
          profitSplitPct: plan.profitSplitPct,
          balance: plan.accountSize,
          dayStartEquity: plan.accountSize,
          dayStartDate: startOfUtcDay(now),
          phaseStartedAt: now,
        },
      });
      await this.audit(tx, userId, 'challenge.account.created', id, { planId: plan.id, fee, demo: !paymentsEnabled });
      return created;
    });

    return this.buildView(account, await this.userContext(userId), { detail: false });
  }

  async listAccounts(userId: string) {
    const [accounts, ctx] = await Promise.all([
      this.prisma.challengeAccount.findMany({ where: { userId }, orderBy: { createdAt: 'desc' } }),
      this.userContext(userId),
    ]);
    return Promise.all(accounts.map((a) => this.buildView(a, ctx, { detail: false })));
  }

  async getAccount(userId: string, accountId: string) {
    const account = await this.loadOwned(this.prisma, userId, accountId);
    return this.buildView(account, await this.userContext(userId), { detail: true });
  }

  async openPosition(userId: string, accountId: string, dto: PlaceChallengeOrderDto) {
    const settings = await this.prisma.systemSetting.findUnique({ where: { id: SETTINGS_ID } });
    if (settings?.killSwitchEnabled) {
      throw new ForbiddenException(
        `Trading suspendu par l'administrateur${settings.killSwitchReason ? ` : ${settings.killSwitchReason}` : ''}`,
      );
    }

    return this.withAccountLock(accountId, async (tx) => {
      await this.loadOwned(tx, userId, accountId);
      // On règle d'abord le compte (SL/TP touchés, minuit UTC, verdict) : on n'ouvre jamais un trade
      // sur un état périmé, ni sur un compte que ce même passage vient de faire échouer.
      let account = await this.settle(tx, accountId);
      if (account.status !== 'active') throw new BadRequestException('Ce compte de challenge est terminé');

      const open = await tx.challengePosition.findMany({ where: { accountId, status: 'open' } });
      if (open.length >= MAX_OPEN_POSITIONS_PER_ACCOUNT) {
        throw new BadRequestException(`Maximum ${MAX_OPEN_POSITIONS_PER_ACCOUNT} positions ouvertes simultanément`);
      }

      const price = await this.getPrice(dto.symbol);
      let unrealized = 0;
      let usedNotional = 0;
      for (const p of open) {
        unrealized += computeUnrealizedPnl(num(p.entryPrice), await this.getPrice(p.symbol), num(p.qty));
        usedNotional += num(p.entryPrice) * num(p.qty);
      }
      const balance = num(account.balance);

      const error = validateChallengeOrder({
        availableCash: balance - usedNotional,
        equity: balance + unrealized,
        entryPrice: price,
        qty: dto.qty,
        stopLoss: dto.stopLoss,
        takeProfit: dto.takeProfit ?? null,
      });
      if (error) throw new BadRequestException(error);

      const position = await tx.challengePosition.create({
        data: {
          accountId,
          symbol: dto.symbol,
          qty: dto.qty,
          entryPrice: price,
          stopLoss: dto.stopLoss,
          takeProfit: dto.takeProfit ?? null,
          phase: account.phase,
        },
      });
      account = await this.settle(tx, accountId);
      return this.presentPosition(position, price);
    });
  }

  async closePosition(userId: string, accountId: string, positionId: string) {
    return this.withAccountLock(accountId, async (tx) => {
      await this.loadOwned(tx, userId, accountId);
      await this.settle(tx, accountId);
      const position = await tx.challengePosition.findFirst({ where: { id: positionId, accountId, status: 'open' } });
      if (!position) throw new NotFoundException('Position ouverte introuvable (déjà fermée ?)');

      const price = await this.getPrice(position.symbol);
      const pnl = await this.closeRow(tx, position, price, 'manual', new Date());
      await tx.challengeAccount.update({ where: { id: accountId }, data: { balance: { increment: pnl } } });
      await this.settle(tx, accountId); // peut valider la phase (objectif atteint, compte à plat) ou faire échouer le compte
      return { positionId, exitPrice: price, realizedPnl: pnl };
    });
  }

  async requestPayout(userId: string, accountId: string, dto: RequestChallengePayoutDto) {
    const ctx = await this.userContext(userId);
    return this.withAccountLock(accountId, async (tx) => {
      await this.loadOwned(tx, userId, accountId);
      const account = await this.settle(tx, accountId);

      const openCount = await tx.challengePosition.count({ where: { accountId, status: 'open' } });
      const capacity = computePayoutCapacity({
        accountSize: num(account.accountSize),
        balance: num(account.balance),
        openPositions: openCount,
        profitSplitPct: num(account.profitSplitPct),
      });
      const [pending, last] = await Promise.all([
        tx.challengePayout.findFirst({ where: { accountId, status: 'pending' } }),
        tx.challengePayout.findFirst({ where: { accountId, status: { not: 'rejected' } }, orderBy: { createdAt: 'desc' } }),
      ]);
      const block = this.payoutBlockReason(account, ctx, capacity, !!pending, last?.createdAt ?? null);
      if (block) throw new BadRequestException(block);

      const amount = round2(dto.amount);
      if (amount < MIN_PAYOUT_USDT) throw new BadRequestException(`Montant minimum de retrait : ${MIN_PAYOUT_USDT} USDT`);
      if (amount > Math.floor(capacity.traderShare * 100) / 100) {
        throw new BadRequestException(`Montant supérieur à votre part disponible (${round2(capacity.traderShare)} USDT)`);
      }
      const gross = grossForTraderAmount(amount, num(account.profitSplitPct));

      const payout = await tx.challengePayout.create({
        data: { accountId, userId, traderAmount: amount, grossAmount: gross },
      });
      // Le profit brut est retiré du solde simulé dès la demande (réservé). dayStartEquity baisse du
      // même montant : sinon la sortie du profit serait comptée comme une "perte du jour" et ferait
      // échouer le compte financé.
      await tx.challengeAccount.update({
        where: { id: accountId },
        data: {
          balance: { decrement: gross },
          dayStartEquity: { decrement: gross },
          totalPaidOut: { increment: gross },
        },
      });
      await this.audit(tx, userId, 'challenge.payout.requested', payout.id, { accountId, amount, gross });
      return this.presentPayout(payout);
    });
  }

  async listPayouts(userId: string) {
    const rows = await this.prisma.challengePayout.findMany({ where: { userId }, orderBy: { createdAt: 'desc' } });
    return rows.map((p) => this.presentPayout(p));
  }

  // ---------------------------------------------------------------------------------------------
  // Admin
  // ---------------------------------------------------------------------------------------------

  async listPlansAdmin() {
    const plans = await this.prisma.challengePlan.findMany({ orderBy: { accountSize: 'asc' } });
    return plans.map((p) => this.presentPlan(p));
  }

  async createPlan(adminId: string, dto: CreateChallengePlanDto) {
    const plan = await this.prisma.challengePlan.create({
      data: {
        name: dto.name,
        accountSize: dto.accountSize,
        feeAmount: dto.feeAmount,
        ...(dto.phase1TargetPct !== undefined && { phase1TargetPct: dto.phase1TargetPct }),
        ...(dto.phase2TargetPct !== undefined && { phase2TargetPct: dto.phase2TargetPct }),
        ...(dto.maxDailyLossPct !== undefined && { maxDailyLossPct: dto.maxDailyLossPct }),
        ...(dto.maxTotalDrawdownPct !== undefined && { maxTotalDrawdownPct: dto.maxTotalDrawdownPct }),
        ...(dto.minTradingDays !== undefined && { minTradingDays: dto.minTradingDays }),
        phase1MaxDays: dto.phase1MaxDays ?? null,
        phase2MaxDays: dto.phase2MaxDays ?? null,
        ...(dto.profitSplitPct !== undefined && { profitSplitPct: dto.profitSplitPct }),
        ...(dto.active !== undefined && { active: dto.active }),
      },
    });
    await this.prisma.auditLog.create({
      data: { actorId: adminId, action: 'challenge.plan.created', target: plan.id, metadata: JSON.stringify(dto) },
    });
    return this.presentPlan(plan);
  }

  async updatePlan(adminId: string, planId: string, dto: UpdateChallengePlanDto) {
    const existing = await this.prisma.challengePlan.findUnique({ where: { id: planId } });
    if (!existing) throw new NotFoundException('Plan introuvable');
    const data: Prisma.ChallengePlanUpdateInput = {};
    for (const [key, value] of Object.entries(dto)) {
      if (value !== undefined) (data as Record<string, unknown>)[key] = value; // null autorisé : "durée illimitée"
    }
    const plan = await this.prisma.challengePlan.update({ where: { id: planId }, data });
    await this.prisma.auditLog.create({
      data: { actorId: adminId, action: 'challenge.plan.updated', target: planId, metadata: JSON.stringify(dto) },
    });
    return this.presentPlan(plan);
  }

  async listAccountsAdmin(status?: string) {
    const rows = await this.prisma.challengeAccount.findMany({
      where: status ? { status } : undefined,
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: { user: { select: { email: true } }, _count: { select: { positions: { where: { status: 'open' } } } } },
    });
    return rows.map((a) => ({
      id: a.id,
      userEmail: a.user.email,
      planName: a.planName,
      isDemo: a.isDemo,
      phase: a.phase,
      status: a.status,
      failReason: a.failReason,
      accountSize: num(a.accountSize),
      balance: num(a.balance),
      feePaid: num(a.feePaid),
      totalPaidOut: num(a.totalPaidOut),
      openPositions: a._count.positions,
      createdAt: a.createdAt,
      endedAt: a.endedAt,
    }));
  }

  /** Clôture forcée d'un compte par un admin : positions soldées au marché, compte marqué "failed / admin". */
  async closeAccountAdmin(adminId: string, accountId: string, reason: string) {
    return this.withAccountLock(accountId, async (tx) => {
      const account = await tx.challengeAccount.findUniqueOrThrow({ where: { id: accountId } });
      if (account.status !== 'active') throw new BadRequestException('Ce compte est déjà terminé');

      const now = new Date();
      let balance = num(account.balance);
      const open = await tx.challengePosition.findMany({ where: { accountId, status: 'open' } });
      for (const p of open) balance += await this.closeRow(tx, p, await this.getPrice(p.symbol), 'account_failed', now);

      const updated = await tx.challengeAccount.update({
        where: { id: accountId },
        data: { balance, status: 'failed', failReason: 'admin', endedAt: now },
      });
      await this.audit(tx, adminId, 'challenge.account.closed_by_admin', accountId, { reason });
      return { id: updated.id, status: updated.status, failReason: updated.failReason };
    });
  }

  async listPayoutsAdmin(status?: string) {
    const rows = await this.prisma.challengePayout.findMany({
      where: status ? { status } : undefined,
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: { user: { select: { email: true, kycStatus: true } }, account: { select: { planName: true, isDemo: true } } },
    });
    return rows.map((p) => ({
      ...this.presentPayout(p),
      userEmail: p.user.email,
      kycStatus: p.user.kycStatus,
      planName: p.account.planName,
    }));
  }

  /** Comme l'approbation d'un retrait wallet : revendication atomique de "pending" + mouvement d'argent dans UNE transaction. */
  async approvePayout(adminId: string, payoutId: string) {
    if (!(await this.paymentsEnabled())) {
      throw new ForbiddenException('Les mouvements d\'argent réel sont désactivés (interrupteur "argent réel" éteint)');
    }
    const payout = await this.prisma.challengePayout.findUnique({ where: { id: payoutId } });
    if (!payout) throw new NotFoundException('Demande de retrait introuvable');

    return this.prisma.$transaction(async (tx) => {
      const claim = await tx.challengePayout.updateMany({
        where: { id: payoutId, status: 'pending' },
        data: { status: 'approved', reviewedByAdminId: adminId, reviewedAt: new Date() },
      });
      if (claim.count === 0) throw new BadRequestException('Retrait déjà traité');
      await this.walletService.credit(payout.userId, 'USDT', num(payout.traderAmount), 'challenge_payout', payout.id, tx);
      await this.audit(tx, adminId, 'challenge.payout.approved', payoutId, { userId: payout.userId, amount: num(payout.traderAmount) });
      return this.presentPayout(await tx.challengePayout.findUniqueOrThrow({ where: { id: payoutId } }));
    });
  }

  async rejectPayout(adminId: string, payoutId: string, reason: string) {
    const payout = await this.prisma.challengePayout.findUnique({ where: { id: payoutId } });
    if (!payout) throw new NotFoundException('Demande de retrait introuvable');

    return this.prisma.$transaction(async (tx) => {
      const claim = await tx.challengePayout.updateMany({
        where: { id: payoutId, status: 'pending' },
        data: { status: 'rejected', rejectionReason: reason, reviewedByAdminId: adminId, reviewedAt: new Date() },
      });
      if (claim.count === 0) throw new BadRequestException('Retrait déjà traité');
      // Le profit réservé à la demande est rendu au compte simulé.
      await tx.challengeAccount.update({
        where: { id: payout.accountId },
        data: {
          balance: { increment: payout.grossAmount },
          dayStartEquity: { increment: payout.grossAmount },
          totalPaidOut: { decrement: payout.grossAmount },
        },
      });
      await this.audit(tx, adminId, 'challenge.payout.rejected', payoutId, { reason });
      return this.presentPayout(await tx.challengePayout.findUniqueOrThrow({ where: { id: payoutId } }));
    });
  }

  async getPaymentsStatus() {
    return { paymentsEnabled: await this.paymentsEnabled(), confirmPhrase: PAYMENTS_CONFIRM_PHRASE };
  }

  /**
   * Interrupteur "argent réel" (§8.3 ARCHITECTURE.md). L'activer exige de recopier une phrase de
   * confirmation ; le désactiver est toujours possible immédiatement (couper est le geste de sécurité).
   * Chaque changement est tracé dans l'audit log.
   */
  async setPaymentsEnabled(adminId: string, dto: SetPaymentsEnabledDto) {
    if (dto.enabled && dto.confirm !== PAYMENTS_CONFIRM_PHRASE) {
      throw new BadRequestException(`Pour activer l'argent réel, saisissez exactement : ${PAYMENTS_CONFIRM_PHRASE}`);
    }
    await this.prisma.systemSetting.upsert({
      where: { id: SETTINGS_ID },
      update: { challengePaymentsEnabled: dto.enabled },
      create: { id: SETTINGS_ID, challengePaymentsEnabled: dto.enabled },
    });
    await this.prisma.auditLog.create({
      data: {
        actorId: adminId,
        action: dto.enabled ? 'challenge.payments.enabled' : 'challenge.payments.disabled',
        target: 'platform',
        metadata: JSON.stringify({}),
      },
    });
    return this.getPaymentsStatus();
  }
}
