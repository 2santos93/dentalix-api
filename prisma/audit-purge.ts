/**
 * Purga de audit_events (DX-102): DETACH + DROP de las particiones mensuales
 * COMPLETAS más antiguas que AUDIT_RETENTION_MONTHS (default y mínimo 180
 * meses; la BD también rechaza menos). Corre con la conexión del OWNER
 * (DIRECT_URL): el rol de la app no puede ejecutar `audit_events_purge`.
 *
 *   npm run audit:purge -- --dry-run   # solo lista lo que caería
 *   npm run audit:purge                # purga
 *
 * Antes de purgar en producción, archiva las particiones listadas (pg_dump
 * cifrado a almacenamiento frío; ver informe DX-102). Solo imprime nombres de
 * partición y rangos: ningún dato de eventos.
 */
import { Prisma, PrismaClient } from '@prisma/client';
import { loadAuditPartitionConfig } from '../src/modules/audit/infrastructure/audit-retention-config';

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const { retentionMonths } = loadAuditPartitionConfig(
    (key) => process.env[key],
  );
  const url = process.env.DIRECT_URL;
  if (!url) throw new Error('Falta DIRECT_URL (conexión del owner).');
  const prisma = new PrismaClient<Prisma.PrismaClientOptions>({
    datasources: { db: { url } },
  });
  try {
    const rows = await prisma.$queryRaw<
      { partition_name: string; range_start: Date; range_end: Date }[]
    >`SELECT partition_name, range_start, range_end
      FROM audit_events_purge(${retentionMonths}::int, (now() AT TIME ZONE 'UTC')::timestamp, ${dryRun})`;
    console.log(
      JSON.stringify({
        event: dryRun ? 'audit.purge_dry_run' : 'audit.purge',
        retentionMonths,
        partitions: rows.map((r) => ({
          name: r.partition_name,
          from: r.range_start.toISOString(),
          to: r.range_end.toISOString(),
        })),
      }),
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error(
    JSON.stringify({
      event: 'audit.purge_failed',
      error: err instanceof Error ? err.message : 'unknown',
    }),
  );
  process.exit(1);
});
