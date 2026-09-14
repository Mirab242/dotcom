import { Injectable } from '@nestjs/common';
import { Candle } from '@dot-trader/shared-types';
import { Timeframe } from '@dot-trader/exchange-connectors';
import { PrismaService } from '../prisma/prisma.service';
import { ExchangeService } from '../exchange/exchange.service';

@Injectable()
export class MarketService {
  constructor(
    private prisma: PrismaService,
    private exchangeService: ExchangeService,
  ) {}

  /** Va chercher les bougies live chez l'exchange, ET les persiste (upsert) pour le backtesting. */
  async getAndStoreCandles(symbol: string, timeframe: Timeframe, limit: number): Promise<Candle[]> {
    const candles = await this.exchangeService.getConnector().getCandles(symbol, timeframe, limit);

    await Promise.all(
      candles.map((c) =>
        this.prisma.candle.upsert({
          where: { symbol_timeframe_ts: { symbol, timeframe, ts: Math.floor(c.ts / 1000) } },
          update: { open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume },
          create: {
            symbol,
            timeframe,
            ts: Math.floor(c.ts / 1000),
            open: c.open,
            high: c.high,
            low: c.low,
            close: c.close,
            volume: c.volume,
          },
        }),
      ),
    );

    return candles;
  }

  /** Lit uniquement depuis le stockage local (utilisé par le backtesting — pas d'appel exchange). */
  async getStoredCandles(symbol: string, timeframe: Timeframe, limit: number): Promise<Candle[]> {
    const rows = await this.prisma.candle.findMany({
      where: { symbol, timeframe },
      orderBy: { ts: 'desc' },
      take: limit,
    });
    return rows
      .reverse()
      .map((r) => ({
        ts: r.ts * 1000,
        open: Number(r.open),
        high: Number(r.high),
        low: Number(r.low),
        close: Number(r.close),
        volume: Number(r.volume),
      }));
  }
}
