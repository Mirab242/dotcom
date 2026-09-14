import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { Timeframe } from '@dot-trader/exchange-connectors';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { SignalsService } from './signals.service';

@Controller('signals')
@UseGuards(JwtAuthGuard)
export class SignalsController {
  constructor(private signalsService: SignalsService) {}

  @Get()
  async getSignal(
    @Query('symbol') symbol = 'DOT/USDT',
    @Query('timeframe') timeframe: Timeframe = '15m',
    @Query('higherTimeframe') higherTimeframe: Timeframe = '4h',
    @Query('minConfidence') minConfidence?: string,
  ) {
    const signal = await this.signalsService.getSignal(
      symbol,
      timeframe,
      higherTimeframe,
      minConfidence ? Number(minConfidence) : undefined,
    );

    return { symbol, timeframe, higherTimeframe, signal };
  }
}
