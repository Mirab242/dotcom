import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { WalletService } from '../wallet/wallet.service';
import { CreateDepositDto } from './dto/create-deposit.dto';
import { CreateWithdrawalDto } from './dto/create-withdrawal.dto';

/**
 * Garde des fonds — Option A "semi-manuelle" (§4.6bis) : aucune infrastructure de clés on-chain,
 * aucun fonds réel tant que le cadre légal n'est pas tranché (§8). Un dépôt/retrait ici ne fait
 * que créditer/débiter le wallet interne testnet, sur validation explicite d'un admin — exactement
 * le modèle recommandé pour la V1 dans l'architecture.
 *
 * Chaque approbation/rejet est une transaction unique qui (1) revendique l'enregistrement en le
 * faisant sortir de "pending" via un update atomique, et (2) applique le mouvement de wallet —
 * pour que deux clics admin concurrents (ou un double-clic accidentel) ne puissent jamais faire
 * l'un et l'autre passer : seul le premier à revendiquer "pending" gagne, le second échoue proprement.
 */
@Injectable()
export class CustodyService {
  constructor(
    private prisma: PrismaService,
    private walletService: WalletService,
  ) {}

  // --- Dépôts ---

  async createDeposit(userId: string, dto: CreateDepositDto) {
    return this.prisma.deposit.create({
      data: { userId, currency: dto.currency, amount: dto.amount, method: 'manual', reference: dto.reference },
    });
  }

  async listDepositsForUser(userId: string) {
    return this.prisma.deposit.findMany({ where: { userId }, orderBy: { createdAt: 'desc' } });
  }

  async listAllDeposits(status?: string) {
    return this.prisma.deposit.findMany({
      where: status ? { status } : undefined,
      orderBy: { createdAt: 'desc' },
      include: { user: { select: { email: true } } },
    });
  }

  async creditDeposit(adminId: string, depositId: string) {
    const deposit = await this.prisma.deposit.findUnique({ where: { id: depositId } });
    if (!deposit) throw new NotFoundException('Dépôt introuvable');

    return this.prisma.$transaction(async (tx) => {
      const claim = await tx.deposit.updateMany({
        where: { id: depositId, status: 'pending' },
        data: { status: 'credited', creditedByAdminId: adminId, creditedAt: new Date() },
      });
      if (claim.count === 0) {
        throw new BadRequestException('Dépôt déjà traité');
      }
      await this.walletService.credit(deposit.userId, deposit.currency, Number(deposit.amount), 'deposit', deposit.id, tx);
      return tx.deposit.findUniqueOrThrow({ where: { id: depositId } });
    });
  }

  async rejectDeposit(adminId: string, depositId: string) {
    const result = await this.prisma.deposit.updateMany({
      where: { id: depositId, status: 'pending' },
      data: { status: 'rejected', creditedByAdminId: adminId },
    });
    if (result.count === 0) {
      const deposit = await this.prisma.deposit.findUnique({ where: { id: depositId } });
      if (!deposit) throw new NotFoundException('Dépôt introuvable');
      throw new BadRequestException(`Dépôt déjà traité (statut: ${deposit.status})`);
    }
    return this.prisma.deposit.findUniqueOrThrow({ where: { id: depositId } });
  }

  // --- Retraits ---

  /** Les fonds sont réservés (lock) immédiatement pour empêcher un double-retrait pendant la validation admin. */
  async createWithdrawal(userId: string, dto: CreateWithdrawalDto) {
    await this.walletService.lock(userId, dto.currency, dto.amount);
    return this.prisma.withdrawal.create({
      data: { userId, currency: dto.currency, amount: dto.amount, destination: dto.destination },
    });
  }

  async listWithdrawalsForUser(userId: string) {
    return this.prisma.withdrawal.findMany({ where: { userId }, orderBy: { createdAt: 'desc' } });
  }

  async listAllWithdrawals(status?: string) {
    return this.prisma.withdrawal.findMany({
      where: status ? { status } : undefined,
      orderBy: { createdAt: 'desc' },
      include: { user: { select: { email: true } } },
    });
  }

  async approveWithdrawal(adminId: string, withdrawalId: string) {
    const withdrawal = await this.prisma.withdrawal.findUnique({ where: { id: withdrawalId } });
    if (!withdrawal) throw new NotFoundException('Retrait introuvable');

    return this.prisma.$transaction(async (tx) => {
      const claim = await tx.withdrawal.updateMany({
        where: { id: withdrawalId, status: 'pending' },
        // "sent" simule l'exécution manuelle réelle (virement / mobile money) faite hors plateforme par l'admin.
        data: { status: 'sent', approvedByAdminId: adminId, processedAt: new Date() },
      });
      if (claim.count === 0) {
        throw new BadRequestException('Retrait déjà traité');
      }
      await this.walletService.debitLocked(
        withdrawal.userId,
        withdrawal.currency,
        Number(withdrawal.amount),
        'withdrawal',
        withdrawal.id,
        tx,
      );
      return tx.withdrawal.findUniqueOrThrow({ where: { id: withdrawalId } });
    });
  }

  async rejectWithdrawal(adminId: string, withdrawalId: string) {
    const withdrawal = await this.prisma.withdrawal.findUnique({ where: { id: withdrawalId } });
    if (!withdrawal) throw new NotFoundException('Retrait introuvable');

    return this.prisma.$transaction(async (tx) => {
      const claim = await tx.withdrawal.updateMany({
        where: { id: withdrawalId, status: 'pending' },
        data: { status: 'rejected', approvedByAdminId: adminId, processedAt: new Date() },
      });
      if (claim.count === 0) {
        throw new BadRequestException('Retrait déjà traité');
      }
      await this.walletService.unlock(withdrawal.userId, withdrawal.currency, Number(withdrawal.amount), tx);
      return tx.withdrawal.findUniqueOrThrow({ where: { id: withdrawalId } });
    });
  }
}
