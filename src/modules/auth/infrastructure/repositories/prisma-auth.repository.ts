import { Injectable } from '@nestjs/common';
import { ClinicRole } from '@prisma/client';
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
    // tenants/users no tienen RLS (globales / lookup por subdominio);
    // el membership sí, por eso lo insertamos bajo el contexto del nuevo tenant.
    const tenant = await this.prisma.tenant.create({
      data: { name: input.clinicName, subdomain: input.subdomain },
      select: { id: true },
    });
    const user = await this.prisma.user.create({
      data: {
        email: input.email,
        passwordHash: input.passwordHash,
        fullName: input.fullName,
      },
      select: { id: true },
    });
    await this.prisma.runWithTenant(tenant.id, (tx) =>
      tx.clinicMembership.create({
        data: { tenantId: tenant.id, userId: user.id, role: ClinicRole.OWNER },
      }),
    );
    return { tenantId: tenant.id, userId: user.id };
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
