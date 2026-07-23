import { Injectable } from '@nestjs/common';
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
        role: membership.role,
      }));
    });
  }
}
