import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser, AuthenticatedUser } from '../auth/decorators/current-user.decorator';
import { CustodyService } from './custody.service';
import { CreateDepositDto } from './dto/create-deposit.dto';
import { CreateWithdrawalDto } from './dto/create-withdrawal.dto';

@Controller('wallet')
@UseGuards(JwtAuthGuard)
export class CustodyController {
  constructor(private custodyService: CustodyService) {}

  @Post('deposits')
  createDeposit(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateDepositDto) {
    return this.custodyService.createDeposit(user.userId, dto);
  }

  @Get('deposits')
  listDeposits(@CurrentUser() user: AuthenticatedUser) {
    return this.custodyService.listDepositsForUser(user.userId);
  }

  @Post('withdrawals')
  createWithdrawal(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateWithdrawalDto) {
    return this.custodyService.createWithdrawal(user.userId, dto);
  }

  @Get('withdrawals')
  listWithdrawals(@CurrentUser() user: AuthenticatedUser) {
    return this.custodyService.listWithdrawalsForUser(user.userId);
  }
}
