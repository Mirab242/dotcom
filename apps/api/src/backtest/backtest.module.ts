import { Module } from '@nestjs/common';
import { MarketModule } from '../market/market.module';
import { BacktestController } from './backtest.controller';

@Module({
  imports: [MarketModule],
  controllers: [BacktestController],
})
export class BacktestModule {}
