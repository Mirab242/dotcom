import { Module } from '@nestjs/common';
import { CustodyModule } from '../custody/custody.module';
import { WalletModule } from '../wallet/wallet.module';
import { AdminService } from './admin.service';
import { AdminController } from './admin.controller';

@Module({
  imports: [CustodyModule, WalletModule],
  controllers: [AdminController],
  providers: [AdminService],
})
export class AdminModule {}
