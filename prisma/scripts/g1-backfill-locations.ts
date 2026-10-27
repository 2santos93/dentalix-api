/**
 * GLOBAL-G1 fase 1 (spec §2.3 y runbook §2.3 bis): rellena las sedes que una
 * réplica anterior a G1 dejó con moneda, zona o locale NULL, clínica por
 * clínica. Es el mismo código que el job `locations.regional-backfill`
 * (`dx_g1_backfill_location_regional` bajo `runWithTenant`). Corre con el rol
 * de la app (DATABASE_URL, RLS FORCE), nunca como superusuario. Idempotente:
 * una segunda pasada no cambia nada. G1-B (DX-350): también rellena el reloj
 * NULL de las sedes que crea una réplica de G1
 * (`dx_g1b_backfill_location_hour_cycle`).
 *
 *   npm run g1:backfill-locations
 *
 * Imprime una línea JSON por clínica con sedes rellenadas (`filled`, regional;
 * `hourCycleFilled`, reloj) y un total, solo con números y ids de clínica.
 *
 *   npm run g1:backfill-locations -- --check
 *
 * Solo cuenta, sin escribir ni tomar bloqueos (precondición de la fase 2):
 * imprime `locations_sin_configurar=N` (reloj NULL incluido),
 * `pendientes_legados_vigentes=N` y `pendientes_sin_reloj_vigentes=N`, y sale
 * con código 1 si alguno es mayor que 0. Desaparece en fase 2 (spec §11; G1-B
 * §12).
 */
import { config as loadDotenv } from 'dotenv';
import {
  backfillLocationRegional,
  checkLocationRegional,
} from '../../src/modules/locations/infrastructure/jobs/location-regional-backfill.job';
import { PrismaService } from '../../src/shared/prisma/prisma.service';
import { TenantContextService } from '../../src/shared/tenancy/tenant-context.service';

async function main(): Promise<void> {
  loadDotenv({ quiet: true });
  const prisma = new PrismaService(new TenantContextService());
  try {
    if (process.argv.includes('--check')) {
      const { locations, legacyPending, pendingWithoutClock } =
        await checkLocationRegional(prisma);
      console.log(`locations_sin_configurar=${locations}`);
      console.log(`pendientes_legados_vigentes=${legacyPending}`);
      console.log(`pendientes_sin_reloj_vigentes=${pendingWithoutClock}`);
      if (locations > 0 || legacyPending > 0 || pendingWithoutClock > 0) {
        process.exitCode = 1;
      }
      return;
    }
    const reports = await backfillLocationRegional(prisma);
    for (const report of reports.filter(
      (r) => r.filled > 0 || r.hourCycleFilled > 0,
    )) {
      console.log(
        JSON.stringify({ event: 'locations.regional_backfilled', ...report }),
      );
    }
    console.log(
      JSON.stringify({
        event: 'locations.regional_backfill_done',
        tenants: reports.length,
        filled: reports.reduce((sum, r) => sum + r.filled, 0),
        hourCycleFilled: reports.reduce((sum, r) => sum + r.hourCycleFilled, 0),
      }),
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(
    JSON.stringify({
      event: 'locations.regional_backfill_failed',
      error: error instanceof Error ? error.message : 'unknown',
    }),
  );
  process.exit(1);
});
