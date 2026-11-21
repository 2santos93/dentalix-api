import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import type {
  ExchangeRefreshCooldown,
  RefreshClaim,
} from '../../domain/ports/exchange-refresh-cooldown.port';

/**
 * DX-586: el turno de «Actualizar tasa» en `tenants`. Un solo UPDATE
 * condicional (la fila queda bloqueada hasta el COMMIT): dos peticiones a la
 * vez se ordenan y solo la primera lo toma. La hora es la de la BD.
 */
@Injectable()
export class PrismaExchangeRefreshCooldown implements ExchangeRefreshCooldown {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  claim(cooldownSeconds: number): Promise<RefreshClaim> {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) throw new Error('No tenant in context');
    return this.prisma.runWithTenant(tenantId, async (tx) => {
      const taken = await tx.$queryRaw<{ id: string }[]>`
        UPDATE "tenants" SET "exchangeRateRefreshedAt" = now()
         WHERE "id" = ${tenantId}::uuid
           AND ("exchangeRateRefreshedAt" IS NULL
                OR "exchangeRateRefreshedAt"
                   <= now() - make_interval(secs => ${cooldownSeconds}::int))
        RETURNING "id"`;
      if (taken.length > 0) return { ok: true };
      const [left] = await tx.$queryRaw<{ seconds: number | null }[]>`
        SELECT ceil(extract(epoch FROM
                 "exchangeRateRefreshedAt"
                 + make_interval(secs => ${cooldownSeconds}::int) - now()))::int
               AS "seconds"
          FROM "tenants" WHERE "id" = ${tenantId}::uuid`;
      return {
        ok: false,
        retryAfterSeconds: Math.max(1, left?.seconds ?? cooldownSeconds),
      };
    });
  }
}
