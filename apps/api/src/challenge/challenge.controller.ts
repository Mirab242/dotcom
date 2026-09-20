import { Body, Controller, Get, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser, AuthenticatedUser } from '../auth/decorators/current-user.decorator';
import { ChallengeService } from './challenge.service';
import { CreateChallengeAccountDto } from './dto/create-challenge-account.dto';
import { PlaceChallengeOrderDto } from './dto/place-challenge-order.dto';
import { RequestChallengePayoutDto } from './dto/request-challenge-payout.dto';

@Controller('challenges')
@UseGuards(JwtAuthGuard)
export class ChallengeController {
  constructor(private challengeService: ChallengeService) {}

  @Get('plans')
  listPlans() {
    return this.challengeService.listPlans();
  }

  // Débite des frais (quand l'argent réel est activé) : pas un endpoint à laisser spammable.
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @Post('accounts')
  createAccount(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateChallengeAccountDto) {
    return this.challengeService.createAccount(user.userId, dto);
  }

  @Get('accounts')
  listAccounts(@CurrentUser() user: AuthenticatedUser) {
    return this.challengeService.listAccounts(user.userId);
  }

  @Get('accounts/:id')
  getAccount(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.challengeService.getAccount(user.userId, id);
  }

  @Throttle({ default: { limit: 30, ttl: 60000 } })
  @Post('accounts/:id/orders')
  openPosition(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PlaceChallengeOrderDto,
  ) {
    return this.challengeService.openPosition(user.userId, id, dto);
  }

  @Throttle({ default: { limit: 30, ttl: 60000 } })
  @Post('accounts/:id/positions/:positionId/close')
  closePosition(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('positionId', ParseUUIDPipe) positionId: string,
  ) {
    return this.challengeService.closePosition(user.userId, id, positionId);
  }

  // Limite basse : chaque demande réserve du profit et déclenche un flux d'argent hors plateforme.
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @Post('accounts/:id/payouts')
  requestPayout(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RequestChallengePayoutDto,
  ) {
    return this.challengeService.requestPayout(user.userId, id, dto);
  }

  @Get('payouts')
  listPayouts(@CurrentUser() user: AuthenticatedUser) {
    return this.challengeService.listPayouts(user.userId);
  }
}
