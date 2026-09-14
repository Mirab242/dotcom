import { IsIn } from 'class-validator';

export class SetUserStatusDto {
  @IsIn(['active', 'suspended'])
  status: 'active' | 'suspended';
}
