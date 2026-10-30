import { Injectable } from '@nestjs/common';
import type { ExchangeRateSource } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import { resolveReferenceLocation } from '../../../../shared/locations/reference-location';
import type {
  ClinicExchangeSettings,
  ClinicExchangeSettingsRepository,
} from '../../domain/ports/clinic-exchange-settings-repository.port';

interface SettingsRow {
  exchangeRateSource: ExchangeRateSource;
  manualExchangeRatesSince: Date | null;
}

const SETTINGS_SELECT = {
  exchangeRateSource: true,
  manualExchangeRatesSince: true,
} as const;

/** Día civil ↔ columna DATE: Prisma la lee y escribe como medianoche UTC. */
const toSettings = (row: SettingsRow): ClinicExchangeSettings => ({
  source: row.exchangeRateSource,
  manualSince: row.manualExchangeRatesSince
    ? row.manualExchangeRatesSince.toISOString().slice(0, 10)
    : null,
});

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

  async get(): Promise<ClinicExchangeSettings> {
    // `tenants` es global (sin RLS): siempre por el id del contexto, sin
    // runWithTenant, como los ajustes de la receta (DX-324).
    const tenant = await this.prisma.tenant.findUniqueOrThrow({
      where: { id: this.tenantId() },
      select: SETTINGS_SELECT,
    });
    return toSettings(tenant);
  }

  async set(
    next: (before: ClinicExchangeSettings) => ClinicExchangeSettings,
  ): Promise<{
    before: ClinicExchangeSettings;
    after: ClinicExchangeSettings;
  }> {
    const id = this.tenantId();
    // Lectura con la fila bloqueada y escritura en la misma transacción.
    return this.prisma.$transaction(async (tx) => {
      const [locked] = await tx.$queryRaw<SettingsRow[]>`
        SELECT "exchangeRateSource", "manualExchangeRatesSince"
          FROM "tenants" WHERE "id" = ${id}::uuid FOR UPDATE`;
      const before = toSettings(locked);
      const wanted = next(before);
      const tenant = await tx.tenant.update({
        where: { id },
        data: {
          exchangeRateSource: wanted.source,
          manualExchangeRatesSince: wanted.manualSince
            ? new Date(`${wanted.manualSince}T00:00:00.000Z`)
            : null,
        },
        select: SETTINGS_SELECT,
      });
      return { before, after: toSettings(tenant) };
    });
  }

  async principalTimeZone(): Promise<string> {
    const tenantId = this.tenantId();
    const location = await this.prisma.runWithTenant(tenantId, (tx) =>
      resolveReferenceLocation(tx, tenantId, null),
    );
    return location.timeZone;
  }
}
