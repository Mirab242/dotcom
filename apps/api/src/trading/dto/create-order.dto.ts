import { IsIn, IsNumber, IsOptional, IsPositive } from 'class-validator';
import { SUPPORTED_SYMBOLS } from '@dot-trader/shared-types';

export class CreateOrderDto {
  @IsIn(SUPPORTED_SYMBOLS)
  symbol: string;

  @IsIn(['buy', 'sell'])
  side: 'buy' | 'sell';

  @IsIn(['market', 'limit'])
  type: 'market' | 'limit';

  @IsNumber()
  @IsPositive()
  qty: number;

  @IsOptional()
  @IsNumber()
  @IsPositive()
  price?: number; // requis si type === 'limit'
}
