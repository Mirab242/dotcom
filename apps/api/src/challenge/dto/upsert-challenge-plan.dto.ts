import { IsBoolean, IsInt, IsNotEmpty, IsNumber, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

/** Création d'un plan : tous les champs de règles ont une valeur par défaut raisonnable (standard des prop firms). */
export class CreateChallengePlanDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  name: string;

  @IsNumber()
  @Min(100)
  @Max(10_000_000)
  accountSize: number;

  @IsNumber()
  @Min(0)
  @Max(100_000)
  feeAmount: number;

  @IsOptional() @IsNumber() @Min(0.5) @Max(100) phase1TargetPct?: number;
  @IsOptional() @IsNumber() @Min(0.5) @Max(100) phase2TargetPct?: number;
  @IsOptional() @IsNumber() @Min(0.5) @Max(50) maxDailyLossPct?: number;
  @IsOptional() @IsNumber() @Min(0.5) @Max(100) maxTotalDrawdownPct?: number;
  @IsOptional() @IsInt() @Min(0) @Max(90) minTradingDays?: number;
  @IsOptional() @IsInt() @Min(1) @Max(365) phase1MaxDays?: number | null;
  @IsOptional() @IsInt() @Min(1) @Max(365) phase2MaxDays?: number | null;
  @IsOptional() @IsNumber() @Min(1) @Max(100) profitSplitPct?: number;
  @IsOptional() @IsBoolean() active?: boolean;
}

/** Mise à jour partielle : ne s'applique qu'aux comptes créés APRÈS (les règles d'un compte sont figées à l'achat). */
export class UpdateChallengePlanDto {
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(60) name?: string;
  @IsOptional() @IsNumber() @Min(100) @Max(10_000_000) accountSize?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(100_000) feeAmount?: number;
  @IsOptional() @IsNumber() @Min(0.5) @Max(100) phase1TargetPct?: number;
  @IsOptional() @IsNumber() @Min(0.5) @Max(100) phase2TargetPct?: number;
  @IsOptional() @IsNumber() @Min(0.5) @Max(50) maxDailyLossPct?: number;
  @IsOptional() @IsNumber() @Min(0.5) @Max(100) maxTotalDrawdownPct?: number;
  @IsOptional() @IsInt() @Min(0) @Max(90) minTradingDays?: number;
  @IsOptional() @IsInt() @Min(1) @Max(365) phase1MaxDays?: number | null;
  @IsOptional() @IsInt() @Min(1) @Max(365) phase2MaxDays?: number | null;
  @IsOptional() @IsNumber() @Min(1) @Max(100) profitSplitPct?: number;
  @IsOptional() @IsBoolean() active?: boolean;
}
