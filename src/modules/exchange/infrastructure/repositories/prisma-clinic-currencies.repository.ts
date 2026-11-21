import { ConflictException, Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import { resolveReferenceLocation } from '../../../../shared/locations/reference-location';
import type { AuditRequestContext } from '../../../audit/domain/audit-request-context';
import { configAuditEvent } from '../../../audit/domain/config-audit';
import { writeAuditEvent } from '../../../audit/infrastructure/prisma-audit-event.repository';
import type { ClinicCurrencies } from '../../domain/clinic-currencies';
import type {
  ClinicCurrenciesRepository,
  HeaderLocation,
} from '../../domain/ports/clinic-currencies-repository.port';

interface CurrenciesRow {
  acceptedCurrencies: string[];
  rateReferenceCurrency: string | null;
  showRateInHeader: boolean | null;
}

const SELECT = {
  acceptedCurrencies: true,
  rateReferenceCurrency: true,
  showRateInHeader: true,
} as const;

/** CHAR(3) sale con relleno si alguna vez lleva menos de 3: se recorta. */
const toCurrencies = (row: CurrenciesRow): ClinicCurrencies => ({
  acceptedCurrencies: row.acceptedCurrencies.map((c) => c.trim()),
  rateReferenceCurrency: row.rateReferenceCurrency?.trim() ?? null,
  showRateInHeader: row.showRateInHeader,
});

/** Para el antes y el después de la auditoría (valores planos). */
const forAudit = (c: ClinicCurrencies) => ({
  acceptedCurrencies: c.acceptedCurrencies,
  rateReferenceCurrency: c.rateReferenceCurrency,
  showRateInHeader: c.showRateInHeader,
});

/**
 * DX-584. `tenants` es global (sin RLS): siempre por el id del contexto, como
 * los demás ajustes de la tasa (DX-374) y los textos de moneda (DX-517). El
 * evento va en la MISMA transacción que el cambio (DX-360).
 */
@Injectable()
export class PrismaClinicCurrenciesRepository implements ClinicCurrenciesRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  private tenantId(): string {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) throw new Error('No tenant in context');
    return tenantId;
  }

  async get(): Promise<ClinicCurrencies> {
    const tenant = await this.prisma.tenant.findUniqueOrThrow({
      where: { id: this.tenantId() },
      select: SELECT,
    });
    return toCurrencies(tenant);
  }

  set(
    next: (before: ClinicCurrencies) => ClinicCurrencies,
    ctx: AuditRequestContext,
  ): Promise<{ before: ClinicCurrencies; after: ClinicCurrencies }> {
    const id = this.tenantId();
    return this.prisma.runWithTenant(id, async (tx) => {
      // Fila bloqueada: dos ADMIN a la vez se ordenan y cada uno audita su
      // antes real (y valida contra él: `next` puede lanzar un 400).
      const [locked] = await tx.$queryRaw<CurrenciesRow[]>`
        SELECT "acceptedCurrencies"::text[] AS "acceptedCurrencies",
               "rateReferenceCurrency", "showRateInHeader"
          FROM "tenants" WHERE "id" = ${id}::uuid FOR UPDATE`;
      const before = toCurrencies(locked);
      const wanted = next(before);
      const updated = await tx.tenant.update({
        where: { id },
        data: {
          acceptedCurrencies: wanted.acceptedCurrencies,
          rateReferenceCurrency: wanted.rateReferenceCurrency,
          showRateInHeader: wanted.showRateInHeader,
        },
        select: SELECT,
      });
      const after = toCurrencies(updated);
      const event = configAuditEvent(ctx, {
        action: 'UPDATE',
        resourceType: 'CLINIC_SETTINGS',
        resourceId: id,
        reason: 'CLINIC_CURRENCIES',
        before: forAudit(before),
        after: forAudit(after),
      });
      if (event) await writeAuditEvent(tx, event);
      return { before, after };
    });
  }

  async knownCurrencies(codes: readonly string[]): Promise<Set<string>> {
    const wanted = codes.filter((c) => /^[A-Z]{3}$/.test(c));
    if (wanted.length === 0) return new Set();
    const rows = await this.prisma.currency.findMany({
      where: { code: { in: wanted } },
      select: { code: true },
    });
    return new Set(rows.map((r) => r.code));
  }

  async locationCurrencies(): Promise<string[]> {
    const tenantId = this.tenantId();
    const rows = await this.prisma.runWithTenant(tenantId, (tx) =>
      tx.location.findMany({
        where: { tenantId, deletedAt: null, currency: { not: null } },
        select: { currency: true },
      }),
    );
    return [
      ...new Set(rows.flatMap((r) => (r.currency ? [r.currency.trim()] : []))),
    ];
  }

  async headerLocation(): Promise<HeaderLocation | null> {
    const tenantId = this.tenantId();
    try {
      const location = await this.prisma.runWithTenant(tenantId, (tx) =>
        resolveReferenceLocation(
          tx,
          tenantId,
          this.tenantContext.getLocationId() ?? null,
        ),
      );
      return {
        timeZone: location.timeZone,
        currency: location.currency?.trim() ?? null,
      };
    } catch (error) {
      // Sin sede activa o sede sin zona (409 LOCATION_REQUIRED /
      // LOCATION_TIMEZONE_REQUIRED): el menú no tiene «hoy» y no enseña nada.
      if (error instanceof ConflictException) return null;
      throw error;
    }
  }
}
