import { IsUUID } from 'class-validator';

export class CreateChallengeAccountDto {
  @IsUUID()
  planId: string;
}
