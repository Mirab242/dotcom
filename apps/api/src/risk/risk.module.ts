import { Module } from '@nestjs/common';
import { ExchangeModule } from '../exchange/exchange.module';
import { WalletModule } from '../wallet/wallet.module';
import { RiskService } from './risk.service';
import { RiskController } from './risk.controller';

@Module({
  imports: [ExchangeModule, WalletModule],
  controllers: [RiskController],
  providers: [RiskService],
  exports: [RiskService],
})
export class RiskModule {}
