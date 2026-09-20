import { IsIn, IsNumber, IsOptional, IsPositive } from 'class-validator';
import { SUPPORTED_SYMBOLS } from '@dot-trader/shared-types';

/** Ordre au marché simulé (positions long uniquement). Le stop-loss est obligatoire, comme sur le compte réel (§4.5). */
export class PlaceChallengeOrderDto {
  @IsIn(SUPPORTED_SYMBOLS)
  symbol: string;

  @IsNumber()
  @IsPositive()
  qty: number;

  @IsNumber()
  @IsPositive()
  stopLoss: number;

  @IsOptional()
  @IsNumber()
  @IsPositive()
  takeProfit?: number;
}
