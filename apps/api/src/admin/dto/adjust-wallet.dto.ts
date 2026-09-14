import { IsIn, IsNumber, IsNotEmpty, IsPositive, IsString } from 'class-validator';

export class AdjustWalletDto {
  @IsIn(['USDT', 'DOT', 'BTC', 'ETH', 'SOL'])
  currency: string;

  @IsNumber()
  @IsPositive()
  amount: number;

  @IsIn(['credit', 'debit'])
  direction: 'credit' | 'debit';

  @IsString()
  @IsNotEmpty()
  reason: string; // motif obligatoire — tracé dans le journal d'audit
}
