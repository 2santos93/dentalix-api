import { Injectable } from '@nestjs/common';
import {
  ClinicRole,
  EmailOutboxStatus,
  EmailTemplate,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import { otherActiveMemberships } from '../../../../shared/tenancy/other-active-memberships';
import {
  DeactivateStaffOutcome,
  ReplaceLocationsOutcome,
  StaffLocationsLookup,
  StaffPatch,
  StaffRepository,
  UpdateStaffOutcome,
} from '../../domain/ports/staff-repository.port';
import { StaffMember } from '../../domain/entities/staff-member.entity';
import {
  StaffDirectoryEntry,
  StaffDirectoryPage,
  StaffDirectoryQuery,
  StaffInvitationEmailDelivery,
} from '../../domain/entities/staff-directory-entry.entity';

const DELIVERY: Record<EmailOutboxStatus, StaffInvitationEmailDelivery> = {
  PENDING: 'PENDING',
  SENDING: 'PENDING',
  SENT: 'SENT',
  FAILED: 'FAILED',
};

@Injectable()
export class PrismaStaffRepository implements StaffRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  /**
   * El directorio mezcla dos tablas, así que la página no se puede pedir con
   * un solo `skip`/`take`: se traen las filas que YA pasan los filtros de cada
   * lado, se ordenan juntas por nombre y se corta en memoria. Exacto por
   * construcción (el total sale del conjunto completo, no de una estimación).
   *
   * Se puede permitir porque el conjunto está acotado por el dominio: el
   * personal de una clínica son decenas de personas, no miles. Si algún día
   * dejara de serlo, esto pasa a un UNION en SQL con LIMIT/OFFSET.
   */
  async listDirectory(query: StaffDirectoryQuery): Promise<StaffDirectoryPage> {
    const { page, pageSize, search, role, status } = query;

    // Sin filtro de estado: quien puede trabajar hoy o está por poder.
    const wantsMembers = status !== 'PENDING';
    const wantsInvitations = status === undefined || status === 'PENDING';
    // `null` = solo activos (también cuando no hay filtro); los inactivos hay
    // que pedirlos a propósito.
    const membershipDeletedAt = status === 'INACTIVE' ? { not: null } : null;

    return this.prisma.runWithTenant(async (tx) => {
      const entries: StaffDirectoryEntry[] = [];

      if (wantsMembers) {
        const memberships = await tx.clinicMembership.findMany({
          where: {
            deletedAt: membershipDeletedAt,
            role,
            user: {
              deletedAt: null,
              ...(search
                ? {
                    OR: [
                      {
                        fullName: {
                          contains: search,
                          mode: Prisma.QueryMode.insensitive,
                        },
                      },
                      {
                        email: {
                          contains: search,
                          mode: Prisma.QueryMode.insensitive,
                        },
                      },
                    ],
                  }
                : {}),
            },
          },
          include: { user: true },
        });
        entries.push(
          // Retorno anotado en vez de un `as`: da tipado contextual a cada
          // literal (y el `--fix` de eslint no puede retirarlo como sí hacía
          // con la aserción).
          ...memberships.map((m): StaffDirectoryEntry => ({
            kind: 'MEMBER',
            id: m.userId,
            fullName: m.user.fullName,
            email: m.user.email,
            role: m.role,
            status: m.deletedAt ? 'INACTIVE' : 'ACTIVE',
            expiresAt: null,
            emailDelivery: null,
          })),
        );
      }

      if (wantsInvitations) {
        // "Pendiente" = ni aceptada, ni revocada, ni caducada. Una invitación
        // caducada no es accionable, así que no ensucia el directorio.
        const invitations = await tx.clinicInvitation.findMany({
          where: {
            deletedAt: null,
            acceptedAt: null,
            revokedAt: null,
            expiresAt: { gt: new Date() },
            role,
            ...(search
              ? {
                  OR: [
                    {
                      fullName: {
                        contains: search,
                        mode: Prisma.QueryMode.insensitive,
                      },
                    },
                    {
                      email: {
                        contains: search,
                        mode: Prisma.QueryMode.insensitive,
                      },
                    },
                  ],
                }
              : {}),
          },
        });
        // Estado del último email de cada invitación (DX-088). Mismo tenant
        // por RLS; índice (tenantId, referenceId, createdAt DESC).
        const deliveries = new Map<string, StaffInvitationEmailDelivery>();
        if (invitations.length > 0) {
          const emails = await tx.emailOutbox.findMany({
            where: {
              template: EmailTemplate.INVITATION,
              referenceId: { in: invitations.map((i) => i.id) },
            },
            orderBy: { createdAt: 'desc' },
            select: { referenceId: true, status: true },
          });
          for (const email of emails) {
            if (email.referenceId && !deliveries.has(email.referenceId)) {
              deliveries.set(email.referenceId, DELIVERY[email.status]);
            }
          }
        }
        entries.push(
          ...invitations.map((i): StaffDirectoryEntry => ({
            kind: 'INVITATION',
            id: i.id,
            fullName: i.fullName,
            email: i.email,
            role: i.role,
            status: 'PENDING',
            expiresAt: i.expiresAt,
            emailDelivery: deliveries.get(i.id) ?? null,
          })),
        );
      }

      entries.sort((a, b) => a.fullName.localeCompare(b.fullName, 'es'));

      const start = (page - 1) * pageSize;
      return {
        items: entries.slice(start, start + pageSize),
        total: entries.length,
        page,
        pageSize,
      };
    });
  }

  async findDetailById(
    userId: string,
  ): Promise<(StaffMember & { status: 'ACTIVE' | 'INACTIVE' }) | null> {
    return this.prisma.runWithTenant(async (tx) => {
      const membership = await tx.clinicMembership.findFirst({
        where: { userId, user: { deletedAt: null } },
        include: { user: true, locations: MEMBERSHIP_LOCATIONS_SELECT },
      });
      return membership
        ? {
            userId: membership.userId,
            fullName: membership.user.fullName,
            email: membership.user.email,
            role: membership.role,
            professionalLicense: membership.professionalLicense,
            locationIds: activeLocationIds(membership.locations),
            status: membership.deletedAt
              ? ('INACTIVE' as const)
              : ('ACTIVE' as const),
          }
        : null;
    });
  }

  async hasOtherActiveMemberships(userId: string): Promise<boolean> {
    // La clínica sale del contexto de la petición, nunca del cliente (misma
    // convención que PrismaInvitationRepository).
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) throw new Error('No tenant in context');
    return otherActiveMemberships(this.prisma, userId, tenantId);
  }

  async reactivateById(userId: string): Promise<StaffMember | null> {
    return this.prisma.runWithTenant(async (tx) => {
      const membership = await tx.clinicMembership.findFirst({
        where: { userId, deletedAt: { not: null }, user: { deletedAt: null } },
        select: { id: true },
      });
      if (!membership) {
        return null;
      }
      const updated = await tx.clinicMembership.update({
        where: { id: membership.id },
        data: { deletedAt: null },
        include: { user: true },
      });
      return {
        userId: updated.userId,
        fullName: updated.user.fullName,
        email: updated.user.email,
        role: updated.role,
      };
    });
  }

  async listActive(): Promise<StaffMember[]> {
    return this.prisma.runWithTenant(async (tx) => {
      // RLS on `clinic_memberships` already scopes this to the current
      // tenant (see tenant_isolation policy) — no explicit tenantId filter
      // needed here, same convention as the other Prisma repositories.
      const memberships = await tx.clinicMembership.findMany({
        where: {
          deletedAt: null,
          user: { deletedAt: null },
        },
        include: { user: true, locations: MEMBERSHIP_LOCATIONS_SELECT },
        orderBy: { user: { fullName: 'asc' } },
      });

      return memberships.map((membership) => ({
        userId: membership.userId,
        fullName: membership.user.fullName,
        email: membership.user.email,
        role: membership.role,
        locationIds: activeLocationIds(membership.locations),
      }));
    });
  }

  async getLocations(userId: string): Promise<StaffLocationsLookup> {
    return this.prisma.runWithTenant(async (tx) => {
      // Incluidos los desactivados: conservan sus filas y su perfil se abre.
      const membership = await tx.clinicMembership.findFirst({
        where: { userId, user: { deletedAt: null } },
        orderBy: { deletedAt: { sort: 'desc', nulls: 'first' } },
        select: { locations: MEMBERSHIP_LOCATIONS_SELECT },
      });
      return membership
        ? {
            kind: 'FOUND',
            locationIds: activeLocationIds(membership.locations),
          }
        : { kind: 'NOT_FOUND' };
    });
  }

  async replaceLocations(
    userId: string,
    locationIds: string[],
    actorUserId: string,
  ): Promise<ReplaceLocationsOutcome> {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) throw new Error('No tenant in context');
    return this.prisma.runWithTenant(async (tx) => {
      // Bloquea la membresía ANTES de leer su rol: un PATCH que la asciende a
      // ADMIN (UPDATE de la misma fila) y este PUT se serializan. Si el PATCH
      // va primero, aquí se lee ADMIN; si va después, borra lo que se escriba.
      await tx.$queryRaw`
        SELECT "id" FROM "clinic_memberships"
         WHERE "userId" = ${userId}::uuid AND "deletedAt" IS NULL
         FOR UPDATE`;
      const membership = await findActiveMembership(tx, userId);
      if (!membership) {
        return { kind: 'NOT_FOUND' };
      }
      if (membership.role === ClinicRole.ADMIN) {
        return { kind: 'IS_ADMIN' };
      }
      // La RLS acota a esta clínica: una sede ajena no aparece y cuenta como
      // desconocida, igual que una borrada o inactiva.
      const locations = await tx.location.findMany({
        where: { id: { in: locationIds }, isActive: true, deletedAt: null },
        select: { id: true },
        orderBy: { createdAt: 'asc' },
      });
      if (locations.length !== locationIds.length) {
        return { kind: 'UNKNOWN_LOCATION' };
      }
      // DX-089: las filas son configuración de acceso, sin datos de pacientes;
      // el PUT las sustituye en la MISMA transacción y el cambio queda en
      // audit_events (allowlist de no-hard-delete).
      // eslint-disable-next-line no-restricted-syntax
      await tx.membershipLocation.deleteMany({
        where: { membershipId: membership.id },
      });
      if (locations.length > 0) {
        await tx.membershipLocation.createMany({
          data: locations.map(({ id }) => ({
            tenantId,
            membershipId: membership.id,
            locationId: id,
            createdById: actorUserId,
          })),
        });
      }
      return { kind: 'UPDATED', locationIds: locations.map(({ id }) => id) };
    });
  }

  async findById(userId: string): Promise<StaffMember | null> {
    return this.prisma.runWithTenant(async (tx) => {
      const membership = await tx.clinicMembership.findFirst({
        where: { userId, deletedAt: null, user: { deletedAt: null } },
        include: { user: true },
      });
      return membership
        ? {
            userId: membership.userId,
            fullName: membership.user.fullName,
            email: membership.user.email,
            role: membership.role,
          }
        : null;
    });
  }

  async updateById(
    userId: string,
    patch: StaffPatch,
  ): Promise<UpdateStaffOutcome> {
    return this.prisma.runWithTenant(async (tx) => {
      // Solo una degradación puede retirar un ADMIN; renombrar o ascender no
      // compite por la regla y no necesita el bloqueo.
      const demotes =
        patch.role !== undefined && patch.role !== ClinicRole.ADMIN;
      if (demotes) {
        await lockActiveAdmins(tx);
      }
      const membership = await findActiveMembership(tx, userId);
      if (!membership) {
        return { kind: 'NOT_FOUND' };
      }
      if (demotes && (await isLastActiveAdmin(tx, membership.role))) {
        return { kind: 'LAST_ADMIN' };
      }
      if (patch.role || patch.professionalLicense !== undefined) {
        await tx.clinicMembership.update({
          where: { id: membership.id },
          data: {
            role: patch.role,
            professionalLicense: patch.professionalLicense,
          },
        });
      }
      // DX-089: el ADMIN siempre tiene todas las sedes. Va DESPUÉS del UPDATE,
      // que bloquea la fila: un PUT de sedes concurrente o ya terminó (y aquí
      // se borran sus filas) o espera y luego lee ADMIN.
      if (patch.role === ClinicRole.ADMIN) {
        // eslint-disable-next-line no-restricted-syntax
        await tx.membershipLocation.deleteMany({
          where: { membershipId: membership.id },
        });
      }
      if (patch.fullName) {
        await tx.user.update({
          where: { id: userId },
          data: { fullName: patch.fullName },
        });
      }
      const updated = await tx.clinicMembership.findFirstOrThrow({
        where: { id: membership.id },
        include: { user: true },
      });
      return {
        kind: 'UPDATED',
        member: {
          userId: updated.userId,
          fullName: updated.user.fullName,
          email: updated.user.email,
          role: updated.role,
          professionalLicense: updated.professionalLicense,
        },
      };
    });
  }

  async deactivateById(userId: string): Promise<DeactivateStaffOutcome> {
    return this.prisma.runWithTenant(async (tx) => {
      await lockActiveAdmins(tx);
      const membership = await findActiveMembership(tx, userId);
      if (!membership) {
        return 'NOT_FOUND';
      }
      if (await isLastActiveAdmin(tx, membership.role)) {
        return 'LAST_ADMIN';
      }
      await tx.clinicMembership.update({
        where: { id: membership.id },
        data: { deletedAt: new Date() },
      });
      return 'DEACTIVATED';
    });
  }
}

