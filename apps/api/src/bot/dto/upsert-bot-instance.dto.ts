import { IsIn, IsInt, IsNumber, IsOptional, IsPositive, Max, Min } from 'class-validator';
import { SUPPORTED_SYMBOLS } from '@dot-trader/shared-types';

export class UpsertBotInstanceDto {
  @IsOptional()
  @IsIn(SUPPORTED_SYMBOLS)
  symbol?: string = 'DOT/USDT';

  @IsOptional()
  @IsIn(['5m', '15m', '1h', '4h'])
  timeframe?: string = '15m';

  @IsOptional()
  @IsIn(['15m', '1h', '4h', '1d'])
  higherTimeframe?: string = '4h';

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  minConfidence?: number = 70;

  @IsOptional()
  @IsNumber()
  @IsPositive()
  riskPercent?: number = 1;
}
