import { Injectable } from '@nestjs/common';
import { ClinicRole } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { StaffRepository } from '../../domain/ports/staff-repository.port';
import { StaffMember } from '../../domain/entities/staff-member.entity';

@Injectable()
export class PrismaStaffRepository implements StaffRepository {
  constructor(private readonly prisma: PrismaService) {}

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
