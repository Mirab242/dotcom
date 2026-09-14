import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { WalletService } from '../wallet/wallet.service';
import { AdjustWalletDto } from './dto/adjust-wallet.dto';

@Injectable()
export class AdminService {
  constructor(
    private prisma: PrismaService,
    private walletService: WalletService,
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
}
