import { IsBoolean } from 'class-validator';

export class ToggleBotInstanceDto {
  @IsBoolean()
  enabled: boolean;
}
