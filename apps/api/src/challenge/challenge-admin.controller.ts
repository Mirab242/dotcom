import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { Role } from '@dot-trader/shared-types';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser, AuthenticatedUser } from '../auth/decorators/current-user.decorator';
import { ChallengeService } from './challenge.service';
import { CreateChallengePlanDto, UpdateChallengePlanDto } from './dto/upsert-challenge-plan.dto';
import { ReasonDto } from './dto/reason.dto';
import { SetPaymentsEnabledDto } from './dto/set-payments-enabled.dto';

@Controller('admin/challenges')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
export class ChallengeAdminController {
  constructor(private challengeService: ChallengeService) {}

  @Get('settings')
  getSettings() {
    return this.challengeService.getPaymentsStatus();
  }

  @Patch('settings/payments')
  setPaymentsEnabled(@CurrentUser() admin: AuthenticatedUser, @Body() dto: SetPaymentsEnabledDto) {
    return this.challengeService.setPaymentsEnabled(admin.userId, dto);
  }

  @Get('plans')
  listPlans() {
    return this.challengeService.listPlansAdmin();
  }

  @Post('plans')
  createPlan(@CurrentUser() admin: AuthenticatedUser, @Body() dto: CreateChallengePlanDto) {
    return this.challengeService.createPlan(admin.userId, dto);
  }

  @Patch('plans/:id')
  updatePlan(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateChallengePlanDto,
  ) {
    return this.challengeService.updatePlan(admin.userId, id, dto);
  }

  @Get('accounts')
  listAccounts(@Query('status') status?: string) {
    return this.challengeService.listAccountsAdmin(status);
  }

  @Post('accounts/:id/close')
  closeAccount(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReasonDto,
  ) {
    return this.challengeService.closeAccountAdmin(admin.userId, id, dto.reason);
  }

  @Get('payouts')
  listPayouts(@Query('status') status?: string) {
    return this.challengeService.listPayoutsAdmin(status);
  }

  @Post('payouts/:id/approve')
  approvePayout(@CurrentUser() admin: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.challengeService.approvePayout(admin.userId, id);
  }

  @Post('payouts/:id/reject')
  rejectPayout(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReasonDto,
  ) {
    return this.challengeService.rejectPayout(admin.userId, id, dto.reason);
  }
}
