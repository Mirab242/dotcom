import { IsIn, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

export class SubmitKycDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  fullName: string;

  @IsString()
  @IsNotEmpty()
  dateOfBirth: string; // format libre en V1 (ex: "1990-05-14") — pas de validation stricte de date

  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  country: string;

  @IsIn(['passport', 'national_id', 'driver_license'])
  idDocumentType: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  idDocumentNumber: string;

  @IsOptional()
  @IsString()
  @MaxLength(4_000_000) // ~3 Mo décodé — large mais borné, évite l'abus d'un champ texte illimité
  documentImageB64?: string;
}
