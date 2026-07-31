import { Injectable } from '@nestjs/common';
import { ClinicRole } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import { StaffRepository } from '../../domain/ports/staff-repository.port';
import { StaffMember } from '../../domain/entities/staff-member.entity';

@Injectable()
export class PrismaStaffRepository implements StaffRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  /**
   * `tenantId` is NOT NULL at the DB level with no column default that
   * autofills from the RLS GUC, so — unlike a plain SELECT/UPDATE/DELETE,
   * which RLS filters transparently — an INSERT still needs the app to
   * supply it explicitly. We never take it from the input (never from the
   * client); we read it from the same request-scoped context that
   * `runWithTenant(fn)` uses to set `app.current_tenant`, so the value
   * written always matches the GUC the WITH CHECK policy validates against.
   * (Same convention as `PrismaPatientRepository`/`PrismaAppointmentRepository`.)
   */
  private requireTenantId(): string {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) {
      throw new Error('No tenant in context');
    }
    return tenantId;
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

  async findUserByEmailGlobal(email: string): Promise<{ id: string } | null> {
    // `users` has no RLS (global table, same as `PrismaAuthRepository.
    // findUserByEmail`) — plain query, no tenant context needed.
    return this.prisma.user.findFirst({
      where: { email, deletedAt: null },
      select: { id: true },
    });
  }

  async create(input: {
    fullName: string;
    email: string;
    role: ClinicRole;
    passwordHash: string;
  }): Promise<StaffMember> {
    // Tenant already exists (this is an authenticated request against it),
    // so — unlike `PrismaAuthRepository.createClinicWithOwner`, which sets
    // the GUC manually mid-transaction for a tenant it just created —
    // `runWithTenant(fn)` resolves the tenantId from the request-scoped ALS
    // context and sets `app.current_tenant` (SET LOCAL via set_config)
    // BEFORE invoking `fn`. So by the time we insert the ClinicMembership,
    // the GUC is already in place for the RLS WITH CHECK to validate against.
    const tenantId = this.requireTenantId();
    return this.prisma.runWithTenant(async (tx) => {
      const user = await tx.user.create({
        data: {
          email: input.email,
          passwordHash: input.passwordHash,
          fullName: input.fullName,
        },
        select: { id: true, fullName: true, email: true },
      });
      const membership = await tx.clinicMembership.create({
        data: { tenantId, userId: user.id, role: input.role },
        select: { role: true },
      });
      return {
        userId: user.id,
        fullName: user.fullName,
        email: user.email,
        role: membership.role,
      };
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

  async reactivateMembership(
    userId: string,
    role: ClinicRole,
  ): Promise<StaffMember | null> {
    return this.prisma.runWithTenant(async (tx) => {
      // Target a SOFT-DELETED membership specifically — that's what
      // reactivation clears. RLS scopes this to the current tenant. If only an
      // ACTIVE membership exists we return null (nothing to reactivate) and the
      // caller treats it as a duplicate; the partial unique index still guards
      // the pathological "active + soft-deleted both present" case.
      const membership = await tx.clinicMembership.findFirst({
        where: { userId, deletedAt: { not: null } },
        orderBy: { deletedAt: 'desc' },
        select: { id: true },
      });
      if (!membership) {
        return null;
      }
      const updated = await tx.clinicMembership.update({
        where: { id: membership.id },
        data: { deletedAt: null, role },
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

  async countActiveOwners(): Promise<number> {
    return this.prisma.runWithTenant(async (tx) =>
      tx.clinicMembership.count({
        where: {
          deletedAt: null,
          role: ClinicRole.OWNER,
          user: { deletedAt: null },
        },
      }),
    );
  }
}
