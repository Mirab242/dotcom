import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { runBacktest } from '@dot-trader/trading-engine';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { MarketService } from '../market/market.service';
import { RunBacktestDto } from './dto/run-backtest.dto';

@Controller('backtest')
@UseGuards(JwtAuthGuard)
export class BacktestController {
  constructor(private marketService: MarketService) {}

  @Post('run')
  async run(@Body() dto: RunBacktestDto) {
    const symbol = dto.symbol ?? 'DOT/USDT';
    const timeframe = dto.timeframe ?? '15m';
    const limit = dto.limit ?? 300;

    const candles = await this.marketService.getAndStoreCandles(symbol, timeframe, limit);

    const result = runBacktest(candles, { minConfidence: dto.minConfidence ?? 60 });

    return { symbol, timeframe, candleCount: candles.length, ...result };
  }
}
