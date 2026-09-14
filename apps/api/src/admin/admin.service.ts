import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { SUPPORTED_SYMBOLS } from '@dot-trader/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import { WalletService } from '../wallet/wallet.service';
import { ExchangeService } from '../exchange/exchange.service';
import { AdjustWalletDto } from './dto/adjust-wallet.dto';

// Écart toléré avant d'être signalé — les frais d'exchange créent un léger écart normal.
const RECONCILIATION_TOLERANCE_PCT = 0.5;
// Le compte Binance testnet est seedé par Binance avec plein d'autres actifs (BNB, TRX,
// même des tokens de test factices) que la plateforme ne gère pas du tout — les inclure dans
// la réconciliation noierait les vrais écarts sous du bruit. On ne regarde que les devises
// que la plateforme trade ou détient réellement (bases des paires supportées + USDT).
const RECONCILED_CURRENCIES = new Set(SUPPORTED_SYMBOLS.flatMap((s) => s.split('/')));

@Injectable()
export class AdminService {
  constructor(
    private prisma: PrismaService,
    private walletService: WalletService,
    private exchangeService: ExchangeService,
  ) {}

  async getStats() {
    const [
      totalUsers,
      totalOrders,
      filledOrders,
      totalOpenPositions,
      totalActiveBots,
      pendingDeposits,
      pendingWithdrawals,
      commissions,
    ] = await Promise.all([
      this.prisma.user.count(),
      this.prisma.order.count(),
      this.prisma.order.findMany({ where: { status: 'filled' }, select: { filledQty: true, avgPrice: true } }),
      this.prisma.position.count({ where: { status: 'open' } }),
      this.prisma.botInstance.count({ where: { enabled: true } }),
      this.prisma.deposit.count({ where: { status: 'pending' } }),
      this.prisma.withdrawal.count({ where: { status: 'pending' } }),
      this.prisma.position.aggregate({ _sum: { commissionCharged: true } }),
    ]);

    const totalVolumeUsdt = filledOrders.reduce(
      (sum, o) => sum + Number(o.filledQty ?? 0) * Number(o.avgPrice ?? 0),
      0,
    );

    return {
      totalUsers,
      totalOrders,
      totalFilledOrders: filledOrders.length,
      totalVolumeUsdt,
      totalOpenPositions,
      totalActiveBots,
      pendingDeposits,
      pendingWithdrawals,
      totalCommissionsEarned: Number(commissions._sum.commissionCharged ?? 0),
    };
  }

  async listAuditLogs(limit = 100) {
    const logs = await this.prisma.auditLog.findMany({
      orderBy: { createdAt: 'desc' },
      take: Math.min(limit, 200),
      include: { actor: { select: { email: true } } },
    });
    return logs.map((l) => ({ ...l, actorEmail: l.actor?.email ?? null, actor: undefined }));
  }

  async listAllBots() {
    return this.prisma.botInstance.findMany({
      orderBy: { createdAt: 'desc' },
      include: { user: { select: { email: true } } },
    });
  }

  async listUsers() {
    const users = await this.prisma.user.findMany({
      orderBy: { createdAt: 'desc' },
      include: { wallets: { select: { currency: true, availableBalance: true, lockedBalance: true } } },
    });
    return users.map(({ passwordHash, twoFaSecret, ...safe }) => safe);
  }

