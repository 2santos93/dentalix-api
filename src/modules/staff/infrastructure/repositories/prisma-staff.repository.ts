import { Injectable } from '@nestjs/common';
import { ClinicRole, Prisma } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { StaffRepository } from '../../domain/ports/staff-repository.port';
import { StaffMember } from '../../domain/entities/staff-member.entity';
import {
  StaffDirectoryEntry,
  StaffDirectoryPage,
  StaffDirectoryQuery,
} from '../../domain/entities/staff-directory-entry.entity';

@Injectable()
export class PrismaStaffRepository implements StaffRepository {
  constructor(private readonly prisma: PrismaService) {}

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
        entries.push(
          ...invitations.map((i): StaffDirectoryEntry => ({
            kind: 'INVITATION',
            id: i.id,
            fullName: i.fullName,
            email: i.email,
            role: i.role,
            status: 'PENDING',
            expiresAt: i.expiresAt,
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
        include: { user: true },
      });
      return membership
        ? {
            userId: membership.userId,
            fullName: membership.user.fullName,
            email: membership.user.email,
            role: membership.role,
            status: membership.deletedAt
              ? ('INACTIVE' as const)
              : ('ACTIVE' as const),
          }
        : null;
    });
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
        include: { user: true },
        orderBy: { user: { fullName: 'asc' } },
      });

      return memberships.map((membership) => ({
        userId: membership.userId,
        fullName: membership.user.fullName,
        email: membership.user.email,
        role: membership.role,
      }));
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
    patch: { fullName?: string; role?: ClinicRole },
  ): Promise<StaffMember | null> {
    return this.prisma.runWithTenant(async (tx) => {
      const membership = await tx.clinicMembership.findFirst({
        where: { userId, deletedAt: null },
        select: { id: true },
      });
      if (!membership) {
        return null;
      }
      if (patch.role) {
        await tx.clinicMembership.update({
          where: { id: membership.id },
          data: { role: patch.role },
        });
      }
      if (patch.fullName) {
        await tx.user.update({
          where: { id: userId },
          data: { fullName: patch.fullName },
        });
      }
      const updated = await tx.clinicMembership.findFirst({
        where: { id: membership.id },
        include: { user: true },
      });
      return updated
        ? {
            userId: updated.userId,
            fullName: updated.user.fullName,
            email: updated.user.email,
            role: updated.role,
          }
        : null;
    });
  }

  async deactivateById(userId: string): Promise<boolean> {
    return this.prisma.runWithTenant(async (tx) => {
      const result = await tx.clinicMembership.updateMany({
        where: { userId, deletedAt: null },
        data: { deletedAt: new Date() },
      });
      return result.count > 0;
    });
  }

  async countActiveAdmins(): Promise<number> {
    return this.prisma.runWithTenant(async (tx) =>
      tx.clinicMembership.count({
        where: {
          deletedAt: null,
          role: ClinicRole.ADMIN,
          user: { deletedAt: null },
        },
      }),
    );
  }
}
