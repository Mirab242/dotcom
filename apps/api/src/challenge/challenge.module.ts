import { Module } from '@nestjs/common';
import { ExchangeModule } from '../exchange/exchange.module';
import { WalletModule } from '../wallet/wallet.module';
import { ChallengeService } from './challenge.service';
import { ChallengeController } from './challenge.controller';
import { ChallengeAdminController } from './challenge-admin.controller';

@Module({
  imports: [ExchangeModule, WalletModule],
  controllers: [ChallengeController, ChallengeAdminController],
  providers: [ChallengeService],
  exports: [ChallengeService],
})
export class ChallengeModule {}
