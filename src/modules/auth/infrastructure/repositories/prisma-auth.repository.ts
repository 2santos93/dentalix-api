import { Injectable } from '@nestjs/common';
import { ClinicRole, Prisma } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import {
  AuthRepository,
  CreateClinicWithOwnerInput,
  MembershipRecord,
} from '../../domain/ports/auth-repository.port';

@Injectable()
export class PrismaAuthRepository implements AuthRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findUserByEmail(email: string): Promise<{ id: string } | null> {
    return this.prisma.user.findFirst({
      where: { email, deletedAt: null },
      select: { id: true },
    });
  }

  async findTenantBySubdomain(
    subdomain: string,
  ): Promise<{ id: string } | null> {
    return this.prisma.tenant.findFirst({
      where: { subdomain, deletedAt: null },
      select: { id: true },
    });
  }

  async createClinicWithOwner(
    input: CreateClinicWithOwnerInput,
  ): Promise<{ tenantId: string; userId: string }> {
    // Atomic: tenant + user + owner membership in ONE transaction, so a failed
    // membership insert never leaves an orphaned tenant or an owner-less user.
    // tenants/users have no RLS; the membership does, so we set the tenant GUC
    // (SET LOCAL via set_config(..., true)) inside the SAME tx before inserting it
    // so the RLS WITH CHECK passes for the freshly created tenant.
    return this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const tenant = await tx.tenant.create({
        data: { name: input.clinicName, subdomain: input.subdomain },
        select: { id: true },
      });
      const user = await tx.user.create({
        data: {
          email: input.email,
          passwordHash: input.passwordHash,
          fullName: input.fullName,
        },
        select: { id: true },
      });
      await tx.$executeRaw`SELECT set_config('app.current_tenant', ${tenant.id}, true)`;
      await tx.clinicMembership.create({
        data: { tenantId: tenant.id, userId: user.id, role: ClinicRole.OWNER },
      });
      return { tenantId: tenant.id, userId: user.id };
    });
  }

  async findMembership(
    tenantId: string,
    email: string,
  ): Promise<MembershipRecord | null> {
    return this.prisma.runWithTenant(tenantId, async (tx) => {
      const membership = await tx.clinicMembership.findFirst({
        where: { tenantId, deletedAt: null, user: { email, deletedAt: null } },
        select: {
          userId: true,
          role: true,
          user: { select: { passwordHash: true } },
        },
      });
      if (!membership) return null;
      return {
        userId: membership.userId,
        role: membership.role,
        passwordHash: membership.user.passwordHash,
      };
    });
  }
}
