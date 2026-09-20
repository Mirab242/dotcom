import { IsNumber, IsPositive } from 'class-validator';

export class RequestChallengePayoutDto {
  /** Montant que le trader souhaite recevoir (sa part, après partage des profits), en USDT. */
  @IsNumber()
  @IsPositive()
  amount: number;
}
