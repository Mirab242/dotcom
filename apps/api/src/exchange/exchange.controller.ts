import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { Role } from '@dot-trader/shared-types';
import { Timeframe } from '@dot-trader/exchange-connectors';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { ExchangeService } from './exchange.service';

// Toutes les routes réservées ADMIN pour l'instant : en Phase 0, seul un test
// d'infrastructure interne, pas encore une fonctionnalité exposée aux utilisateurs.
@Controller('exchange')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
export class ExchangeController {
  constructor(private exchangeService: ExchangeService) {}

  @Get('test-connection')
  async testConnection() {
    const ok = await this.exchangeService.getConnector().testConnection();
    return { exchange: 'binance', mode: 'testnet', connected: ok };
  }

  @Get('candles')
  async getCandles(
    @Query('symbol') symbol = 'DOT/USDT',
    @Query('timeframe') timeframe: Timeframe = '1h',
    @Query('limit') limit?: string,
  ) {
    const candles = await this.exchangeService
      .getConnector()
      .getCandles(symbol, timeframe, limit ? Number(limit) : undefined);
    return { symbol, timeframe, count: candles.length, candles };
  }
}
