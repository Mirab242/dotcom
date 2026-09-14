import { IsNotEmpty, IsString } from 'class-validator';

export class RejectKycDto {
  @IsString()
  @IsNotEmpty()
  reason: string;
}
