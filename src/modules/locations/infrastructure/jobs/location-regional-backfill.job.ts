import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { JobRegistry } from '../../../jobs/application/job-registry';
import { PrismaService } from '../../../../shared/prisma/prisma.service';

export const LOCATION_REGIONAL_BACKFILL_JOB = 'locations.regional-backfill';
export const LOCATION_REGIONAL_BACKFILL_SCHEDULE =
  'locations.regional-backfill.every-5-min';
export const LOCATION_REGIONAL_BACKFILL_CRON = '*/5 * * * *';

/** Solo números y el id de la clínica: nunca datos de la sede. */
export interface LocationRegionalBackfillReport {
  tenantId: string;
  /** Sedes con algún campo regional NULL que la pasada rellenó. */
  filled: number;
  /** G1-B: sedes con el reloj NULL que la pasada rellenó (h23). */
  hourCycleFilled: number;
}

/**
 * Barrido de fase 1 (GLOBAL-G1, spec §2.3): una réplica anterior a G1 que crea
 * una sede (o verifica un registro) la deja con moneda, zona y locale NULL.
 * Clínica por clínica, con su tenant fijado (`runWithTenant`, RLS FORCE y rol
 * de la app), llama a `dx_g1_backfill_location_regional(tenantId)`: la única
 * correspondencia país → valor (D5, R2/R19), una tabla de todos los países
 * (Z1, `prisma/reference/country-regional-defaults.json`). Rellena solo columnas NULL, no
 * marca la sede como revisada (el ADMIN ve el aviso D5) e, idempotente, sin
 * filas NULL no escribe nada. Lo comparten el job y `npm run
 * g1:backfill-locations`. Desaparece en fase 2.
 *
 * G1-B fase 1 (DX-350, spec §3.1): en la misma tx, también
 * `dx_g1b_backfill_location_hour_cycle(tenantId)`, el único sitio que rellena
 * un reloj NULL (R5), para las sedes que una réplica de G1 crea con moneda,
 * zona y formato pero sin reloj. Después de la D5, así una sede anterior a G1
 * queda completa en una pasada.
 */
export async function backfillLocationRegional(
  prisma: PrismaService,
): Promise<LocationRegionalBackfillReport[]> {
  const reports: LocationRegionalBackfillReport[] = [];
  for (const tenantId of await allTenantIds(prisma)) {
    const report = await prisma.runWithTenant(tenantId, async (tx) => {
      const [regional] = await tx.$queryRaw<{ filled: number }[]>`
        SELECT public.dx_g1_backfill_location_regional(${tenantId}::uuid) AS "filled"`;
      const [clock] = await tx.$queryRaw<{ filled: number }[]>`
        SELECT public.dx_g1b_backfill_location_hour_cycle(${tenantId}::uuid) AS "filled"`;
      return { filled: regional.filled, hourCycleFilled: clock.filled };
    });
    reports.push({ tenantId, ...report });
  }
  return reports;
}

/**
 * Todas las clínicas, también las retiradas: sus sedes cuentan igual para el
 * `SET NOT NULL` de la fase 2, así que el barrido y la comprobación las cubren.
 */
async function allTenantIds(prisma: PrismaService): Promise<string[]> {
  const tenants = await prisma.tenant.findMany({
    select: { id: true },
    orderBy: { createdAt: 'asc' },
  });
  return tenants.map((t) => t.id);
}

/** Lo que queda sin configurar en toda la base. */
export interface LocationRegionalCheck {
  /** Sedes con moneda, zona, locale o reloj (G1-B) NULL. */
  locations: number;
  /** Registros pendientes y vigentes sin los datos de la sede (forma legada). */
  legacyPending: number;
  /**
   * G1-B: registros pendientes y vigentes sin reloj (los de una web de G1 y
   * los legados). La fase 2 solo pone NOT NULL cuando es 0 (pre-flight I2).
   */
  pendingWithoutClock: number;
}

/**
 * Comprobación del runbook (paso 3) y precondición de la fase 2: cuenta, con
 * el rol de la app y clínica por clínica bajo su RLS (como escribe el
 * barrido), las sedes con algún campo regional NULL (reloj incluido), los
 * registros legados vigentes y los vigentes sin reloj (`pending_registrations`
 * no tiene RLS). Solo lecturas: ni DDL ni
 * más bloqueo que el de un SELECT, así que se puede correr con tráfico. No da
 * un falso 0: cada clínica se lee con su tenant fijado.
 */
export async function checkLocationRegional(
  prisma: PrismaService,
): Promise<LocationRegionalCheck> {
  let locations = 0;
  for (const tenantId of await allTenantIds(prisma)) {
    locations += await prisma.runWithTenant(tenantId, (tx) =>
      tx.location.count({
        where: {
          tenantId,
          OR: [
            { currency: null },
            { timeZone: null },
            { locale: null },
            { hourCycle: null },
          ],
        },
      }),
    );
  }
  const now = new Date();
  const legacyPending = await prisma.pendingRegistration.count({
    where: { locationCurrency: null, expiresAt: { gt: now } },
  });
  const pendingWithoutClock = await prisma.pendingRegistration.count({
    where: { locationHourCycle: null, expiresAt: { gt: now } },
  });
  return { locations, legacyPending, pendingWithoutClock };
}

/** El barrido cada 5 minutos en la cola de DX-085 (un ejecutor por tick). */
@Injectable()
export class LocationRegionalBackfillJob implements OnModuleInit {
  private readonly logger = new Logger('Locations');

  constructor(
    private readonly registry: JobRegistry,
    private readonly prisma: PrismaService,
  ) {}

  onModuleInit(): void {
    this.registry.register({
      name: LOCATION_REGIONAL_BACKFILL_JOB,
      // Sin reintentos de la cola: la pasada siguiente es el reintento.
      maxAttempts: 1,
      handle: async () => {
        await this.sweep();
      },
    });
    this.registry.schedule({
      name: LOCATION_REGIONAL_BACKFILL_SCHEDULE,
      cron: LOCATION_REGIONAL_BACKFILL_CRON,
      job: LOCATION_REGIONAL_BACKFILL_JOB,
      // DX-380 (OPS-046): sin solapar un tick con el anterior.
      singleton: true,
    });
  }

  async sweep(): Promise<LocationRegionalBackfillReport[]> {
    const reports = await backfillLocationRegional(this.prisma);
    const filled = reports.filter(
      (report) => report.filled > 0 || report.hourCycleFilled > 0,
    );
    for (const report of filled) {
      this.logger.log({ event: 'locations.regional_backfilled', ...report });
    }
    return reports;
  }
}
