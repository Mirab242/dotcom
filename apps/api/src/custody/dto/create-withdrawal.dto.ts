import { IsIn, IsNumber, IsPositive, IsString } from 'class-validator';

export class CreateWithdrawalDto {
  @IsIn(['USDT', 'DOT', 'BTC', 'ETH', 'SOL'])
  currency: string;

  @IsNumber()
  @IsPositive()
  amount: number;

  @IsString()
  destination: string; // adresse / IBAN / numéro mobile money selon la devise — texte libre en V1
}
