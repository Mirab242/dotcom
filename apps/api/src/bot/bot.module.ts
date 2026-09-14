import { Module } from '@nestjs/common';
import { SignalsModule } from '../signals/signals.module';
import { TradingModule } from '../trading/trading.module';
import { BotService } from './bot.service';
import { BotController } from './bot.controller';

@Module({
  imports: [SignalsModule, TradingModule],
  controllers: [BotController],
  providers: [BotService],
})
export class BotModule {}
