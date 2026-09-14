import { IsIn, IsNumber, IsOptional, IsPositive, IsString } from 'class-validator';

export class ExecuteSignalDto {
  @IsString()
  symbol: string; // "DOT/USDT"

  @IsIn(['buy', 'sell'])
  side: 'buy' | 'sell';

  @IsNumber()
  @IsPositive()
  entry: number;

  @IsNumber()
  @IsPositive()
  stopLoss: number;

  @IsOptional()
  @IsNumber()
  @IsPositive()
  takeProfit?: number;

  @IsOptional()
  @IsNumber()
  @IsPositive()
  riskPercent?: number; // % du capital risqué, défaut 1%, plafonné à 3% (risk-engine)

  @IsOptional()
  @IsIn(['market', 'limit'])
  orderType?: 'market' | 'limit'; // "limit" = exécution différée (§4.4) : pose un ordre au prix du signal au lieu d'exécuter immédiatement
}
