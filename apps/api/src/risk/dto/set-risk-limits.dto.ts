import { IsNumber, IsOptional, Max, Min } from 'class-validator';

export class SetRiskLimitsDto {
  @IsOptional()
  @IsNumber()
  @Min(0.1)
  @Max(100)
  maxDailyLossPercent?: number;

  @IsOptional()
  @IsNumber()
  @Min(0.1)
  @Max(100)
  maxDrawdownPercent?: number;
}