/**
 * DB-012: bloquea (FOR UPDATE) las membresías ADMIN vivas de la clínica (la RLS
 * acota a este tenant) ANTES de leer nada. Dos transacciones que pueden
 * retirar un ADMIN se serializan aquí: la segunda espera al COMMIT de la
 * primera, Postgres re-evalúa el WHERE sobre las filas ya cambiadas (la
 * degradada o desactivada deja de cumplirlo) y, como en READ COMMITTED cada
 * sentencia toma una foto nueva, las lecturas siguientes ven el cambio. Orden
 * fijo por `id`: sin interbloqueos entre ellas.
 */
async function lockActiveAdmins(tx: Prisma.TransactionClient): Promise<void> {
  await tx.$queryRaw`
    SELECT "id" FROM "clinic_memberships"
     WHERE "role" = 'ADMIN' AND "deletedAt" IS NULL
     ORDER BY "id"
     FOR UPDATE`;
}

function findActiveMembership(
  tx: Prisma.TransactionClient,
  userId: string,
): Promise<{ id: string; role: ClinicRole } | null> {
  return tx.clinicMembership.findFirst({
    where: { userId, deletedAt: null, user: { deletedAt: null } },
    select: { id: true, role: true },
  });
}

/**
 * DX-089: sedes asignadas a una membresía con lo necesario para saber si
 * siguen activas; mismo criterio que el claim `loc` del token
 * (`prisma-auth.repository.ts`). Orden por antigüedad de la sede.
 */
const MEMBERSHIP_LOCATIONS_SELECT = {
  select: {
    location: { select: { id: true, isActive: true, deletedAt: true } },
  },
  orderBy: { location: { createdAt: 'asc' } },
} satisfies Prisma.ClinicMembership$locationsArgs;

/**
 * Sin filas → `null` (todas las sedes). Con filas, solo las activas y no
 * borradas; si no queda ninguna, `[]` (ninguna), nunca "todas".
 */
function activeLocationIds(
  rows: {
    location: { id: string; isActive: boolean; deletedAt: Date | null };
  }[],
): string[] | null {
  if (rows.length === 0) return null;
  return rows
    .filter(({ location }) => location.isActive && !location.deletedAt)
    .map(({ location }) => location.id);
}

/** ¿Retirar a este miembro dejaría la clínica sin ADMIN activo? */
async function isLastActiveAdmin(
  tx: Prisma.TransactionClient,
  role: ClinicRole,
): Promise<boolean> {
  if (role !== ClinicRole.ADMIN) {
    return false;
  }
  const admins = await tx.clinicMembership.count({
    where: {
      deletedAt: null,
      role: ClinicRole.ADMIN,
      user: { deletedAt: null },
    },
  });
  return admins <= 1;
}
