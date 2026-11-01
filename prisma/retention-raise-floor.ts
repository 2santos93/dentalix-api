/**
 * Sube el mínimo de conservación de la historia clínica (DX-330) a las
 * clínicas que quedaron por debajo de PLATFORM_MIN_CLINICAL_RETENTION_YEARS
 * (vacío = 15), con un evento de plataforma por clínica. Corre con la
 * conexión del OWNER (DIRECT_URL).
 *
 *   npm run retention:raise-floor -- --dry-run                     # solo lista
 *   npm run retention:raise-floor -- --actor-email=<correo>        # aplica
 *
 * El actor debe ser administrador de plataforma. Solo imprime ids de clínica y
 * números: ningún dato de pacientes.
 */
import { Prisma, PrismaClient } from '@prisma/client';
import { loadClinicalRetentionConfig } from '../src/modules/patients/domain/retention/clinical-retention-config';
import { raiseClinicalRetentionFloor } from '../src/modules/patients/infrastructure/clinical-retention-raise-floor';

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const actorEmail =
    process.argv
      .find((arg) => arg.startsWith('--actor-email='))
      ?.slice('--actor-email='.length)
      .trim() || null;
  const { platformMinYears } = loadClinicalRetentionConfig(
    (key) => process.env[key],
  );
  const url = process.env.DIRECT_URL;
  if (!url) throw new Error('Falta DIRECT_URL (conexión del owner).');
  const prisma = new PrismaClient<Prisma.PrismaClientOptions>({
    datasources: { db: { url } },
  });
  try {
    const { tenantIds } = await raiseClinicalRetentionFloor(prisma, {
      minYears: platformMinYears,
      actorEmail,
      dryRun,
    });
    console.log(
      JSON.stringify({
        event: dryRun
          ? 'retention.raise_floor_dry_run'
          : 'retention.raise_floor',
        minYears: platformMinYears,
        tenantIds,
      }),
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error(
    JSON.stringify({
      event: 'retention.raise_floor_failed',
      error: err instanceof Error ? err.message : 'unknown',
    }),
  );
  process.exit(1);
});
