import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

const STARTING_BALANCE_USDT = 1000; // solde de départ "monnaie testnet" — pas des fonds réels

@Injectable()
export class WalletService {
  constructor(private prisma: PrismaService) {}

  async listWallets(userId: string) {
    return this.prisma.wallet.findMany({ where: { userId } });
  }

  private async getOrCreateWallet(userId: string, currency: string) {
    const existing = await this.prisma.wallet.findUnique({
      where: { userId_currency: { userId, currency } },
    });
    if (existing) return existing;
    return this.prisma.wallet.create({ data: { userId, currency, availableBalance: 0 } });
  }

  /** Appelé une seule fois à l'inscription — crédite un solde de départ fictif (testnet). */
  async seedInitialBalance(userId: string) {
    await this.getOrCreateWallet(userId, 'USDT');
    await this.credit(userId, 'USDT', STARTING_BALANCE_USDT, 'adjustment', userId);
  }

  async credit(userId: string, currency: string, amount: number, refTable: string, refId: string) {
    const wallet = await this.getOrCreateWallet(userId, currency);
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.wallet.update({
        where: { id: wallet.id },
        data: { availableBalance: { increment: amount } },
      });
      await tx.ledgerEntry.create({
        data: { walletId: wallet.id, type: refTable, amount, refId, refTable },
      });
      return updated;
    });
  }

  /** Débite le wallet ; lève une erreur si le solde disponible est insuffisant (pas de découvert). */
  async debit(userId: string, currency: string, amount: number, refTable: string, refId: string) {
    const wallet = await this.getOrCreateWallet(userId, currency);
    if (Number(wallet.availableBalance) < amount) {
      throw new BadRequestException(
        `Solde ${currency} insuffisant (disponible: ${wallet.availableBalance}, requis: ${amount})`,
      );
    }
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.wallet.update({
        where: { id: wallet.id },
        data: { availableBalance: { decrement: amount } },
      });
      await tx.ledgerEntry.create({
        data: { walletId: wallet.id, type: refTable, amount: -amount, refId, refTable },
      });
      return updated;
    });
  }

  async getBalance(userId: string, currency: string): Promise<number> {
    const wallet = await this.prisma.wallet.findUnique({
      where: { userId_currency: { userId, currency } },
    });
    return wallet ? Number(wallet.availableBalance) : 0;
  }

  /**
   * Réserve des fonds sans les débiter — utilisé le temps qu'une demande de retrait (§4.6bis
   * Option A) soit validée par un admin, pour empêcher un double-retrait du même solde.
   */
  async lock(userId: string, currency: string, amount: number) {
    const wallet = await this.getOrCreateWallet(userId, currency);
    if (Number(wallet.availableBalance) < amount) {
      throw new BadRequestException(
        `Solde ${currency} insuffisant (disponible: ${wallet.availableBalance}, requis: ${amount})`,
      );
    }
    return this.prisma.wallet.update({
      where: { id: wallet.id },
      data: { availableBalance: { decrement: amount }, lockedBalance: { increment: amount } },
    });
  }

  /** Annule une réservation (retrait rejeté) — remet les fonds en disponible. */
  async unlock(userId: string, currency: string, amount: number) {
    const wallet = await this.getOrCreateWallet(userId, currency);
    return this.prisma.wallet.update({
      where: { id: wallet.id },
      data: { availableBalance: { increment: amount }, lockedBalance: { decrement: amount } },
    });
  }

  /** Retrait approuvé : les fonds réservés sortent définitivement du wallet. */
  async debitLocked(userId: string, currency: string, amount: number, refTable: string, refId: string) {
    const wallet = await this.getOrCreateWallet(userId, currency);
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.wallet.update({
        where: { id: wallet.id },
        data: { lockedBalance: { decrement: amount } },
      });
      await tx.ledgerEntry.create({
        data: { walletId: wallet.id, type: refTable, amount: -amount, refId, refTable },
      });
      return updated;
    });
  }
}
