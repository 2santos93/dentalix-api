import { Injectable } from '@nestjs/common';
import {
  ClinicRole,
  Prisma,
  ClinicInvitation as PrismaClinicInvitation,
} from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import {
  InvitationRepository,
  AcceptOutcome,
  GlobalUserRecord,
  AcceptUserResolution,
  AccountClaimBlockedError,
  AccountClaimConflictError,
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

/**
 * DX-143 (SEC-033): `clinic_memberships` está bajo RLS por clínica; la
 * función SECURITY DEFINER (migración 20261017231000) mira todas y devuelve
 * solo si hay alguna activa fuera de `tenantId`.
 */
async function otherActiveMemberships(
  db: Pick<Prisma.TransactionClient, '$queryRaw'>,
  userId: string,
  tenantId: string,
): Promise<boolean> {
  const [row] = await db.$queryRaw<{ other: boolean }[]>`
    SELECT public.dx_user_has_other_active_memberships(${userId}::uuid, ${tenantId}::uuid) AS other`;
  return row?.other === true;
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

  async findUserByEmailGlobal(email: string): Promise<GlobalUserRecord | null> {
    // `users` has no RLS (global table, same as
    // `PrismaAuthRepository.findUserByEmail`) — plain query, no tenant
    // context needed.
    return this.prisma.user.findFirst({
      where: { email, deletedAt: null },
      select: {
        id: true,
        passwordHash: true,
        tokenVersion: true,
        emailVerifiedAt: true,
        isPlatformAdmin: true,
      },
    });
  }

  async hasOtherActiveMemberships(userId: string): Promise<boolean> {
    return otherActiveMemberships(this.prisma, userId, this.requireTenantId());
  }

  async countCreatedSince(since: Date): Promise<number> {
    return this.prisma.runWithTenant((tx) =>
      tx.clinicInvitation.count({ where: { createdAt: { gte: since } } }),
    );
  }

  async revokePendingByEmail(email: string): Promise<string[]> {
    return this.prisma.runWithTenant(async (tx) => {
      const where = {
        email,
        acceptedAt: null,
        revokedAt: null,
        deletedAt: null,
      };
      // Por el único parcial (tenantId, email) de pendientes hay a lo sumo una.
      const pending = await tx.clinicInvitation.findMany({
        where,
        select: { id: true },
      });
      if (pending.length === 0) return [];
      await tx.clinicInvitation.updateMany({
        where: { ...where, id: { in: pending.map((p) => p.id) } },
        data: { revokedAt: new Date() },
      });
      return pending.map((p) => p.id);
    });
  }

  async findPendingById(id: string): Promise<ClinicInvitation | null> {
    const row = await this.prisma.runWithTenant((tx) =>
      tx.clinicInvitation.findFirst({
        where: { id, acceptedAt: null, revokedAt: null, deletedAt: null },
      }),
    );
    return row ? mapToEntity(row) : null;
  }

  async reissue(
    id: string,
    input: { tokenHash: string; expiresAt: Date },
  ): Promise<ClinicInvitation | null> {
    return this.prisma.runWithTenant(async (tx) => {
      // Check-and-set atómico: solo una invitación pendiente (no aceptada ni
      // revocada) de ESTE tenant (RLS); una de otra clínica no existe.
      const result = await tx.clinicInvitation.updateMany({
        where: { id, acceptedAt: null, revokedAt: null, deletedAt: null },
        data: { tokenHash: input.tokenHash, expiresAt: input.expiresAt },
      });
      if (result.count === 0) return null;
      const row = await tx.clinicInvitation.findUniqueOrThrow({
        where: { id },
      });
      return mapToEntity(row);
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
    user: AcceptUserResolution;
  }): Promise<AcceptOutcome & { tokenVersion: number }> {
    const tenantId = this.requireTenantId();
    return this.prisma.runWithTenant(async (tx) => {
      // 1. Usuario (tabla global, sin RLS). El enlace llegó al email, así que
      // en los tres casos el email queda verificado (DX-029).
      const now = new Date();
      let userId: string;
      let tokenVersion: number;
      const resolution = input.user;
      if ('newUser' in resolution) {
        const user = await tx.user.create({
          data: {
            email: input.email,
            fullName: resolution.newUser.fullName,
            passwordHash: resolution.newUser.passwordHash,
            emailVerifiedAt: now,
          },
          select: { id: true, tokenVersion: true },
        });
        userId = user.id;
        tokenVersion = user.tokenVersion;
      } else if ('claim' in resolution) {
        // DX-143: con la fila del usuario BLOQUEADA (una aceptación en otra
        // clínica también la escribe y espera), se repite la comprobación
        // del caso de uso: sigue sin verificar y no da acceso a otra clínica
        // ni a la plataforma.
        const [locked] = await tx.$queryRaw<
          { emailVerifiedAt: Date | null; isPlatformAdmin: boolean }[]
        >`SELECT "emailVerifiedAt", "isPlatformAdmin" FROM "users"
           WHERE "id" = ${resolution.claim.userId}::uuid AND "deletedAt" IS NULL
           FOR UPDATE`;
        if (!locked || locked.emailVerifiedAt !== null) {
          throw new AccountClaimConflictError();
        }
        if (
          locked.isPlatformAdmin ||
          (await otherActiveMemberships(tx, resolution.claim.userId, tenantId))
        ) {
          throw new AccountClaimBlockedError();
        }
        // Reclamar: solo si SIGUE sin verificar (check-and-set frente a una
        // verificación concurrente).
        const claimed = await tx.user.updateMany({
          where: {
            id: resolution.claim.userId,
            deletedAt: null,
            emailVerifiedAt: null,
            isPlatformAdmin: false,
          },
          data: {
            passwordHash: resolution.claim.passwordHash,
            emailVerifiedAt: now,
            tokenVersion: { increment: 1 },
          },
        });
        if (claimed.count !== 1) {
          throw new AccountClaimConflictError();
        }
        // Los enlaces de restablecimiento que pidiera el anterior dueño.
        await tx.userToken.updateMany({
          where: { userId: resolution.claim.userId, invalidatedAt: null },
          data: { invalidatedAt: now },
        });
        userId = resolution.claim.userId;
        const user = await tx.user.findUniqueOrThrow({
          where: { id: userId },
          select: { tokenVersion: true },
        });
        tokenVersion = user.tokenVersion;
      } else {
        userId = resolution.existingUserId;
        await tx.user.updateMany({
          where: { id: userId, emailVerifiedAt: null },
          data: { emailVerifiedAt: now },
        });
        const user = await tx.user.findUniqueOrThrow({
          where: { id: userId },
          select: { tokenVersion: true },
        });
        tokenVersion = user.tokenVersion;
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

      return { userId, role: input.role, tokenVersion };
    });
  }
}
