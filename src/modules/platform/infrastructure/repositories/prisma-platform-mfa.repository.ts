import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import type {
  PlatformMfaRepository,
  PlatformMfaState,
} from '../../domain/ports/platform-mfa-repository.port';

// `users` es global (sin RLS): mismas lecturas directas que el resto de
// plataforma. Solo superadmins llegan aquí (PlatformAdminGuard).
@Injectable()
export class PrismaPlatformMfaRepository implements PlatformMfaRepository {
  constructor(private readonly prisma: PrismaService) {}

  async find(userId: string): Promise<PlatformMfaState | null> {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, deletedAt: null, isPlatformAdmin: true },
      select: {
        mfaEnabledAt: true,
        _count: {
          select: { mfaRecoveryCodes: { where: { usedAt: null } } },
        },
      },
    });
    if (!user) return null;
    return {
      enabledAt: user.mfaEnabledAt,
      recoveryCodesRemaining: user._count.mfaRecoveryCodes,
    };
  }
}
