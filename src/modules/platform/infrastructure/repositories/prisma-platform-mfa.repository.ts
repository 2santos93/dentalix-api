import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import type {
  PlatformMfaRepository,
  PlatformMfaState,
} from '../../domain/ports/platform-mfa-repository.port';
import {
  ownPlatformAccountEvent,
  type PlatformAuditActor,
} from '../../../audit/domain/platform-audit-event';
import { writePlatformAuditEvent } from '../../../audit/infrastructure/platform-audit-event.writer';

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
    actor: PlatformAuditActor,
  ): Promise<boolean> {
    // DX-359: el cambio y su evento de plataforma, o ninguno.
    return this.prisma.$transaction(async (tx) => {
      const { count } = await tx.user.updateMany({
        where: {
          id: userId,
          deletedAt: null,
          isPlatformAdmin: true,
          mfaEnabledAt: null,
        },
        data: { mfaTotpPendingSecretEnc: pendingSecretEnc },
      });
      if (count !== 1) return false;
      await writePlatformAuditEvent(
        tx,
        ownPlatformAccountEvent(actor, 'MFA_ENROLLMENT_STARTED'),
      );
      return true;
    });
  }

  async confirm(
    userId: string,
    pendingSecretEnc: string,
    step: number,
    actor: PlatformAuditActor,
  ): Promise<Date | null> {
    const enabledAt = new Date();
    return this.prisma.$transaction(async (tx) => {
      const { count } = await tx.user.updateMany({
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
      if (count !== 1) return null;
      await writePlatformAuditEvent(
        tx,
        ownPlatformAccountEvent(actor, 'MFA_ENABLED'),
      );
      return enabledAt;
    });
  }
}
