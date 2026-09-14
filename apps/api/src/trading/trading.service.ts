import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { OrderSide } from '@dot-trader/shared-types';
import { computePositionSize, validateStopLoss } from '@dot-trader/risk-engine';
import { PrismaService } from '../prisma/prisma.service';
import { ExchangeService } from '../exchange/exchange.service';
import { WalletService } from '../wallet/wallet.service';
import { RiskService } from '../risk/risk.service';
import { PositionService } from '../position/position.service';
import { CreateOrderDto } from './dto/create-order.dto';
import { ExecuteSignalDto } from './dto/execute-signal.dto';

const FREE_TIER_MAX_RISK_PERCENT = 1; // §4.10 — le tier "pro" débloque jusqu'au plafond risk-engine (3%)

/**
 * Phase 1 : l'ordre est réellement envoyé au compte Binance testnet DE LA PLATEFORME,
 * ET le wallet interne de l'utilisateur (monnaie testnet, voir WalletService) est
 * débité/crédité selon le résultat réel. Toujours pas de custody on-chain (§4.6bis) —
 * ce wallet reste un solde fictif de démonstration tant que le dépôt réel n'existe pas.
 *
 * Phase 3 : tout passage d'ordre (manuel ou assisté) passe par le kill switch (RiskService).
 * Le mode assisté ne fait plus confiance à la quantité envoyée par le client : elle est
 * recalculée côté serveur à partir du risque (%) et de la distance au stop-loss.
 */
@Injectable()
export class TradingService {
  constructor(
    private prisma: PrismaService,
    private exchangeService: ExchangeService,
    private walletService: WalletService,
    private riskService: RiskService,
    private positionService: PositionService,
  ) {}

  private splitSymbol(symbol: string): [string, string] {
    const [base, quote] = symbol.split('/');
    if (!base || !quote) throw new BadRequestException(`Symbole invalide : ${symbol}`);
    return [base, quote];
  }

  async createOrder(userId: string, dto: CreateOrderDto) {
    await this.riskService.assertTradingAllowed(userId);

    if (dto.type === 'limit' && !dto.price) {
      throw new BadRequestException('Le prix est requis pour un ordre limite');
    }
    const [base, quote] = this.splitSymbol(dto.symbol);
    await this.assertAffordable(userId, base, quote, dto.side, dto.qty, dto.price);

    return this.executeOrder(userId, {
      symbol: dto.symbol,
      side: dto.side,
      type: dto.type,
      qty: dto.qty,
      price: dto.price,
      mode: 'manual',
    });
  }

  /**
   * Mode assisté (§4.4) : l'utilisateur valide un signal généré par le moteur.
   * Le stop-loss est obligatoire, et la quantité est calculée par le risk-engine
   * à partir du solde réel et du % de risque — jamais depuis une valeur fournie par le client.
   */
  async executeSignal(userId: string, dto: ExecuteSignalDto, mode: 'assisted' | 'auto' = 'assisted') {
    await this.riskService.assertTradingAllowed(userId);

    const validation = validateStopLoss(dto.side, dto.entry, dto.stopLoss);
    if (!validation.valid) {
      throw new BadRequestException(validation.reason);
    }

    // Monétisation (§4.10) : le tier "free" est plafonné en dessous du maximum plateforme
    // (risk-engine, 3%) — un vrai avantage réservé au tier "pro", pas juste cosmétique.
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const requestedRisk = dto.riskPercent ?? 1;
    const riskPercent = user.subscriptionTier === 'pro' ? requestedRisk : Math.min(requestedRisk, FREE_TIER_MAX_RISK_PERCENT);

    const [base, quote] = this.splitSymbol(dto.symbol);
    const equity = await this.walletService.getBalance(userId, quote);
    const { qty, riskAmount, stopDistance } = computePositionSize({
      equity,
      riskPercent,
      entryPrice: dto.entry,
      stopLoss: dto.stopLoss,
    });

    if (qty <= 0) {
      throw new BadRequestException('Taille de position calculée nulle — vérifiez le solde et le stop-loss');
    }

    const orderType = dto.orderType ?? 'market';
    const limitPrice = orderType === 'limit' ? dto.entry : undefined;
    await this.assertAffordable(userId, base, quote, dto.side, qty, limitPrice);

    const order = await this.executeOrder(userId, {
      symbol: dto.symbol,
      side: dto.side,
      type: orderType,
      qty,
      price: limitPrice,
      mode,
      stopLoss: dto.stopLoss,
      takeProfit: dto.takeProfit,
      riskPercent,
    });

    // Le stop-loss/take-profit ne servent à rien s'ils ne sont surveillés qu'à l'entrée :
    // on ouvre une Position réelle (long uniquement, spot) que PositionService ferme
    // automatiquement au marché dès que le prix touche l'un des deux niveaux.
    if (dto.side === 'buy' && order.status === 'filled' && order.filledQty) {
      await this.positionService.openPosition({
        userId,
        symbol: dto.symbol,
        qty: Number(order.filledQty),
        entryPrice: Number(order.avgPrice ?? dto.entry),
        stopLoss: dto.stopLoss,
        takeProfit: dto.takeProfit,
        entryOrderId: order.id,
      });
    }

    return { ...order, riskAmount, stopDistance };
  }

