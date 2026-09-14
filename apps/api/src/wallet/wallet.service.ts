import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

const STARTING_BALANCE_USDT = 1000; // solde de départ "monnaie testnet" — pas des fonds réels

// Client Prisma "normal" ou client lié à une transaction en cours (`prisma.$transaction(tx => ...)`).
// Chaque méthode accepte optionnellement un `tx` pour pouvoir composer avec une transaction
// plus large côté appelant (ex: CustodyService fait le changement de statut ET le mouvement
// de wallet dans UNE seule transaction, pour que les deux réussissent ou échouent ensemble).
type Db = PrismaService | Prisma.TransactionClient;

@Injectable()
export class WalletService {
  constructor(private prisma: PrismaService) {}

  async listWallets(userId: string) {
    return this.prisma.wallet.findMany({ where: { userId } });
  }

  private async getOrCreateWallet(db: Db, userId: string, currency: string) {
    const existing = await db.wallet.findUnique({
      where: { userId_currency: { userId, currency } },
    });
    if (existing) return existing;
    return db.wallet.create({ data: { userId, currency, availableBalance: 0 } });
  }

  /** Appelé une seule fois à l'inscription — crédite un solde de départ fictif (testnet). */
  async seedInitialBalance(userId: string) {
    await this.getOrCreateWallet(this.prisma, userId, 'USDT');
    await this.credit(userId, 'USDT', STARTING_BALANCE_USDT, 'adjustment', userId);
  }

  async credit(userId: string, currency: string, amount: number, refTable: string, refId: string, db: Db = this.prisma) {
    const run = async (tx: Db) => {
      const wallet = await this.getOrCreateWallet(tx, userId, currency);
      const updated = await tx.wallet.update({
        where: { id: wallet.id },
        data: { availableBalance: { increment: amount } },
      });
      await tx.ledgerEntry.create({
        data: { walletId: wallet.id, type: refTable, amount, refId, refTable },
      });
      return updated;
    };
    return db === this.prisma ? this.prisma.$transaction((tx) => run(tx)) : run(db);
  }

  /**
   * Débite le wallet ; lève une erreur si le solde disponible est insuffisant (pas de
   * découvert). Le check ET l'écriture se font dans la MÊME requête atomique
   * (`updateMany` avec `gte` dans le WHERE) — sinon deux débits concurrents peuvent tous
   * les deux lire le solde AVANT que l'un des deux écrive, et passer tous les deux la
   * vérification (race condition classique lire-puis-écrire, exploitable en tirant deux
   * requêtes en parallèle).
   */
  async debit(userId: string, currency: string, amount: number, refTable: string, refId: string, db: Db = this.prisma) {
    const run = async (tx: Db) => {
      const wallet = await this.getOrCreateWallet(tx, userId, currency);
      const result = await tx.wallet.updateMany({
        where: { id: wallet.id, availableBalance: { gte: amount } },
        data: { availableBalance: { decrement: amount } },
      });
      if (result.count === 0) {
        const current = await tx.wallet.findUniqueOrThrow({ where: { id: wallet.id } });
        throw new BadRequestException(
          `Solde ${currency} insuffisant (disponible: ${current.availableBalance}, requis: ${amount})`,
        );
      }
      await tx.ledgerEntry.create({
        data: { walletId: wallet.id, type: refTable, amount: -amount, refId, refTable },
      });
      return tx.wallet.findUniqueOrThrow({ where: { id: wallet.id } });
    };
    return db === this.prisma ? this.prisma.$transaction((tx) => run(tx)) : run(db);
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
   * Même garde-fou atomique que `debit()`.
   */
  async lock(userId: string, currency: string, amount: number, db: Db = this.prisma) {
    const wallet = await this.getOrCreateWallet(db, userId, currency);
    const result = await db.wallet.updateMany({
      where: { id: wallet.id, availableBalance: { gte: amount } },
      data: { availableBalance: { decrement: amount }, lockedBalance: { increment: amount } },
    });
    if (result.count === 0) {
      const current = await db.wallet.findUniqueOrThrow({ where: { id: wallet.id } });
      throw new BadRequestException(
        `Solde ${currency} insuffisant (disponible: ${current.availableBalance}, requis: ${amount})`,
      );
    }
    return db.wallet.findUniqueOrThrow({ where: { id: wallet.id } });
  }

  /** Annule une réservation (retrait rejeté) — remet les fonds en disponible. */
  async unlock(userId: string, currency: string, amount: number, db: Db = this.prisma) {
    const wallet = await this.getOrCreateWallet(db, userId, currency);
    const result = await db.wallet.updateMany({
      where: { id: wallet.id, lockedBalance: { gte: amount } },
      data: { availableBalance: { increment: amount }, lockedBalance: { decrement: amount } },
    });
    if (result.count === 0) {
      throw new BadRequestException('Montant verrouillé insuffisant pour ce déverrouillage');
    }
    return db.wallet.findUniqueOrThrow({ where: { id: wallet.id } });
  }

  /** Retrait approuvé : les fonds réservés sortent définitivement du wallet. */
  async debitLocked(userId: string, currency: string, amount: number, refTable: string, refId: string, db: Db = this.prisma) {
    const run = async (tx: Db) => {
      const wallet = await this.getOrCreateWallet(tx, userId, currency);
      const result = await tx.wallet.updateMany({
        where: { id: wallet.id, lockedBalance: { gte: amount } },
        data: { lockedBalance: { decrement: amount } },
      });
      if (result.count === 0) {
        throw new BadRequestException('Montant verrouillé insuffisant pour ce débit');
      }
      await tx.ledgerEntry.create({
        data: { walletId: wallet.id, type: refTable, amount: -amount, refId, refTable },
      });
      return tx.wallet.findUniqueOrThrow({ where: { id: wallet.id } });
    };
    return db === this.prisma ? this.prisma.$transaction((tx) => run(tx)) : run(db);
  }
}
