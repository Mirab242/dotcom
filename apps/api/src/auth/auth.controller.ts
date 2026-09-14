import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AuthService } from './auth.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { Verify2faDto } from './dto/verify-2fa.dto';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { CurrentUser, AuthenticatedUser } from './decorators/current-user.decorator';

@Controller('auth')
export class AuthController {
  constructor(private authService: AuthService) {}

  // 5/min : limite le brute-force du mot de passe ET du code 2FA (vérifié dans le même flux
  // login, voir AuthService.login) — sans ça un TOTP à 6 chiffres est cassable en pratique
  // sur un endpoint non limité une fois le mot de passe connu.
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @Post('register')
  register(@Body() dto: RegisterDto) {
    return this.authService.register(dto);
  }

  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @Post('login')
  login(@Body() dto: LoginDto) {
    return this.authService.login(dto);
  }

  @Post('refresh')
  refresh(@Body('refreshToken') refreshToken: string) {
    return this.authService.refresh(refreshToken);
  }

  @UseGuards(JwtAuthGuard)
  @Post('logout')
  logout(@CurrentUser() user: AuthenticatedUser, @Body('refreshToken') refreshToken: string) {
    return this.authService.logout(user.userId, refreshToken);
  }

  @UseGuards(JwtAuthGuard)
  @Post('2fa/setup')
  setup2fa(@CurrentUser() user: AuthenticatedUser) {
    return this.authService.setup2fa(user.userId);
  }

  @UseGuards(JwtAuthGuard)
  @Post('2fa/confirm')
  confirm2fa(@CurrentUser() user: AuthenticatedUser, @Body() dto: Verify2faDto) {
    return this.authService.confirm2fa(user.userId, dto.code);
  }

  /**
   * Promeut le compte connecté en admin — UNIQUEMENT si aucun admin n'existe encore sur cette
   * base. Sert à amorcer le tout premier compte admin sur un déploiement neuf sans avoir besoin
   * d'un accès shell/DB direct (ex: plan Render gratuit, pas de Shell). Se désactive tout seul
   * dès qu'un admin existe — aucune fenêtre d'abus possible après le premier appel réussi.
   */
  @UseGuards(JwtAuthGuard)
  @Post('bootstrap-admin')
  bootstrapAdmin(@CurrentUser() user: AuthenticatedUser) {
    return this.authService.bootstrapAdmin(user.userId);
  }
}
