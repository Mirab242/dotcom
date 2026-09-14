import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { Role } from '@dot-trader/shared-types';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser, AuthenticatedUser } from '../auth/decorators/current-user.decorator';
import { CustodyService } from '../custody/custody.service';
import { KycService } from '../kyc/kyc.service';
import { AdminService } from './admin.service';
import { SetUserStatusDto } from './dto/set-user-status.dto';
import { SetUserRoleDto } from './dto/set-user-role.dto';
import { SetUserSubscriptionDto } from './dto/set-user-subscription.dto';
import { AdjustWalletDto } from './dto/adjust-wallet.dto';
import { RejectKycDto } from './dto/reject-kyc.dto';

@Controller('admin')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
export class AdminController {
  constructor(
    private adminService: AdminService,
    private custodyService: CustodyService,
    private kycService: KycService,
  ) {}

  @Get('stats')
  getStats() {
    return this.adminService.getStats();
  }

  @Get('audit-logs')
  listAuditLogs(@Query('limit') limit?: string) {
    return this.adminService.listAuditLogs(limit ? Number(limit) : undefined);
  }

  @Get('bots')
  listBots() {
    return this.adminService.listAllBots();
  }

  @Get('reconciliation')
  getReconciliation() {
    return this.adminService.getReconciliation();
  }

  @Get('users')
  listUsers() {
    return this.adminService.listUsers();
  }

  @Patch('users/:id/status')
  setUserStatus(@CurrentUser() admin: AuthenticatedUser, @Param('id') id: string, @Body() dto: SetUserStatusDto) {
    return this.adminService.setUserStatus(admin.userId, id, dto.status);
  }

  @Patch('users/:id/role')
  setUserRole(@CurrentUser() admin: AuthenticatedUser, @Param('id') id: string, @Body() dto: SetUserRoleDto) {
    return this.adminService.setUserRole(admin.userId, id, dto.role);
  }

  @Patch('users/:id/subscription')
  setUserSubscription(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: SetUserSubscriptionDto,
  ) {
    return this.adminService.setUserSubscription(admin.userId, id, dto.subscriptionTier);
  }

  @Post('users/:id/wallet-adjustment')
  adjustWallet(@CurrentUser() admin: AuthenticatedUser, @Param('id') id: string, @Body() dto: AdjustWalletDto) {
    return this.adminService.adjustWallet(admin.userId, id, dto);
  }

  @Delete('users/:id')
  deleteUser(@CurrentUser() admin: AuthenticatedUser, @Param('id') id: string) {
    return this.adminService.deleteUser(admin.userId, id);
  }

  @Get('deposits')
  listDeposits(@Query('status') status?: string) {
    return this.custodyService.listAllDeposits(status);
  }

  @Post('deposits/:id/credit')
  creditDeposit(@CurrentUser() admin: AuthenticatedUser, @Param('id') id: string) {
    return this.custodyService.creditDeposit(admin.userId, id);
  }

  @Post('deposits/:id/reject')
  rejectDeposit(@CurrentUser() admin: AuthenticatedUser, @Param('id') id: string) {
    return this.custodyService.rejectDeposit(admin.userId, id);
  }

  @Get('withdrawals')
  listWithdrawals(@Query('status') status?: string) {
    return this.custodyService.listAllWithdrawals(status);
  }

  @Post('withdrawals/:id/approve')
  approveWithdrawal(@CurrentUser() admin: AuthenticatedUser, @Param('id') id: string) {
    return this.custodyService.approveWithdrawal(admin.userId, id);
  }

  @Post('withdrawals/:id/reject')
  rejectWithdrawal(@CurrentUser() admin: AuthenticatedUser, @Param('id') id: string) {
    return this.custodyService.rejectWithdrawal(admin.userId, id);
  }

  @Get('kyc')
  listKyc() {
    return this.kycService.listPending();
  }

  @Get('kyc/:id/document')
  getKycDocument(@Param('id') id: string) {
    return this.kycService.getSubmissionDocument(id);
  }

  @Post('kyc/:id/approve')
  approveKyc(@CurrentUser() admin: AuthenticatedUser, @Param('id') id: string) {
    return this.kycService.approve(admin.userId, id);
  }

  @Post('kyc/:id/reject')
  rejectKyc(@CurrentUser() admin: AuthenticatedUser, @Param('id') id: string, @Body() dto: RejectKycDto) {
    return this.kycService.reject(admin.userId, id, dto.reason);
  }
}
