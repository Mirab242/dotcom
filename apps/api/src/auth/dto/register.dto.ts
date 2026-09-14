import { IsEmail, IsOptional, IsString, MinLength } from 'class-validator';

export class RegisterDto {
  @IsEmail()
  email: string;

  @IsString()
  @MinLength(10, { message: 'Le mot de passe doit contenir au moins 10 caractères' })
  password: string;

  @IsOptional()
  @IsString()
  referralCode?: string; // code de parrainage saisi par le nouvel utilisateur, s'il en a un (§4.10)
}
