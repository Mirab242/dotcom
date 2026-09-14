import { Module } from '@nestjs/common';
import { CustodyModule } from '../custody/custody.module';
import { AdminService } from './admin.service';
import { AdminController } from './admin.controller';

@Module({
  imports: [CustodyModule],
  controllers: [AdminController],
  providers: [AdminService],
})
export class AdminModule {}
