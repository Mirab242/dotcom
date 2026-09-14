import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';
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
import { KycModule } from './kyc/kyc.module';
import { AppController } from './app.controller';

@Module({
  controllers: [AppController],
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    // Limite par défaut : 60 requêtes / minute / IP sur toute l'API. Les routes sensibles
    // (login, register, 2FA, retraits) ont une limite plus stricte via @Throttle() sur le
    // contrôleur — sans ça, le login et la vérification 2FA sont brute-forçables sans limite.
    ThrottlerModule.forRoot([{ ttl: 60000, limit: 60 }]),
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
    KycModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
