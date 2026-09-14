import { IsIn } from 'class-validator';

export class SetUserRoleDto {
  @IsIn(['user', 'admin'])
  role: 'user' | 'admin';
}
