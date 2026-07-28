import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import {
  UserProfileRepository,
  UserRecord,
} from '../../domain/ports/user-profile-repository.port';

// `users` y `tenants` son tablas GLOBALES (sin RLS) → Prisma directo, sin
// runWithTenant (mismo criterio que PrismaAuthRepository.findUserByEmail /
// PrismaStaffRepository.findUserByEmailGlobal).
@Injectable()
export class PrismaUserProfileRepository implements UserProfileRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findUserById(userId: string): Promise<UserRecord | null> {
    return this.prisma.user.findFirst({
      where: { id: userId, deletedAt: null },
      select: {
        id: true,
        email: true,
        fullName: true,
        avatarUrl: true,
        emailVerifiedAt: true,
      },
    });
  }

  async findClinicName(tenantId: string): Promise<string | null> {
    const tenant = await this.prisma.tenant.findFirst({
      where: { id: tenantId, deletedAt: null },
      select: { name: true },
    });
    return tenant?.name ?? null;
  }

  async getPasswordHash(userId: string): Promise<string | null> {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, deletedAt: null },
      select: { passwordHash: true },
    });
    return user?.passwordHash ?? null;
  }

  async updateName(userId: string, fullName: string): Promise<void> {
    await this.prisma.user.update({ where: { id: userId }, data: { fullName } });
  }

  async updatePasswordHash(userId: string, passwordHash: string): Promise<void> {
    await this.prisma.user.update({ where: { id: userId }, data: { passwordHash } });
  }

  async updateAvatarUrl(userId: string, avatarUrl: string | null): Promise<void> {
    await this.prisma.user.update({ where: { id: userId }, data: { avatarUrl } });
  }
}
