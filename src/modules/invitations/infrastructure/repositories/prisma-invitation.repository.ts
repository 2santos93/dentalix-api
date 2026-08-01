import { Injectable } from '@nestjs/common';
import {
  ClinicRole,
  ClinicInvitation as PrismaClinicInvitation,
} from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import {
  InvitationRepository,
  AcceptOutcome,
} from '../../domain/ports/invitation-repository.port';
import { ClinicInvitation } from '../../domain/entities/clinic-invitation.entity';

function mapToEntity(row: PrismaClinicInvitation): ClinicInvitation {
  return {
    id: row.id,
    tenantId: row.tenantId,
    email: row.email,
    fullName: row.fullName,
    role: row.role,
    expiresAt: row.expiresAt,
    acceptedAt: row.acceptedAt,
    revokedAt: row.revokedAt,
    invitedById: row.invitedById,
    createdAt: row.createdAt,
  };
}

@Injectable()
export class PrismaInvitationRepository implements InvitationRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  /**
   * `tenantId` is NOT NULL at the DB level with no column default that
   * autofills from the RLS GUC, so — unlike a plain SELECT/UPDATE, which RLS
   * filters transparently — an INSERT still needs the app to supply it
   * explicitly. We never take it from the input (never from the client); we
   * read it from the same request-scoped context that `runWithTenant(fn)`
   * uses to set `app.current_tenant` (same convention as
   * `PrismaMedicalHistoryRepository`/`PrismaStaffRepository`).
   */
  private requireTenantId(): string {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) {
      throw new Error('No tenant in context');
    }
    return tenantId;
  }

  async listPending(): Promise<ClinicInvitation[]> {
    const rows = await this.prisma.runWithTenant(async (tx) => {
      return tx.clinicInvitation.findMany({
        where: { acceptedAt: null, revokedAt: null, deletedAt: null },
        orderBy: { createdAt: 'desc' },
      });
    });
    return rows.map(mapToEntity);
  }

  async findByTokenHash(tokenHash: string): Promise<ClinicInvitation | null> {
    // Sin filtrar por acceptedAt/revokedAt/expiresAt: el llamador clasifica el
    // estado con `invitationStatus` para poder devolver el motivo exacto
    // (usada/revocada/expirada) en vez de un genérico "no encontrada".
    const row = await this.prisma.runWithTenant(async (tx) => {
      return tx.clinicInvitation.findFirst({
        where: { tokenHash, deletedAt: null },
      });
    });
    return row ? mapToEntity(row) : null;
  }

  async findActiveMembershipByEmail(
    email: string,
  ): Promise<{ userId: string } | null> {
    return this.prisma.runWithTenant(async (tx) => {
      // RLS on `clinic_memberships` already scopes this to the current
      // tenant — no explicit tenantId filter needed (same convention as
      // PrismaStaffRepository.listActive).
      const membership = await tx.clinicMembership.findFirst({
        where: { deletedAt: null, user: { email, deletedAt: null } },
        select: { userId: true },
      });
      return membership;
    });
  }

  async findUserByEmailGlobal(
    email: string,
  ): Promise<{ id: string; passwordHash: string } | null> {
    // `users` has no RLS (global table, same as
    // `PrismaStaffRepository.findUserByEmailGlobal`) — plain query, no
    // tenant context needed.
    return this.prisma.user.findFirst({
      where: { email, deletedAt: null },
      select: { id: true, passwordHash: true },
    });
  }

  async revokePendingByEmail(email: string): Promise<number> {
    return this.prisma.runWithTenant(async (tx) => {
      const result = await tx.clinicInvitation.updateMany({
        where: { email, acceptedAt: null, revokedAt: null, deletedAt: null },
        data: { revokedAt: new Date() },
      });
      return result.count;
    });
  }

  async revokeById(id: string): Promise<boolean> {
    return this.prisma.runWithTenant(async (tx) => {
      const result = await tx.clinicInvitation.updateMany({
        where: { id, acceptedAt: null, revokedAt: null, deletedAt: null },
        data: { revokedAt: new Date() },
      });
      return result.count > 0;
    });
  }

  async findTenantName(): Promise<string | null> {
    // `tenants` has no RLS on itself (same as `TenantResolverService`) — a
    // plain lookup by the id already in context, no `runWithTenant` needed.
    const tenantId = this.requireTenantId();
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { name: true },
    });
    return tenant?.name ?? null;
  }

  async create(input: {
    email: string;
    fullName: string;
    role: ClinicRole;
    tokenHash: string;
    expiresAt: Date;
    invitedById?: string;
  }): Promise<ClinicInvitation> {
    const tenantId = this.requireTenantId();
    const row = await this.prisma.runWithTenant(async (tx) => {
      return tx.clinicInvitation.create({
        data: {
          tenantId,
          email: input.email,
          fullName: input.fullName,
          role: input.role,
          tokenHash: input.tokenHash,
          expiresAt: input.expiresAt,
          invitedById: input.invitedById,
        },
      });
    });
    return mapToEntity(row);
  }

  async acceptTransactional(input: {
    invitationId: string;
    email: string;
    role: ClinicRole;
    existingUserId?: string;
    newUser?: { fullName: string; passwordHash: string };
  }): Promise<AcceptOutcome> {
    const tenantId = this.requireTenantId();
    return this.prisma.runWithTenant(async (tx) => {
      // 1. Usuario: crea uno nuevo (tabla global, sin RLS) o reutiliza el
      // existente que ya resolvió el caso de uso.
      let userId: string;
      if (input.newUser) {
        const user = await tx.user.create({
          data: {
            email: input.email,
            fullName: input.newUser.fullName,
            passwordHash: input.newUser.passwordHash,
          },
          select: { id: true },
        });
        userId = user.id;
      } else {
        if (!input.existingUserId) {
          throw new Error(
            'acceptTransactional requires newUser or existingUserId',
          );
        }
        userId = input.existingUserId;
      }

      // 2. Membresía: crea o REACTIVA (limpia deletedAt y aplica el rol
      // invitado). RLS ya limita `findFirst` al tenant en contexto.
      const membership = await tx.clinicMembership.findFirst({
        where: { userId },
      });
      if (membership) {
        await tx.clinicMembership.update({
          where: { id: membership.id },
          data: { deletedAt: null, role: input.role },
        });
      } else {
        await tx.clinicMembership.create({
          data: { tenantId, userId, role: input.role },
        });
      }

      // 3. Marca la invitación como aceptada.
      await tx.clinicInvitation.update({
        where: { id: input.invitationId },
        data: { acceptedAt: new Date() },
      });

      return { userId, role: input.role };
    });
  }
}
