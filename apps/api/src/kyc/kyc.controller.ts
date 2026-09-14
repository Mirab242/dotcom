import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser, AuthenticatedUser } from '../auth/decorators/current-user.decorator';
import { KycService } from './kyc.service';
import { SubmitKycDto } from './dto/submit-kyc.dto';

@Controller('kyc')
@UseGuards(JwtAuthGuard)
export class KycController {
  constructor(private kycService: KycService) {}

  @Post()
  submit(@CurrentUser() user: AuthenticatedUser, @Body() dto: SubmitKycDto) {
    return this.kycService.submit(user.userId, dto);
  }

  @Get('me')
  getMine(@CurrentUser() user: AuthenticatedUser) {
    return this.kycService.getMine(user.userId);
  }
}
