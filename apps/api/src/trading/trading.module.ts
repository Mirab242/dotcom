import { Module } from '@nestjs/common';
import { ExchangeModule } from '../exchange/exchange.module';
import { WalletModule } from '../wallet/wallet.module';
import { RiskModule } from '../risk/risk.module';
import { PositionModule } from '../position/position.module';
import { TradingService } from './trading.service';
import { TradingController } from './trading.controller';

@Module({
  imports: [ExchangeModule, WalletModule, RiskModule, PositionModule],
  controllers: [TradingController],
  providers: [TradingService],
  exports: [TradingService],
})
export class TradingModule {}
