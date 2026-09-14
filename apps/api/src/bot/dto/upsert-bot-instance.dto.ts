import { IsIn, IsInt, IsNumber, IsOptional, IsPositive, IsString, Max, Min } from 'class-validator';

export class UpsertBotInstanceDto {
  @IsOptional()
  @IsString()
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
