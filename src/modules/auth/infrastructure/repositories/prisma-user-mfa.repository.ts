import { Injectable } from '@nestjs/common';
import type { ClinicRole, Prisma } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { otherActiveMemberships } from '../../../../shared/tenancy/other-active-memberships';
import type { AuditEventDraft } from '../../../audit/domain/audit-event';
import type { OwnAccountAuditEventDraft } from '../../../audit/domain/platform-audit-event';
import { writeAuditEvent } from '../../../audit/infrastructure/prisma-audit-event.repository';
import { writePlatformAuditEvent } from '../../../audit/infrastructure/platform-audit-event.writer';
import type {
  TrustedDevice,
  UserMfaRepository,
  UserMfaState,
} from '../../domain/ports/user-mfa-repository.port';
import type { ClinicMfaPolicy } from '../../domain/user-mfa';
import type { MfaAuditDraft } from '../../domain/user-mfa-audit';

// `users`, `tenants` y `user_mfa_recovery_codes` son globales (sin RLS):
// lecturas directas. Las escrituras con evento van en `runWithTenant` del
// tenant del evento (`audit_events` sí tiene RLS), como el cambio de
// contraseña (PrismaUserProfileRepository); las de un superadmin, con evento en
// `platform_audit_events`, sin tenant.
@Injectable()
export class PrismaUserMfaRepository implements UserMfaRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** Transacción del cambio y su evento, en la clínica o en plataforma. */
  private inAuditScope<T>(
    audit: MfaAuditDraft,
    work: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    return 'tenantId' in audit
      ? this.prisma.runWithTenant(audit.tenantId, work)
      : this.prisma.$transaction(work);
  }

  private writeEvent(
    tx: Prisma.TransactionClient,
    audit: MfaAuditDraft,
  ): Promise<void> {
    return 'tenantId' in audit
      ? writeAuditEvent(tx, audit)
      : writePlatformAuditEvent(tx, audit);
  }

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
    return this.prisma.$transaction(async (tx) => {
      // Lo exige el trigger `users_platform_mfa_enrollment_door` para un
      // superadmin: UserMfaService solo llega aquí tras el código del correo.
      await tx.$executeRaw`SELECT set_config('dentalix.platform_mfa_enrollment', 'email-verified', true)`;
      const { count } = await tx.user.updateMany({
        where: { id: userId, deletedAt: null, mfaEnabledAt: null },
        data: { mfaTotpPendingSecretEnc: pendingSecretEnc },
      });
      return count === 1;
    });
  }

  async enable(
    userId: string,
    pendingSecretEnc: string,
    step: number,
    codeHashes: string[],
    audit: MfaAuditDraft,
  ): Promise<{ enabledAt: Date; tokenVersion: number } | null> {
    const enabledAt = new Date();
    return this.inAuditScope(audit, async (tx) => {
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
      await this.writeEvent(tx, audit);
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
    audit: MfaAuditDraft,
  ): Promise<boolean> {
    return this.inAuditScope(audit, async (tx) => {
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
      await this.writeEvent(tx, audit);
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

  findClinicPolicy(tenantId: string): Promise<ClinicMfaPolicy | null> {
    return this.prisma.tenant.findFirst({
      where: { id: tenantId, deletedAt: null },
      select: { requireAdminMfa: true, requireAllMfa: true },
    });
  }

  async setClinicPolicy(
    tenantId: string,
    policy: ClinicMfaPolicy,
    roles: ClinicRole[],
    audit: AuditEventDraft,
  ): Promise<number> {
    return this.prisma.runWithTenant(tenantId, async (tx) => {
      await tx.tenant.update({ where: { id: tenantId }, data: policy });
      // `users` no tiene RLS: los ids salen de la membresía, que sí la tiene.
      const members = roles.length
        ? await tx.clinicMembership.findMany({
            where: {
              deletedAt: null,
              role: { in: roles },
              user: { deletedAt: null, mfaEnabledAt: null },
            },
            select: { userId: true },
          })
        : [];
      if (members.length > 0) {
        await tx.user.updateMany({
          where: { id: { in: members.map((m) => m.userId) } },
          data: { tokenVersion: { increment: 1 } },
        });
      }
      await writeAuditEvent(tx, {
        ...audit,
        metadata: { ...audit.metadata, sessionsClosed: members.length },
      });
      return members.length;
    });
  }

  async recordPlatformEvent(draft: OwnAccountAuditEventDraft): Promise<void> {
    await this.prisma.$transaction((tx) => writePlatformAuditEvent(tx, draft));
  }

  async findActiveMemberRole(
    tenantId: string,
    userId: string,
  ): Promise<ClinicRole | null> {
    const membership = await this.prisma.runWithTenant(tenantId, (tx) =>
      tx.clinicMembership.findFirst({
        where: { userId, deletedAt: null, user: { deletedAt: null } },
        select: { role: true },
      }),
    );
    return membership?.role ?? null;
  }

  hasOtherActiveMemberships(
    userId: string,
    tenantId: string,
  ): Promise<boolean> {
    return otherActiveMemberships(this.prisma, userId, tenantId);
  }

  async addTrustedDevice(input: {
    userId: string;
    tokenHash: string;
    tokenVersion: number;
    label: string;
    expiresAt: Date;
  }): Promise<void> {
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      // eslint-disable-next-line no-restricted-syntax -- DX-021-bis: material de credencial; ver HARD_DELETE_ALLOWLIST
      await tx.userTrustedDevice.deleteMany({
        where: {
          userId: input.userId,
          OR: [
            { expiresAt: { lte: now } },
            { revokedAt: { not: null } },
            { tokenVersion: { not: input.tokenVersion } },
          ],
        },
      });
      await tx.userTrustedDevice.create({ data: input });
    });
  }

  async touchTrustedDevice(
    userId: string,
    tokenHash: string,
    tokenVersion: number,
  ): Promise<boolean> {
    const now = new Date();
    const { count } = await this.prisma.userTrustedDevice.updateMany({
      where: {
        userId,
        tokenHash,
        tokenVersion,
        revokedAt: null,
        expiresAt: { gt: now },
      },
      data: { lastUsedAt: now },
    });
    return count === 1;
  }

  listTrustedDevices(
    userId: string,
    tokenVersion: number,
  ): Promise<TrustedDevice[]> {
    return this.prisma.userTrustedDevice.findMany({
      where: {
        userId,
        tokenVersion,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
      orderBy: { lastUsedAt: 'desc' },
      select: {
        id: true,
        label: true,
        createdAt: true,
        lastUsedAt: true,
        expiresAt: true,
      },
    });
  }

  async revokeTrustedDevices(
    userId: string,
    id: string | null,
  ): Promise<number> {
    const { count } = await this.prisma.userTrustedDevice.updateMany({
      where: { userId, revokedAt: null, ...(id ? { id } : {}) },
      data: { revokedAt: new Date() },
    });
    return count;
  }
}
