import { Body, Controller, Param, Post, Get, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser, AuthenticatedUser } from '../auth/decorators/current-user.decorator';
import { BotService } from './bot.service';
import { UpsertBotInstanceDto } from './dto/upsert-bot-instance.dto';
import { ToggleBotInstanceDto } from './dto/toggle-bot-instance.dto';

@Controller('bot/instances')
@UseGuards(JwtAuthGuard)
export class BotController {
  constructor(private botService: BotService) {}

  @Get()
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.botService.listForUser(user.userId);
  }

  @Post()
  upsert(@CurrentUser() user: AuthenticatedUser, @Body() dto: UpsertBotInstanceDto) {
    return this.botService.upsertForUser(user.userId, dto);
  }

  @Post(':id/toggle')
  toggle(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() dto: ToggleBotInstanceDto) {
    return this.botService.setEnabled(user.userId, id, dto.enabled);
  }

  @Post(':id/run-now')
  runNow(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.botService.runNow(user.userId, id);
  }
}
