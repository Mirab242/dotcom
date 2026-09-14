import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { TwoFactorService } from './two-factor.service';
import { JwtStrategy } from './strategies/jwt.strategy';
import { WalletModule } from '../wallet/wallet.module';

@Module({
  imports: [PassportModule, JwtModule.register({}), WalletModule],
  controllers: [AuthController],
  providers: [AuthService, TwoFactorService, JwtStrategy],
  exports: [AuthService],
})
export class AuthModule {}
