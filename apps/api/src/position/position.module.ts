import { Module } from '@nestjs/common';
import { ExchangeModule } from '../exchange/exchange.module';
import { WalletModule } from '../wallet/wallet.module';
import { RiskModule } from '../risk/risk.module';
import { PositionService } from './position.service';
import { PositionController } from './position.controller';

@Module({
  imports: [ExchangeModule, WalletModule, RiskModule],
  controllers: [PositionController],
  providers: [PositionService],
  exports: [PositionService],
})
export class PositionModule {}
