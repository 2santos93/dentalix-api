/*
 * DX-224 · benchmark de «¿Quién llama?» con RLS real. NO forma parte de la
 * suite: se corre a mano (docs/perf/DX-224.md) contra una base DESECHABLE
 * sembrada con dx224-seed.sql (60.000 pacientes). Mide, por `dentalix_app`
 * (sin BYPASSRLS), el caso de uso entero y la consulta de coincidencias, y
 * muestra el EXPLAIN (ANALYZE) de esta última para comprobar que usa
 * patients_tenant_phone_e164_idx. Criterio: mediana y p95 < 300 ms.
 */
import { loadavg } from 'node:os';
import { NestFactory } from '@nestjs/core';
import { ClinicRole } from '@prisma/client';
import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/shared/prisma/prisma.service';
import { TenantContextService } from '../../src/shared/tenancy/tenant-context.service';
import { CallerLookupUseCase } from '../../src/modules/caller-lookup/application/caller-lookup.use-case';

const TENANT = '00000000-0000-4000-a000-0000000000e4';
const RUNS = Number(process.env.BENCH_RUNS ?? 30);
const LIMIT_MS = 300;

function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
}

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: false,
  });
  const context = app.get(TenantContextService);
  const prisma = app.get(PrismaService);
  const useCase = app.get(CallerLookupUseCase);

  // El plan de la consulta de coincidencias, bajo RLS.
  const plan = await context.run(TENANT, () =>
    prisma.runWithTenant(async (tx) => {
      const rows = await tx.$queryRawUnsafe<{ 'QUERY PLAN': string }[]>(
        `EXPLAIN (ANALYZE, BUFFERS)
         SELECT p."id" FROM "patients" p
          WHERE p."tenantId" = '${TENANT}'::uuid
            AND p."phoneE164" = ANY(ARRAY['+584125550000']::text[])
            AND p."deletedAt" IS NULL`,
      );
      return rows.map((r) => r['QUERY PLAN']);
    }),
  );
  console.log(plan.join('\n'));
  const usesIndex = plan.some((l) =>
    l.includes('patients_tenant_phone_e164_idx'),
  );

  const times: number[] = [];
  let found = 0;
  for (let i = 0; i <= RUNS; i++) {
    const t0 = process.hrtime.bigint();
    const res = await context.run(TENANT, () =>
      useCase.execute('0412 5550000', ClinicRole.ADMIN),
    );
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    found = res.matches.length;
    if (i > 0) times.push(ms); // la primera es el calentamiento
  }
  times.sort((a, b) => a - b);
  const median = percentile(times, 0.5);
  const p95 = percentile(times, 0.95);
  console.log(
    JSON.stringify({
      runs: RUNS,
      matches: found,
      medianMs: +median.toFixed(1),
      p95Ms: +p95.toFixed(1),
      usesIndex,
      load: loadavg()
        .map((l) => l.toFixed(2))
        .join(' / '),
    }),
  );
  await app.close();
  if (!usesIndex || p95 >= LIMIT_MS || found !== 3) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.name : 'error');
  process.exit(1);
});
