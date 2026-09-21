import { ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { OrderSide } from '@dot-trader/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import { ExchangeService } from '../exchange/exchange.service';
import { WalletService } from '../wallet/wallet.service';
import { RiskService } from '../risk/risk.service';

// Une fois le prix à +1R (même distance que le risque initial), le stop-loss est déplacé
// au point d'entrée : le trade ne peut plus se solder en perte (hors frais/slippage).
const BREAK_EVEN_TRIGGER_R = 1;
// Après le passage au point mort, le stop suit le prix à distance fixe pour verrouiller
// une partie des gains au fil de la hausse (§4.5 "trailing stop basé ATR ou %").
const TRAILING_STOP_PCT = 1;
// Monétisation (§4.10) : commission plateforme sur les trades gagnants, tier "free" uniquement —
// le tier "pro" en est exonéré, c'est son principal avantage (avec le mode automatique).
const FREE_TIER_COMMISSION_RATE = 0.1;

/**
 * Surveille les positions ouvertes et les ferme au marché dès que le stop-loss ou le
 * take-profit est touché — le garde-fou SL n'a de sens que si quelqu'un le fait respecter
 * après l'entrée, pas seulement au moment du calcul de taille (risk-engine). Gère aussi le
 * passage au point mort et le trailing stop une fois le trade suffisamment en profit.
 * N'a volontairement aucune dépendance sur TradingModule pour éviter un cycle
 * (TradingService ouvre des positions ; ce service les ferme indépendamment).
 */
@Injectable()
export class PositionService {
  private readonly logger = new Logger(PositionService.name);
  private monitoring = false; // un passage plus long qu'une minute ne doit pas se chevaucher avec le suivant

  constructor(
    private prisma: PrismaService,
    private exchangeService: ExchangeService,
    private walletService: WalletService,
    private riskService: RiskService,
  ) {}

  async openPosition(params: {
    userId: string;
    symbol: string;
    qty: number;
    entryPrice: number;
    stopLoss: number;
    takeProfit?: number;
    entryOrderId: string;
  }) {
    return this.prisma.position.create({
      data: {
        userId: params.userId,
        symbol: params.symbol,
        qty: params.qty,
        entryPrice: params.entryPrice,
        stopLoss: params.stopLoss,
        initialStopLoss: params.stopLoss,
        takeProfit: params.takeProfit ?? null,
        entryOrderId: params.entryOrderId,
      },
    });
  }

  async listForUser(userId: string) {
    return this.prisma.position.findMany({ where: { userId }, orderBy: { openedAt: 'desc' }, take: 50 });
  }

  async closeManually(userId: string, id: string) {
    const position = await this.prisma.position.findUnique({ where: { id } });
    if (!position) throw new NotFoundException('Position introuvable');
    if (position.userId !== userId) throw new ForbiddenException();
    if (position.status !== 'open') throw new ForbiddenException('Position déjà fermée');
    return this.closePosition(position, 'manual');
  }

  /** Job planifié — vérifie chaque position ouverte contre le dernier prix connu. */
  @Cron(CronExpression.EVERY_MINUTE)
  async monitorPositions() {
    if (this.monitoring) return;
    this.monitoring = true;
    try {
      await this.monitorOpenPositions();
    } finally {
      this.monitoring = false;
    }
  }

  private async monitorOpenPositions() {
    const openPositions = await this.prisma.position.findMany({ where: { status: 'open' } });
    for (const position of openPositions) {
      try {
        const [lastCandle] = await this.exchangeService.getConnector().getCandles(position.symbol, '1m', 1);
        const lastPrice = lastCandle?.close;
        if (!lastPrice) continue;

        const currentStopLoss = await this.applyBreakEvenAndTrailing(position, lastPrice);

        if (lastPrice <= currentStopLoss) {
          await this.closePosition(position, position.breakEvenActivated ? 'trailing_stop' : 'sl');
        } else if (position.takeProfit && lastPrice >= Number(position.takeProfit)) {
          await this.closePosition(position, 'tp');
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Erreur inconnue';
        this.logger.warn(`Position ${position.id} (${position.symbol}) — surveillance échouée : ${message}`);
      }
    }
  }

  /** Déplace le stop au point mort puis le fait suivre le prix — retourne le stop-loss à jour. */
  private async applyBreakEvenAndTrailing(
    position: { id: string; entryPrice: unknown; initialStopLoss: unknown; stopLoss: unknown; breakEvenActivated: boolean },
    lastPrice: number,
  ): Promise<number> {
    const entryPrice = Number(position.entryPrice);
    let stopLoss = Number(position.stopLoss);

    if (!position.breakEvenActivated) {
      const riskDistance = entryPrice - Number(position.initialStopLoss);
      const breakEvenTriggerPrice = entryPrice + riskDistance * BREAK_EVEN_TRIGGER_R;
      if (riskDistance > 0 && lastPrice >= breakEvenTriggerPrice) {
        stopLoss = entryPrice;
        position.breakEvenActivated = true;
        await this.prisma.position.update({
          where: { id: position.id },
          data: { stopLoss, breakEvenActivated: true },
        });
        this.logger.log(`Position ${position.id} — stop déplacé au point mort (${stopLoss.toFixed(4)})`);
      }
      return stopLoss;
    }

    const trailingCandidate = lastPrice * (1 - TRAILING_STOP_PCT / 100);
    if (trailingCandidate > stopLoss) {
      stopLoss = trailingCandidate;
      await this.prisma.position.update({ where: { id: position.id }, data: { stopLoss } });
      this.logger.log(`Position ${position.id} — trailing stop relevé à ${stopLoss.toFixed(4)}`);
    }
    return stopLoss;
  }

  private async closePosition(position: { id: string; userId: string; symbol: string; qty: unknown; entryPrice: unknown }, reason: 'sl' | 'tp' | 'manual' | 'trailing_stop') {
    const qty = Number(position.qty);
    const entryPrice = Number(position.entryPrice);
    const [base, quote] = position.symbol.split('/');

    const result = await this.exchangeService.getConnector().placeOrder({
      symbol: position.symbol,
      side: OrderSide.SELL,
      type: 'market',
      amount: qty,
      clientOrderId: position.id,
    });

    const filledQty = result.filledAmount > 0 ? result.filledAmount : qty;
    const exitPrice = result.averagePrice ?? entryPrice;
    const cost = filledQty * exitPrice;
    const realizedPnl = (exitPrice - entryPrice) * filledQty;

    // LA VENTE A EU LIEU chez l'exchange. On acte TOUT DE SUITE la fermeture, avant toute écriture
    // comptable : si l'une d'elles échouait avec la position encore "open", le job repasserait la
    // minute suivante et REVENDRAIT — en argent réel, jusqu'à vendre d'autres actifs détenus sur le
    // même compte. Une position déjà vendue ne doit plus jamais être rouverte par une erreur interne.
    await this.prisma.position.update({
      where: { id: position.id },
      data: { status: 'closed', exitPrice, realizedPnl, exitReason: reason, closedAt: new Date() },
    });

    try {
      await this.walletService.debit(position.userId, base, filledQty, 'trade_pnl', position.id);
      await this.walletService.credit(position.userId, quote, cost, 'trade_pnl', position.id);
      const equityAfter = await this.riskService.computeCurrentEquity(position.userId);

      const closeOrder = await this.prisma.order.create({
        data: {
          userId: position.userId,
          symbol: position.symbol,
          side: 'sell',
          type: 'market',
          qty: filledQty,
          mode: 'auto',
          exchangeOrderId: result.exchangeOrderId,
          exchangeStatus: result.status,
          filledQty,
          avgPrice: exitPrice,
          status: 'filled',
          equityAfter,
        },
      });

      let commissionCharged: number | null = null;
      if (realizedPnl > 0) {
        const user = await this.prisma.user.findUnique({ where: { id: position.userId } });
        if (user && user.subscriptionTier !== 'pro') {
          commissionCharged = realizedPnl * FREE_TIER_COMMISSION_RATE;
          await this.walletService.debit(position.userId, quote, commissionCharged, 'commission', position.id);
        }
      }

      await this.prisma.position.update({
        where: { id: position.id },
        data: { commissionCharged, exitOrderId: closeOrder.id },
      });

      this.logger.log(
        `Position ${position.id} (${position.symbol}) fermée [${reason}] — P&L: ${realizedPnl.toFixed(4)} ${quote}` +
          (commissionCharged ? ` (commission: -${commissionCharged.toFixed(4)} ${quote})` : ''),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Erreur de règlement inconnue';
      this.logger.error(`Position ${position.id} VENDUE chez l'exchange mais règlement interne en échec : ${message}`);
      await this.prisma.auditLog
        .create({
          data: {
            actorId: position.userId,
            action: 'position.settlement_failed',
            target: position.id,
            metadata: JSON.stringify({
              symbol: position.symbol,
              reason,
              exchangeOrderId: result.exchangeOrderId,
              filledQty,
              exitPrice,
              error: message,
            }),
          },
        })
        .catch(() => undefined); // le journal ne doit jamais masquer la fermeture elle-même
    }
  }
}
