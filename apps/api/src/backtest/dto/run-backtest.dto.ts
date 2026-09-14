import { IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class RunBacktestDto {
  @IsOptional()
  @IsString()
  symbol?: string = 'DOT/USDT';

  @IsOptional()
  @IsIn(['1m', '5m', '15m', '1h', '4h', '1d'])
  timeframe?: '1m' | '5m' | '15m' | '1h' | '4h' | '1d' = '15m';

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(100)
  @Max(1000)
  limit?: number = 300;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(100)
  minConfidence?: number = 60;
}
