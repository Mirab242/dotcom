import { ForbiddenException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ExchangeService } from '../exchange/exchange.service';
import { WalletService } from '../wallet/wallet.service';

const SETTINGS_ID = 'global';

@Injectable()
export class RiskService {
  constructor(
    private prisma: PrismaService,
    private exchangeService: ExchangeService,
    private walletService: WalletService,
  ) {}

  private async getOrCreateSettings() {
    return this.prisma.systemSetting.upsert({
      where: { id: SETTINGS_ID },
      update: {},
      create: { id: SETTINGS_ID },
    });
  }

  async getKillSwitchStatus() {
    const settings = await this.getOrCreateSettings();
    return { enabled: settings.killSwitchEnabled, reason: settings.killSwitchReason, updatedAt: settings.updatedAt };
  }

  async setKillSwitch(enabled: boolean, reason: string | undefined, actorId: string) {
    const settings = await this.prisma.systemSetting.upsert({
      where: { id: SETTINGS_ID },
      update: { killSwitchEnabled: enabled, killSwitchReason: enabled ? reason ?? null : null },
      create: { id: SETTINGS_ID, killSwitchEnabled: enabled, killSwitchReason: enabled ? reason ?? null : null },
    });
    await this.prisma.auditLog.create({
      data: {
        actorId,
        action: enabled ? 'kill_switch.enabled' : 'kill_switch.disabled',
        target: 'platform',
        metadata: JSON.stringify({ reason: reason ?? null }),
      },
    });
    return { enabled: settings.killSwitchEnabled, reason: settings.killSwitchReason, updatedAt: settings.updatedAt };
  }

  async getLimits() {
    const settings = await this.getOrCreateSettings();
    return {
      maxDailyLossPercent: Number(settings.maxDailyLossPercent),
      maxDrawdownPercent: Number(settings.maxDrawdownPercent),
    };
  }

  async setLimits(input: { maxDailyLossPercent?: number; maxDrawdownPercent?: number }, actorId: string) {
    const data: Record<string, number> = {};
    if (input.maxDailyLossPercent !== undefined) data.maxDailyLossPercent = input.maxDailyLossPercent;
    if (input.maxDrawdownPercent !== undefined) data.maxDrawdownPercent = input.maxDrawdownPercent;

    const settings = await this.prisma.systemSetting.upsert({
      where: { id: SETTINGS_ID },
      update: data,
      create: { id: SETTINGS_ID, ...data },
    });
    await this.prisma.auditLog.create({
      data: { actorId, action: 'risk_limits.updated', target: 'platform', metadata: JSON.stringify(input) },
    });
    return this.getLimits();
  }

  /**
   * Équité du compte en USDT : solde USDT + valeur au marché de CHAQUE autre devise détenue
   * (BTC, ETH, SOL, DOT, ...) — générique, ne suppose plus un seul actif "non-USDT" possible.
   */
  async computeCurrentEquity(userId: string): Promise<number> {
    const wallets = await this.walletService.listWallets(userId);
    const usdtWallet = wallets.find((w) => w.currency === 'USDT');
    let equity = usdtWallet ? Number(usdtWallet.availableBalance) + Number(usdtWallet.lockedBalance) : 0;

    const otherWallets = wallets.filter((w) => w.currency !== 'USDT' && Number(w.availableBalance) + Number(w.lockedBalance) > 0);
    const prices = await Promise.all(
      otherWallets.map(async (w) => {
        try {
          const [lastCandle] = await this.exchangeService.getConnector().getCandles(`${w.currency}/USDT`, '1m', 1);
          return lastCandle?.close ?? 0;
        } catch {
          return 0; // paire non cotée contre USDT — ignorée plutôt que de faire échouer le calcul d'équité
        }
      }),
    );
    otherWallets.forEach((w, i) => {
      equity += (Number(w.availableBalance) + Number(w.lockedBalance)) * prices[i];
    });

    return equity;
  }

  /** Statut de risque complet pour un utilisateur — utilisé par le garde-fou et exposé à l'UI pour la transparence (§4.5). */
  async getRiskStatus(userId: string) {
    const [limits, currentEquity, peakOrder, todayBaselineOrder] = await Promise.all([
      this.getLimits(),
      this.computeCurrentEquity(userId),
      this.prisma.order.findFirst({
        where: { userId, status: 'filled', equityAfter: { not: null } },
        orderBy: { equityAfter: 'desc' },
      }),
      this.prisma.order.findFirst({
        where: { userId, status: 'filled', equityAfter: { not: null }, createdAt: { lt: this.startOfUtcDay() } },
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    const peakEquity = peakOrder ? Math.max(Number(peakOrder.equityAfter), currentEquity) : currentEquity;
    const dailyBaseline = todayBaselineOrder ? Number(todayBaselineOrder.equityAfter) : currentEquity;

    const drawdownPct = peakEquity > 0 ? ((peakEquity - currentEquity) / peakEquity) * 100 : 0;
    const dailyLossPct = dailyBaseline > 0 ? ((dailyBaseline - currentEquity) / dailyBaseline) * 100 : 0;

    return {
      currentEquity,
      peakEquity,
      dailyBaseline,
      drawdownPct: Math.max(0, drawdownPct),
      dailyLossPct: Math.max(0, dailyLossPct),
      limits,
      drawdownBreached: drawdownPct >= limits.maxDrawdownPercent,
      dailyLossBreached: dailyLossPct >= limits.maxDailyLossPercent,
    };
  }

  private startOfUtcDay(): Date {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  }

  /** À appeler avant tout passage d'ordre (manuel, assisté ou auto). */
  async assertTradingAllowed(userId: string) {
    const settings = await this.getOrCreateSettings();
    if (settings.killSwitchEnabled) {
      throw new ForbiddenException(
        `Trading suspendu par l'administrateur${settings.killSwitchReason ? ` : ${settings.killSwitchReason}` : ''}`,
      );
    }

    const status = await this.getRiskStatus(userId);
    if (status.drawdownBreached) {
      await this.logRiskBlock(userId, 'max_drawdown', status);
      throw new ForbiddenException(
        `Trading bloqué : drawdown du compte (${status.drawdownPct.toFixed(1)}%) au-delà de la limite (${status.limits.maxDrawdownPercent}%)`,
      );
    }
    if (status.dailyLossBreached) {
      await this.logRiskBlock(userId, 'max_daily_loss', status);
      throw new ForbiddenException(
        `Trading bloqué : perte journalière (${status.dailyLossPct.toFixed(1)}%) au-delà de la limite (${status.limits.maxDailyLossPercent}%)`,
      );
    }
  }

  private async logRiskBlock(userId: string, reason: string, status: unknown) {
    // Sert d'alerte admin en l'absence de canal de notification temps réel (§4.9 pas encore construit) —
    // consultable via GET /users/:id ou une future vue "logs" admin.
    await this.prisma.auditLog.create({
      data: { actorId: userId, action: `risk.blocked.${reason}`, target: userId, metadata: JSON.stringify(status) },
    });
  }
}
