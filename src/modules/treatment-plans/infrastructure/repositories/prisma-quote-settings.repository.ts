import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import type { QuoteSettingsRepository } from '../../domain/ports/quote-settings-repository.port';
import type { QuoteSettings } from '../../domain/quote-validity';

/** Ajuste de validez del presupuesto (DX-379): `tenants.quoteValidityDays`. */
@Injectable()
export class PrismaQuoteSettingsRepository implements QuoteSettingsRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  private tenantId(): string {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) throw new Error('No tenant in context');
    return tenantId;
  }

  async get(): Promise<QuoteSettings> {
    // `tenants` es global (sin RLS): siempre por el id del contexto, sin
    // runWithTenant, como los ajustes de la receta (DX-324).
    const tenant = await this.prisma.tenant.findUniqueOrThrow({
      where: { id: this.tenantId() },
      select: { quoteValidityDays: true },
    });
    return { validityDays: tenant.quoteValidityDays };
  }

  async set(
    next: QuoteSettings,
  ): Promise<{ before: QuoteSettings; after: QuoteSettings }> {
    const id = this.tenantId();
    // Lectura con la fila bloqueada y escritura en la misma transacción.
    return this.prisma.$transaction(async (tx) => {
      const [locked] = await tx.$queryRaw<{ quoteValidityDays: number }[]>`
        SELECT "quoteValidityDays" FROM "tenants" WHERE "id" = ${id}::uuid FOR UPDATE`;
      const tenant = await tx.tenant.update({
        where: { id },
        data: { quoteValidityDays: next.validityDays },
        select: { quoteValidityDays: true },
      });
      return {
        before: { validityDays: locked.quoteValidityDays },
        after: { validityDays: tenant.quoteValidityDays },
      };
    });
  }
}
