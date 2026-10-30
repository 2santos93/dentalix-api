import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import {
  UserProfileRepository,
  UserRecord,
} from '../../domain/ports/user-profile-repository.port';
import type { AuditEventDraft } from '../../../audit/domain/audit-event';
import { writeAuditEvent } from '../../../audit/infrastructure/prisma-audit-event.repository';
import { writePlatformAuditEvent } from '../../../audit/infrastructure/platform-audit-event.writer';
import type { OwnAccountAuditEvent } from '../../domain/own-account-audit';

// `users` y `tenants` son tablas GLOBALES (sin RLS) → Prisma directo, sin
// runWithTenant (mismo criterio que PrismaAuthRepository.findUserByEmail).
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
        avatarKey: true,
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

  // DX-359: dentro de la transacción de la clínica del evento (la de la
  // sesión): `users` no tiene RLS y `audit_events` exige ese tenant.
  async updateName(
    userId: string,
    fullName: string,
    audit: AuditEventDraft,
  ): Promise<void> {
    await this.prisma.runWithTenant(audit.tenantId, async (tx) => {
      const before = await tx.user.findUniqueOrThrow({
        where: { id: userId },
        select: { fullName: true },
      });
      if (before.fullName === fullName) return;
      await tx.user.update({ where: { id: userId }, data: { fullName } });
      await writeAuditEvent(tx, audit);
    });
  }

  async updatePasswordAndRevokeSessions(
    userId: string,
    passwordHash: string,
    audit: OwnAccountAuditEvent,
  ): Promise<number> {
    const write = async (tx: Prisma.TransactionClient) => {
      const user = await tx.user.update({
        where: { id: userId },
        data: { passwordHash, tokenVersion: { increment: 1 } },
        select: { tokenVersion: true },
      });
      if (audit.kind === 'tenant') {
        await writeAuditEvent(tx, audit.event);
      } else {
        await writePlatformAuditEvent(tx, audit.event);
      }
      return user.tokenVersion;
    };
    // DX-359: el cambio y su evento, o ninguno. Sin clínica (superadmin), una
    // transacción sin tenant: ni `users` ni `platform_audit_events` tienen RLS.
    return audit.kind === 'tenant'
      ? this.prisma.runWithTenant(audit.event.tenantId, write)
      : this.prisma.$transaction(write);
  }

  async updateAvatarKey(
    userId: string,
    avatarKey: string | null,
  ): Promise<void> {
    await this.prisma.user.update({
      where: { id: userId },
      data: { avatarKey },
    });
  }
}
