import { IsIn, IsNumber, IsOptional, IsPositive, IsString } from 'class-validator';

export class CreateDepositDto {
  @IsIn(['USDT', 'DOT', 'BTC', 'ETH', 'SOL'])
  currency: string;

  @IsNumber()
  @IsPositive()
  amount: number;

  @IsOptional()
  @IsString()
  reference?: string; // référence mobile money / memo / justificatif, laissé au choix de l'utilisateur
}
