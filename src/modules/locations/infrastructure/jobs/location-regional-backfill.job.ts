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
}

/**
 * Barrido de fase 1 (GLOBAL-G1, spec §2.3): una réplica anterior a G1 que crea
 * una sede (o verifica un registro) la deja con moneda, zona y locale NULL.
 * Clínica por clínica, con su tenant fijado (`runWithTenant`, RLS FORCE y rol
 * de la app), llama a `dx_g1_backfill_location_regional(tenantId)`: la única
 * correspondencia país → valor (D5, R2/R19). Rellena solo columnas NULL, no
 * marca la sede como revisada (el ADMIN ve el aviso D5) e, idempotente, sin
 * filas NULL no escribe nada. Lo comparten el job y `npm run
 * g1:backfill-locations`. Desaparece en fase 2.
 */
export async function backfillLocationRegional(
  prisma: PrismaService,
): Promise<LocationRegionalBackfillReport[]> {
  const tenants = await prisma.tenant.findMany({
    where: { deletedAt: null },
    select: { id: true },
    orderBy: { createdAt: 'asc' },
  });
  const reports: LocationRegionalBackfillReport[] = [];
  for (const { id: tenantId } of tenants) {
    const filled = await prisma.runWithTenant(tenantId, async (tx) => {
      const [row] = await tx.$queryRaw<{ filled: number }[]>`
        SELECT public.dx_g1_backfill_location_regional(${tenantId}::uuid) AS "filled"`;
      return row.filled;
    });
    reports.push({ tenantId, filled });
  }
  return reports;
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
    });
  }

  async sweep(): Promise<LocationRegionalBackfillReport[]> {
    const reports = await backfillLocationRegional(this.prisma);
    const filled = reports.filter((report) => report.filled > 0);
    for (const report of filled) {
      this.logger.log({ event: 'locations.regional_backfilled', ...report });
    }
    return reports;
  }
}
