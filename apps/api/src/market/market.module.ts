import { Module } from '@nestjs/common';
import { ExchangeModule } from '../exchange/exchange.module';
import { MarketController } from './market.controller';
import { MarketService } from './market.service';
import { MarketGateway } from './market.gateway';

@Module({
  imports: [ExchangeModule],
  controllers: [MarketController],
  providers: [MarketService, MarketGateway],
  exports: [MarketService],
})
export class MarketModule {}
