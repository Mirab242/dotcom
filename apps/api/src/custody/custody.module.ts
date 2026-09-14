import { Module } from '@nestjs/common';
import { WalletModule } from '../wallet/wallet.module';
import { CustodyService } from './custody.service';
import { CustodyController } from './custody.controller';

@Module({
  imports: [WalletModule],
  controllers: [CustodyController],
  providers: [CustodyService],
  exports: [CustodyService],
})
export class CustodyModule {}
