import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { AuthService } from './auth.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { Verify2faDto } from './dto/verify-2fa.dto';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { CurrentUser, AuthenticatedUser } from './decorators/current-user.decorator';

@Controller('auth')
export class AuthController {
  constructor(private authService: AuthService) {}

  @Post('register')
  register(@Body() dto: RegisterDto) {
    return this.authService.register(dto);
  }

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
}
