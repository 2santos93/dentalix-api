import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import type { PatientSettingsRepository } from '../../domain/ports/patient-settings-repository.port';

@Injectable()
export class PrismaPatientSettingsRepository implements PatientSettingsRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  private tenantId(): string {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) throw new Error('No tenant in context');
    return tenantId;
  }

  async getMajorityAge(): Promise<number> {
    // `tenants` es global (sin RLS): siempre por el id del contexto.
    const tenant = await this.prisma.tenant.findUniqueOrThrow({
      where: { id: this.tenantId() },
      select: { majorityAge: true },
    });
    return tenant.majorityAge;
  }

  async setMajorityAge(
    age: number,
  ): Promise<{ before: number; after: number }> {
    const id = this.tenantId();
    // Lectura con la fila bloqueada y escritura en la misma transacción.
    return this.prisma.$transaction(async (tx) => {
      const [locked] = await tx.$queryRaw<{ age: number }[]>`
        SELECT "majorityAge" AS age
          FROM "tenants" WHERE "id" = ${id}::uuid FOR UPDATE`;
      const tenant = await tx.tenant.update({
        where: { id },
        data: { majorityAge: age },
        select: { majorityAge: true },
      });
      return { before: locked.age, after: tenant.majorityAge };
    });
  }
}
