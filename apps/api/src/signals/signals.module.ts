import { Module } from '@nestjs/common';
import { MarketModule } from '../market/market.module';
import { SignalsController } from './signals.controller';
import { SignalsService } from './signals.service';

@Module({
  imports: [MarketModule],
  controllers: [SignalsController],
  providers: [SignalsService],
  exports: [SignalsService],
})
export class SignalsModule {}
