import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { ExchangeModule } from './exchange/exchange.module';
import { MarketModule } from './market/market.module';
import { TradingModule } from './trading/trading.module';
import { WalletModule } from './wallet/wallet.module';
import { SignalsModule } from './signals/signals.module';
import { BacktestModule } from './backtest/backtest.module';
import { RiskModule } from './risk/risk.module';
import { BotModule } from './bot/bot.module';
import { PositionModule } from './position/position.module';
import { CustodyModule } from './custody/custody.module';
import { AdminModule } from './admin/admin.module';
import { AppController } from './app.controller';

@Module({
  controllers: [AppController],
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    PrismaModule,
    AuthModule,
    UsersModule,
    ExchangeModule,
    MarketModule,
    TradingModule,
    WalletModule,
    SignalsModule,
    BacktestModule,
    RiskModule,
    BotModule,
    PositionModule,
    CustodyModule,
    AdminModule,
  ],
})
export class AppModule {}
