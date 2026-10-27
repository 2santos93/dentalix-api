/**
 * GLOBAL-G1 fase 1 (spec §2.3 y runbook §2.3 bis): rellena las sedes que una
 * réplica anterior a G1 dejó con moneda, zona o locale NULL, clínica por
 * clínica. Es el mismo código que el job `locations.regional-backfill`
 * (`dx_g1_backfill_location_regional` bajo `runWithTenant`). Corre con el rol
 * de la app (DATABASE_URL, RLS FORCE), nunca como superusuario. Idempotente:
 * una segunda pasada no cambia nada.
 *
 *   npm run g1:backfill-locations
 *
 * Imprime una línea JSON por clínica con sedes rellenadas y un total, solo
 * con números y ids de clínica. Desaparece en fase 2 (spec §11).
 */
import { config as loadDotenv } from 'dotenv';
import { backfillLocationRegional } from '../../src/modules/locations/infrastructure/jobs/location-regional-backfill.job';
import { PrismaService } from '../../src/shared/prisma/prisma.service';
import { TenantContextService } from '../../src/shared/tenancy/tenant-context.service';

async function main(): Promise<void> {
  loadDotenv({ quiet: true });
  const prisma = new PrismaService(new TenantContextService());
  try {
    const reports = await backfillLocationRegional(prisma);
    for (const report of reports.filter((r) => r.filled > 0)) {
      console.log(
        JSON.stringify({ event: 'locations.regional_backfilled', ...report }),
      );
    }
    console.log(
      JSON.stringify({
        event: 'locations.regional_backfill_done',
        tenants: reports.length,
        filled: reports.reduce((sum, r) => sum + r.filled, 0),
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
