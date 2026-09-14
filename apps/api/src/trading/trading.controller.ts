import { Body, Controller, Delete, Get, Param, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser, AuthenticatedUser } from '../auth/decorators/current-user.decorator';
import { TradingService } from './trading.service';
import { CreateOrderDto } from './dto/create-order.dto';
import { ExecuteSignalDto } from './dto/execute-signal.dto';

@Controller('trading')
@UseGuards(JwtAuthGuard)
export class TradingController {
  constructor(private tradingService: TradingService) {}

  @Post('orders')
  createOrder(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateOrderDto) {
    return this.tradingService.createOrder(user.userId, dto);
  }

  @Post('execute-signal')
  executeSignal(@CurrentUser() user: AuthenticatedUser, @Body() dto: ExecuteSignalDto) {
    return this.tradingService.executeSignal(user.userId, dto);
  }

  @Get('orders')
  listOrders(@CurrentUser() user: AuthenticatedUser) {
    return this.tradingService.listOrders(user.userId);
  }

  @Delete('orders/:id')
  cancelOrder(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.tradingService.cancelOrder(user.userId, id);
  }

  @Post('orders/:id/sync')
  syncOrder(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.tradingService.syncOrder(user.userId, id);
  }
}
