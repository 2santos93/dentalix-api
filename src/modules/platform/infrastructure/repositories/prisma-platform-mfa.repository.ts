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
        email: true,
        mfaEnabledAt: true,
        mfaTotpPendingSecretEnc: true,
      },
    });
    if (!user) return null;
    return {
      email: user.email,
      enabledAt: user.mfaEnabledAt,
      pendingSecretEnc: user.mfaTotpPendingSecretEnc,
    };
  }

  async savePending(
    userId: string,
    pendingSecretEnc: string,
  ): Promise<boolean> {
    const { count } = await this.prisma.user.updateMany({
      where: {
        id: userId,
        deletedAt: null,
        isPlatformAdmin: true,
        mfaEnabledAt: null,
      },
      data: { mfaTotpPendingSecretEnc: pendingSecretEnc },
    });
    return count === 1;
  }

  async confirm(
    userId: string,
    pendingSecretEnc: string,
    step: number,
  ): Promise<Date | null> {
    const enabledAt = new Date();
    const { count } = await this.prisma.user.updateMany({
      where: {
        id: userId,
        deletedAt: null,
        isPlatformAdmin: true,
        mfaEnabledAt: null,
        mfaTotpPendingSecretEnc: pendingSecretEnc,
      },
      data: {
        mfaTotpSecretEnc: pendingSecretEnc,
        mfaTotpPendingSecretEnc: null,
        mfaEnabledAt: enabledAt,
        mfaLastUsedStep: step,
      },
    });
    return count === 1 ? enabledAt : null;
  }
}