  private async assertUserExists(id: string) {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) throw new NotFoundException('Utilisateur introuvable');
    return user;
  }

  async setUserStatus(adminId: string, userId: string, status: 'active' | 'suspended') {
    await this.assertUserExists(userId);
    const user = await this.prisma.user.update({ where: { id: userId }, data: { status } });
    await this.prisma.auditLog.create({
      data: { actorId: adminId, action: `user.status.${status}`, target: userId },
    });
    const { passwordHash, twoFaSecret, ...safe } = user;
    return safe;
  }

  async setUserRole(adminId: string, userId: string, role: 'user' | 'admin') {
    await this.assertUserExists(userId);
    const user = await this.prisma.user.update({ where: { id: userId }, data: { role } });
    await this.prisma.auditLog.create({
      data: { actorId: adminId, action: `user.role.${role}`, target: userId },
    });
    const { passwordHash, twoFaSecret, ...safe } = user;
    return safe;
  }

  async setUserSubscription(adminId: string, userId: string, subscriptionTier: 'free' | 'pro') {
    await this.assertUserExists(userId);
    const user = await this.prisma.user.update({ where: { id: userId }, data: { subscriptionTier } });
    await this.prisma.auditLog.create({
      data: { actorId: adminId, action: `user.subscription.${subscriptionTier}`, target: userId },
    });
    const { passwordHash, twoFaSecret, ...safe } = user;
    return safe;
  }

  /**
   * Crédit/débit manuel du wallet interne — sert par exemple à créditer un dépôt reçu
   * hors-ligne sans passer par le flux de demande utilisateur (§4.6bis), ou à corriger
   * une erreur. Chaque mouvement est tracé avec son motif dans le journal d'audit.
   */
  async adjustWallet(adminId: string, userId: string, dto: AdjustWalletDto) {
    await this.assertUserExists(userId);

    if (dto.direction === 'credit') {
      await this.walletService.credit(userId, dto.currency, dto.amount, 'admin_adjustment', adminId);
    } else {
      await this.walletService.debit(userId, dto.currency, dto.amount, 'admin_adjustment', adminId);
    }

    await this.prisma.auditLog.create({
      data: {
        actorId: adminId,
        action: `wallet.${dto.direction}`,
        target: userId,
        metadata: JSON.stringify({ currency: dto.currency, amount: dto.amount, reason: dto.reason }),
      },
    });

    return this.walletService.listWallets(userId);
  }

  /**
   * Suppression définitive d'un compte. Refuse si le wallet n'est pas à zéro — un solde
   * (surtout en mode live, §8) ne doit jamais disparaître silencieusement avec le compte ;
   * l'admin doit d'abord le vider (retrait) avant de pouvoir supprimer.
   */
  async deleteUser(adminId: string, userId: string) {
    await this.assertUserExists(userId);

    const wallets = await this.walletService.listWallets(userId);
    const hasBalance = wallets.some((w) => Number(w.availableBalance) > 0 || Number(w.lockedBalance) > 0);
    if (hasBalance) {
      throw new BadRequestException(
        'Impossible de supprimer un compte dont le wallet n\'est pas à zéro — videz-le (retrait) avant de supprimer.',
      );
    }

    await this.prisma.auditLog.create({
      data: { actorId: adminId, action: 'user.deleted', target: userId },
    });
    await this.prisma.user.delete({ where: { id: userId } });
    return { deleted: true, userId };
  }

  /**
   * Vérifie que la comptabilité interne (somme des wallets) correspond au solde réel du
   * compte Binance de la plateforme — indispensable en mode custodial : si les deux
   * divergent, soit un bug a fait apparaître/disparaître de l'argent virtuel, soit un
   * mouvement réel (frais, retrait manuel...) n'a pas été reflété dans le ledger interne.
   */
  async getReconciliation() {
    const mode = this.exchangeService.getActiveMode();

    const internalTotalsPromise = this.prisma.wallet.groupBy({
      by: ['currency'],
      _sum: { availableBalance: true, lockedBalance: true },
    });
    const realBalancesPromise = this.exchangeService.getConnector().getBalance();

    const [internalTotals, realBalances] = await Promise.all([internalTotalsPromise, realBalancesPromise]).catch(
      (err) => {
        const message = err instanceof Error ? err.message : 'Erreur inconnue';
        throw new BadRequestException(`Impossible d'interroger le solde Binance (${mode}) : ${message}`);
      },
    );

    const internalByCurrency = new Map(
      internalTotals.map((w) => [
        w.currency,
        Number(w._sum.availableBalance ?? 0) + Number(w._sum.lockedBalance ?? 0),
      ]),
    );
    const realByCurrency = new Map(realBalances.map((b) => [b.currency, b.total]));

    const currencies = new Set(
      [...internalByCurrency.keys(), ...realByCurrency.keys()].filter((c) => RECONCILED_CURRENCIES.has(c)),
    );
    const rows = [...currencies].map((currency) => {
      const internalTotal = internalByCurrency.get(currency) ?? 0;
      const realTotal = realByCurrency.get(currency) ?? 0;
      const discrepancy = realTotal - internalTotal;
      const discrepancyPct = internalTotal > 0 ? (Math.abs(discrepancy) / internalTotal) * 100 : (realTotal > 0 ? 100 : 0);
      return {
        currency,
        internalTotal,
        realTotal,
        discrepancy,
        discrepancyPct,
        flagged: discrepancyPct > RECONCILIATION_TOLERANCE_PCT,
      };
    });

    return {
      mode,
      checkedAt: new Date().toISOString(),
      rows,
      anyFlagged: rows.some((r) => r.flagged),
      note:
        mode === 'testnet'
          ? "Mode testnet : Binance crédite gratuitement chaque compte testnet avec de la fausse monnaie de départ (souvent des milliers de USDT/DOT) — un écart important ici est normal et attendu, pas un bug. La réconciliation ne devient un vrai signal fiable qu'en mode live, avec de l'argent réel."
          : null,
    };
  }
}