  private async assertAffordable(
    userId: string,
    base: string,
    quote: string,
    side: 'buy' | 'sell',
    qty: number,
    price: number | undefined,
  ) {
    if (side === 'sell') {
      const baseBalance = await this.walletService.getBalance(userId, base);
      if (baseBalance < qty) {
        throw new BadRequestException(
          `Solde ${base} insuffisant pour vendre (disponible: ${baseBalance}, demandé: ${qty})`,
        );
      }
    } else {
      const [lastCandle] = await this.exchangeService.getConnector().getCandles(`${base}/${quote}`, '1m', 1);
      const refPrice = price ?? lastCandle?.close ?? 0;
      const estimatedCost = qty * refPrice * 1.01; // marge 1% pour la volatilité du market order
      const quoteBalance = await this.walletService.getBalance(userId, quote);
      if (refPrice > 0 && quoteBalance < estimatedCost) {
        throw new BadRequestException(
          `Solde ${quote} insuffisant pour acheter (disponible: ${quoteBalance}, estimé: ${estimatedCost.toFixed(2)})`,
        );
      }
    }
  }

  private async executeOrder(
    userId: string,
    params: {
      symbol: string;
      side: 'buy' | 'sell';
      type: 'market' | 'limit';
      qty: number;
      price?: number;
      mode: 'manual' | 'assisted' | 'auto';
      stopLoss?: number;
      takeProfit?: number;
      riskPercent?: number;
    },
  ) {
    const [base, quote] = this.splitSymbol(params.symbol);

    const order = await this.prisma.order.create({
      data: {
        userId,
        symbol: params.symbol,
        side: params.side,
        type: params.type,
        qty: params.qty,
        price: params.price ?? null,
        mode: params.mode,
        stopLoss: params.stopLoss ?? null,
        takeProfit: params.takeProfit ?? null,
        riskPercent: params.riskPercent ?? null,
        status: 'pending',
      },
    });

    try {
      const result = await this.exchangeService.getConnector().placeOrder({
        symbol: params.symbol,
        side: params.side === 'buy' ? OrderSide.BUY : OrderSide.SELL,
        type: params.type,
        amount: params.qty,
        price: params.price,
        clientOrderId: order.id,
      });

      // IMPORTANT : un ordre limite qui ne s'exécute pas immédiatement revient avec
      // filledAmount = 0 et status "open" — il ne faut surtout pas le traiter comme rempli
      // (sinon on créditerait/débiterait le wallet pour un échange qui n'a pas eu lieu).
      const isFilled = this.isFilledStatus(result.status) && result.filledAmount > 0;
      let equityAfter: number | null = null;

      if (isFilled) {
        await this.settleWallet(userId, base, quote, params.side, result.filledAmount, result.averagePrice ?? params.price ?? 0, order.id);
        equityAfter = await this.riskService.computeCurrentEquity(userId);
      }

      return this.prisma.order.update({
        where: { id: order.id },
        data: {
          exchangeOrderId: result.exchangeOrderId,
          exchangeStatus: result.status,
          filledQty: result.filledAmount,
          avgPrice: result.averagePrice,
          status: isFilled ? 'filled' : 'open',
          equityAfter,
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Erreur exchange inconnue';
      return this.prisma.order.update({
        where: { id: order.id },
        data: { status: 'failed', errorMessage: message },
      });
    }
  }

  private isFilledStatus(status: string): boolean {
    return ['closed', 'filled'].includes(status.toLowerCase());
  }

  private async settleWallet(
    userId: string,
    base: string,
    quote: string,
    side: 'buy' | 'sell',
    filledQty: number,
    avgPrice: number,
    orderId: string,
  ) {
    const cost = filledQty * avgPrice;
    if (side === 'buy') {
      if (cost > 0) await this.walletService.debit(userId, quote, cost, 'trade_pnl', orderId);
      await this.walletService.credit(userId, base, filledQty, 'trade_pnl', orderId);
    } else {
      await this.walletService.debit(userId, base, filledQty, 'trade_pnl', orderId);
      if (cost > 0) await this.walletService.credit(userId, quote, cost, 'trade_pnl', orderId);
    }
  }

  /** Annule un ordre limite encore ouvert (non rempli) sur l'exchange. */
  async cancelOrder(userId: string, orderId: string) {
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!order) throw new NotFoundException('Ordre introuvable');
    if (order.userId !== userId) throw new ForbiddenException();
    if (order.status !== 'open') {
      throw new BadRequestException(`Impossible d'annuler un ordre au statut "${order.status}"`);
    }
    await this.exchangeService.getConnector().cancelOrder(order.exchangeOrderId!, order.symbol);
    return this.prisma.order.update({ where: { id: orderId }, data: { status: 'cancelled' } });
  }

  /** Interroge l'exchange pour voir si un ordre limite ouvert a fini par se remplir. */
  async syncOrder(userId: string, orderId: string) {
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!order) throw new NotFoundException('Ordre introuvable');
    if (order.userId !== userId) throw new ForbiddenException();
    if (order.status !== 'open') return order; // rien à synchroniser

    const result = await this.exchangeService
      .getConnector()
      .fetchOrderStatus(order.exchangeOrderId!, order.symbol);

    if (this.isFilledStatus(result.status) && result.filledAmount > 0) {
      const [base, quote] = this.splitSymbol(order.symbol);
      await this.settleWallet(
        userId,
        base,
        quote,
        order.side as 'buy' | 'sell',
        result.filledAmount,
        result.averagePrice ?? 0,
        order.id,
      );
      const equityAfter = await this.riskService.computeCurrentEquity(userId);
      const filledOrder = await this.prisma.order.update({
        where: { id: orderId },
        data: {
          status: 'filled',
          exchangeStatus: result.status,
          filledQty: result.filledAmount,
          avgPrice: result.averagePrice,
          equityAfter,
        },
      });

      // Ordre limite différé (semi-auto, §4.4) posé avec un stop-loss : maintenant qu'il est
      // rempli, on ouvre la Position surveillée — jamais fait à la pose pour ne pas suivre
      // un trade qui n'existe pas encore.
      if (order.side === 'buy' && order.stopLoss) {
        await this.positionService.openPosition({
          userId,
          symbol: order.symbol,
          qty: result.filledAmount,
          entryPrice: result.averagePrice ?? Number(order.price ?? 0),
          stopLoss: Number(order.stopLoss),
          takeProfit: order.takeProfit ? Number(order.takeProfit) : undefined,
          entryOrderId: order.id,
        });
      }

      return filledOrder;
    }
    return this.prisma.order.update({ where: { id: orderId }, data: { exchangeStatus: result.status } });
  }

  async listOrders(userId: string) {
    return this.prisma.order.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
  }
}
