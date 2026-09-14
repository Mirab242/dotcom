import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { Timeframe } from '@dot-trader/exchange-connectors';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { MarketService } from './market.service';

/**
 * Données de marché — accessibles à tout utilisateur connecté (pas réservé admin,
 * contrairement à /exchange qui reste un outil de diagnostic interne).
 * Chaque appel va chercher les données live ET les persiste (voir MarketService).
 */
@Controller('market')
@UseGuards(JwtAuthGuard)
export class MarketController {
  constructor(private marketService: MarketService) {}

  @Get('candles')
  async getCandles(
    @Query('symbol') symbol = 'DOT/USDT',
    @Query('timeframe') timeframe: Timeframe = '1h',
    @Query('limit') limit?: string,
  ) {
    const candles = await this.marketService.getAndStoreCandles(
      symbol,
      timeframe,
      limit ? Number(limit) : 60,
    );
    return { symbol, timeframe, candles };
  }
}
