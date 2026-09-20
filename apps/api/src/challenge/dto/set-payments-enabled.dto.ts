import { IsBoolean, IsOptional, IsString } from 'class-validator';

/** Phrase à recopier pour ACTIVER l'argent réel — empêche un clic accidentel (§8.3 ARCHITECTURE.md). */
export const PAYMENTS_CONFIRM_PHRASE = 'ACTIVER ARGENT REEL';

export class SetPaymentsEnabledDto {
  @IsBoolean()
  enabled: boolean;

  @IsOptional()
  @IsString()
  confirm?: string;
}
