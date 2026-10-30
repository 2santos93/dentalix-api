import { Injectable } from '@nestjs/common';
import type { ExchangeRateSource } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import type { ClinicExchangeSettingsRepository } from '../../domain/ports/clinic-exchange-settings-repository.port';

@Injectable()
export class PrismaClinicExchangeSettingsRepository implements ClinicExchangeSettingsRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  private tenantId(): string {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) throw new Error('No tenant in context');
    return tenantId;
  }

  async getSource(): Promise<ExchangeRateSource> {
    // `tenants` es global (sin RLS): siempre por el id del contexto, sin
    // runWithTenant, como los ajustes de la receta (DX-324).
    const tenant = await this.prisma.tenant.findUniqueOrThrow({
      where: { id: this.tenantId() },
      select: { exchangeRateSource: true },
    });
    return tenant.exchangeRateSource;
  }

  async setSource(
    next: ExchangeRateSource,
  ): Promise<{ before: ExchangeRateSource; after: ExchangeRateSource }> {
    const id = this.tenantId();
    // Lectura con la fila bloqueada y escritura en la misma transacción.
    return this.prisma.$transaction(async (tx) => {
      const [locked] = await tx.$queryRaw<{ source: ExchangeRateSource }[]>`
        SELECT "exchangeRateSource" AS source
          FROM "tenants" WHERE "id" = ${id}::uuid FOR UPDATE`;
      const tenant = await tx.tenant.update({
        where: { id },
        data: { exchangeRateSource: next },
        select: { exchangeRateSource: true },
      });
      return { before: locked.source, after: tenant.exchangeRateSource };
    });
  }
}
