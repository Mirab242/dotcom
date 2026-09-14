import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class UsersService {
  constructor(private prisma: PrismaService) {}

  async findById(id: string) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id } });
    const { passwordHash, twoFaSecret, ...safe } = user;
    return safe;
  }

  async findAll() {
    const users = await this.prisma.user.findMany({
      orderBy: { createdAt: 'desc' },
    });
    return users.map(({ passwordHash, twoFaSecret, ...safe }) => safe);
  }
}
