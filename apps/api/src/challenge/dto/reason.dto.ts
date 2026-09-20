import { IsNotEmpty, IsString, MaxLength, MinLength } from 'class-validator';

/** Motif obligatoire pour toute action admin sensible (fermeture forcée, rejet de retrait) — tracé dans l'audit log. */
export class ReasonDto {
  @IsString()
  @IsNotEmpty()
  @MinLength(3)
  @MaxLength(300)
  reason: string;
}
