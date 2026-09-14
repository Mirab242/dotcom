import { Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser, AuthenticatedUser } from '../auth/decorators/current-user.decorator';
import { PositionService } from './position.service';

@Controller('positions')
@UseGuards(JwtAuthGuard)
export class PositionController {
  constructor(private positionService: PositionService) {}

  @Get()
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.positionService.listForUser(user.userId);
  }

  @Post(':id/close')
  close(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.positionService.closeManually(user.userId, id);
  }
}
