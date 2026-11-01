import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import type { AuditEventDraft } from '../../../audit/domain/audit-event';
import { writeAuditEvent } from '../../../audit/infrastructure/prisma-audit-event.repository';
import type {
  UserMfaRepository,
  UserMfaState,
} from '../../domain/ports/user-mfa-repository.port';

// `users`, `tenants` y `user_mfa_recovery_codes` son globales (sin RLS):
// lecturas directas. Las escrituras con evento van en `runWithTenant` del
// tenant del evento (`audit_events` sí tiene RLS), como el cambio de
// contraseña (PrismaUserProfileRepository).
@Injectable()
export class PrismaUserMfaRepository implements UserMfaRepository {
  constructor(private readonly prisma: PrismaService) {}

  async find(userId: string): Promise<UserMfaState | null> {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, deletedAt: null },
      select: {
        email: true,
        passwordHash: true,
        isPlatformAdmin: true,
        tokenVersion: true,
        mfaTotpSecretEnc: true,
        mfaTotpPendingSecretEnc: true,
        mfaEnabledAt: true,
        mfaLastUsedStep: true,
        _count: {
          select: { mfaRecoveryCodes: { where: { usedAt: null } } },
        },
      },
    });
    if (!user) return null;
    return {
      email: user.email,
      passwordHash: user.passwordHash,
      isPlatformAdmin: user.isPlatformAdmin,
      tokenVersion: user.tokenVersion,
      secretEnc: user.mfaTotpSecretEnc,
      pendingSecretEnc: user.mfaTotpPendingSecretEnc,
      enabledAt: user.mfaEnabledAt,
      lastUsedStep: user.mfaLastUsedStep,
      recoveryCodesRemaining: user.mfaEnabledAt
        ? user._count.mfaRecoveryCodes
        : 0,
    };
  }

  async savePending(
    userId: string,
    pendingSecretEnc: string,
  ): Promise<boolean> {
    const { count } = await this.prisma.user.updateMany({
      where: { id: userId, deletedAt: null, mfaEnabledAt: null },
      data: { mfaTotpPendingSecretEnc: pendingSecretEnc },
    });
    return count === 1;
  }

  async enable(
    userId: string,
    pendingSecretEnc: string,
    step: number,
    codeHashes: string[],
    audit: AuditEventDraft,
  ): Promise<{ enabledAt: Date; tokenVersion: number } | null> {
    const enabledAt = new Date();
    return this.prisma.runWithTenant(audit.tenantId, async (tx) => {
      const { count } = await tx.user.updateMany({
        where: {
          id: userId,
          deletedAt: null,
          mfaEnabledAt: null,
          mfaTotpPendingSecretEnc: pendingSecretEnc,
        },
        data: {
          mfaTotpSecretEnc: pendingSecretEnc,
          mfaTotpPendingSecretEnc: null,
          mfaEnabledAt: enabledAt,
          mfaLastUsedStep: step,
          tokenVersion: { increment: 1 },
        },
      });
      if (count !== 1) return null;
      // eslint-disable-next-line no-restricted-syntax -- DX-021: material de credencial; ver HARD_DELETE_ALLOWLIST
      await tx.userMfaRecoveryCode.deleteMany({ where: { userId } });
      await tx.userMfaRecoveryCode.createMany({
        data: codeHashes.map((codeHash) => ({ userId, codeHash })),
      });
      await writeAuditEvent(tx, audit);
      const { tokenVersion } = await tx.user.findUniqueOrThrow({
        where: { id: userId },
        select: { tokenVersion: true },
      });
      return { enabledAt, tokenVersion };
    });
  }

  async disable(
    userId: string,
    audit: AuditEventDraft,
  ): Promise<number | null> {
    return this.prisma.runWithTenant(audit.tenantId, async (tx) => {
      const { count } = await tx.user.updateMany({
        where: { id: userId, deletedAt: null, mfaEnabledAt: { not: null } },
        data: {
          mfaTotpSecretEnc: null,
          mfaTotpPendingSecretEnc: null,
          mfaEnabledAt: null,
          mfaLastUsedStep: null,
          tokenVersion: { increment: 1 },
        },
      });
      if (count !== 1) return null;
      // eslint-disable-next-line no-restricted-syntax -- DX-021: material de credencial; ver HARD_DELETE_ALLOWLIST
      await tx.userMfaRecoveryCode.deleteMany({ where: { userId } });
      await writeAuditEvent(tx, audit);
      const { tokenVersion } = await tx.user.findUniqueOrThrow({
        where: { id: userId },
        select: { tokenVersion: true },
      });
      return tokenVersion;
    });
  }

  async replaceRecoveryCodes(
    userId: string,
    codeHashes: string[],
    audit: AuditEventDraft,
  ): Promise<boolean> {
    return this.prisma.runWithTenant(audit.tenantId, async (tx) => {
      // Bloquea la fila del usuario: una desactivación simultánea no deja
      // códigos huérfanos de un MFA ya apagado.
      const rows = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "users"
         WHERE "id" = ${userId}::uuid AND "deletedAt" IS NULL
           AND "mfaEnabledAt" IS NOT NULL
         FOR UPDATE`;
      if (rows.length !== 1) return false;
      // eslint-disable-next-line no-restricted-syntax -- DX-021: material de credencial; ver HARD_DELETE_ALLOWLIST
      await tx.userMfaRecoveryCode.deleteMany({ where: { userId } });
      await tx.userMfaRecoveryCode.createMany({
        data: codeHashes.map((codeHash) => ({ userId, codeHash })),
      });
      await writeAuditEvent(tx, audit);
      return true;
    });
  }

  async consumeRecoveryCode(
    userId: string,
    codeHash: string,
  ): Promise<boolean> {
    const { count } = await this.prisma.userMfaRecoveryCode.updateMany({
      where: {
        userId,
        codeHash,
        usedAt: null,
        user: { deletedAt: null, mfaEnabledAt: { not: null } },
      },
      data: { usedAt: new Date() },
    });
    return count === 1;
  }

  async findClinicPolicy(tenantId: string): Promise<boolean | null> {
    const tenant = await this.prisma.tenant.findFirst({
      where: { id: tenantId, deletedAt: null },
      select: { requireAdminMfa: true },
    });
    return tenant ? tenant.requireAdminMfa : null;
  }

  async setClinicPolicy(
    tenantId: string,
    requireAdminMfa: boolean,
  ): Promise<void> {
    await this.prisma.tenant.update({
      where: { id: tenantId },
      data: { requireAdminMfa },
    });
  }
}
