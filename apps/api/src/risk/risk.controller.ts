import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { Role } from '@dot-trader/shared-types';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser, AuthenticatedUser } from '../auth/decorators/current-user.decorator';
import { RiskService } from './risk.service';
import { SetKillSwitchDto } from './dto/set-kill-switch.dto';
import { SetRiskLimitsDto } from './dto/set-risk-limits.dto';

@Controller('risk')
@UseGuards(JwtAuthGuard)
export class RiskController {
  constructor(private riskService: RiskService) {}

  @Get('kill-switch')
  getKillSwitch() {
    return this.riskService.getKillSwitchStatus();
  }

  @Post('kill-switch')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN)
  setKillSwitch(@CurrentUser() user: AuthenticatedUser, @Body() dto: SetKillSwitchDto) {
    return this.riskService.setKillSwitch(dto.enabled, dto.reason, user.userId);
  }

  @Get('limits')
  getLimits() {
    return this.riskService.getLimits();
  }

  @Post('limits')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN)
  setLimits(@CurrentUser() user: AuthenticatedUser, @Body() dto: SetRiskLimitsDto) {
    return this.riskService.setLimits(dto, user.userId);
  }

  /** Statut de risque du compte courant (équité, drawdown, perte du jour) — transparence §4.5. */
  @Get('status')
  getStatus(@CurrentUser() user: AuthenticatedUser) {
    return this.riskService.getRiskStatus(user.userId);
  }
}
