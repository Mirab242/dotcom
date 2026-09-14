import { IsIn } from 'class-validator';

export class SetUserSubscriptionDto {
  @IsIn(['free', 'pro'])
  subscriptionTier: 'free' | 'pro';
}
