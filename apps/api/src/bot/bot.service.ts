import { ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Timeframe } from '@dot-trader/exchange-connectors';
import { PrismaService } from '../prisma/prisma.service';
import { SignalsService } from '../signals/signals.service';
import { TradingService } from '../trading/trading.service';
import { UpsertBotInstanceDto } from './dto/upsert-bot-instance.dto';

const TIMEFRAME_MINUTES: Record<string, number> = { '5m': 5, '15m': 15, '1h': 60, '4h': 240 };

/**
 * Mode automatique (§4.4/§4.8) : consomme les mêmes signaux que le mode assisté et exécute
 * sans validation humaine. Toujours derrière le kill switch et les limites de risque
 * (RiskService, appelé depuis TradingService.executeSignal) — aucune logique de risque dupliquée ici.
 */
@Injectable()
export class BotService {
  private readonly logger = new Logger(BotService.name);

  constructor(
    private prisma: PrismaService,
    private signalsService: SignalsService,
    private tradingService: TradingService,
  ) {}

  async listForUser(userId: string) {
    return this.prisma.botInstance.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } });
  }

  async upsertForUser(userId: string, dto: UpsertBotInstanceDto) {
    const symbol = dto.symbol ?? 'DOT/USDT';
    return this.prisma.botInstance.upsert({
      where: { userId_symbol: { userId, symbol } },
      update: {
        timeframe: dto.timeframe,
        higherTimeframe: dto.higherTimeframe,
        minConfidence: dto.minConfidence,
        riskPercent: dto.riskPercent,
      },
      create: {
        userId,
        symbol,
        timeframe: dto.timeframe ?? '15m',
        higherTimeframe: dto.higherTimeframe ?? '4h',
        minConfidence: dto.minConfidence ?? 70,
        riskPercent: dto.riskPercent ?? 1,
      },
    });
  }

  async setEnabled(userId: string, id: string, enabled: boolean) {
    const bot = await this.prisma.botInstance.findUnique({ where: { id } });
    if (!bot || bot.userId !== userId) throw new NotFoundException('Bot introuvable');

    if (enabled) {
      // Monétisation (§4.10) : le mode automatique est une fonctionnalité tier "pro" — pas de
      // processeur de paiement tant que le cadre légal n'est pas tranché (§8), le tier est
      // assigné manuellement par un admin (voir AdminModule), mais le gate est réel.
      const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
      if (user.subscriptionTier !== 'pro') {
        throw new ForbiddenException(
          "Le mode automatique est réservé aux comptes Pro — passez votre compte en Pro (ou demandez-le à un admin) pour l'activer",
        );
      }
    }

    return this.prisma.botInstance.update({ where: { id }, data: { enabled } });
  }

  /** Déclenchement manuel immédiat (bouton "Exécuter maintenant" côté UI, ou tests). */
  async runNow(userId: string, id: string) {
    const bot = await this.prisma.botInstance.findUnique({ where: { id } });
    if (!bot || bot.userId !== userId) throw new NotFoundException('Bot introuvable');
    return this.evaluateBot(bot);
  }

  /** Job planifié — évalue tous les bots actifs, toutes les minutes. */
  @Cron(CronExpression.EVERY_MINUTE)
  async runScheduledEvaluation() {
    const bots = await this.prisma.botInstance.findMany({ where: { enabled: true } });
    for (const bot of bots) {
      try {
        await this.evaluateBot(bot);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Erreur inconnue';
        this.logger.warn(`Bot ${bot.id} (${bot.symbol}) — évaluation échouée : ${message}`);
        await this.prisma.botInstance
          .update({ where: { id: bot.id }, data: { lastRunAt: new Date(), lastError: message } })
          .catch(() => undefined);
      }
    }
  }

  private async evaluateBot(bot: { id: string; userId: string; symbol: string; timeframe: string; higherTimeframe: string; minConfidence: number; riskPercent: unknown; lastSignalAt: Date | null }) {
    const cooldownMs = (TIMEFRAME_MINUTES[bot.timeframe] ?? 15) * 60 * 1000;
    if (bot.lastSignalAt && Date.now() - bot.lastSignalAt.getTime() < cooldownMs) {
      await this.prisma.botInstance.update({ where: { id: bot.id }, data: { lastRunAt: new Date() } });
      return { skipped: 'cooldown' };
    }

    const openOrder = await this.prisma.order.findFirst({
      where: { userId: bot.userId, symbol: bot.symbol, status: { in: ['pending', 'open'] } },
    });
    if (openOrder) {
      await this.prisma.botInstance.update({ where: { id: bot.id }, data: { lastRunAt: new Date() } });
      return { skipped: 'order_in_flight' };
    }

    const signal = await this.signalsService.getSignal(
      bot.symbol,
      bot.timeframe as Timeframe,
      bot.higherTimeframe as Timeframe,
      bot.minConfidence,
    );

    if (!signal) {
      await this.prisma.botInstance.update({ where: { id: bot.id }, data: { lastRunAt: new Date(), lastError: null } });
      return { skipped: 'no_signal' };
    }

    const order = await this.tradingService.executeSignal(
      bot.userId,
      {
        symbol: signal.symbol,
        side: signal.side,
        entry: signal.entry,
        stopLoss: signal.stopLoss,
        takeProfit: signal.takeProfits[0],
        riskPercent: Number(bot.riskPercent),
      },
      'auto',
    );

    await this.prisma.botInstance.update({
      where: { id: bot.id },
      data: { lastRunAt: new Date(), lastSignalAt: new Date(), lastSignalSide: signal.side, lastError: null },
    });

    this.logger.log(`Bot ${bot.id} (${bot.symbol}) — signal ${signal.side} exécuté, ordre ${order.id}`);
    return { executed: true, order };
  }
}
