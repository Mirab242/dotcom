import { IsIn, IsNumber, IsOptional, IsPositive, IsString } from 'class-validator';

export class CreateOrderDto {
  @IsString()
  symbol: string; // "DOT/USDT"

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
